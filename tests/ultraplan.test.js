#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'packs', 'claude', 'hooks', 'orchestra-ultraplan.js');
const STUB_SCRIPT = path.join(__dirname, 'fixtures', 'stub-claude-plan.js');
const cleanups = [];
const ownedPids = new Set();
let passes = 0;
let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    passes += 1;
    console.log('  PASS  ' + name);
  } else {
    failures += 1;
    process.exitCode = 1;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''));
  }
}

function section(name) {
  console.log('\n' + name);
}

function stubBinary() {
  if (process.platform !== 'win32') {
    fs.chmodSync(STUB_SCRIPT, 0o755);
    return STUB_SCRIPT;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-plan-stub-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(
    shim,
    '@echo off\r\nping -n 2 127.0.0.1 >nul\r\n"' + process.execPath + '" "' +
      STUB_SCRIPT + '" %*\r\nexit /b %ERRORLEVEL%\r\n',
    'utf8'
  );
  return shim;
}

const STUB = stubBinary();

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-plan-fixture-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = path.join(dir, 'plan.md');
  const brief = path.join(dir, 'brief.md');
  fs.writeFileSync(plan, '# Plan\n\n1. Implement the bounded change.\n');
  fs.writeFileSync(brief, '# Brief\n\nOnly the supplied files are in scope.\n');
  return { dir, plan, brief };
}

function invoke(fx, extraEnv, extraArgs, timeout) {
  return spawnSync(
    process.execPath,
    [RUNNER, '--plan', fx.plan, '--brief', fx.brief, '--round', '2'].concat(extraArgs || []),
    {
      cwd: fx.dir,
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
      timeout: timeout || 20000,
      env: Object.assign({}, process.env, {
        CLAUDE_BIN: STUB,
        ORCHESTRA_CLAUDE_PLAN_TIMEOUT_MS: '10000',
      }, extraEnv || {}),
    }
  );
}

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function waitGone(pid, timeout) {
  const end = Date.now() + (timeout || 15000);
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isAlive(pid);
}

function trackOwnedPid(pid) {
  if (pid > 0) ownedPids.add(pid);
  return pid;
}

function checkOwnedDescendant(name, pid, result) {
  if (process.platform === 'win32' || process.platform === 'linux') {
    const truthfulCoverage =
      /COVERAGE: BEST-EFFORT/.test(result.stdout) &&
      !/COVERAGE: AUTHORITATIVE/.test(result.stdout) &&
      (process.platform !== 'win32' ||
        (/WINDOWS JOB BOUNDARY: membership = AUTHORITATIVE/.test(result.stdout) &&
          /PRE-ASSIGNMENT WINDOW:/.test(result.stdout)));
    check(
      name + ' reaps its owned detached descendant with truthful coverage',
      pid > 0 && truthfulCoverage && waitGone(pid),
      'pid ' + pid + '\n' + result.stdout
    );
    return;
  }
  check(
    name + ' reports the unsupported detached case as best-effort',
    pid > 0 && /COVERAGE: BEST-EFFORT/.test(result.stdout),
    'pid ' + pid + '\n' + result.stdout
  );
}

section('1. Default planning contract and supervised success');
{
  const fx = fixture();
  const record = path.join(fx.dir, 'record.json');
  const pidFile = path.join(fx.dir, 'orphan.pid');
  const result = invoke(fx, { STUB_RECORD: record, STUB_ORPHAN_PID_FILE: pidFile });
  const got = JSON.parse(fs.readFileSync(record, 'utf8'));
  const pid = trackOwnedPid(Number(fs.readFileSync(pidFile, 'utf8')));
  const modelAt = got.args.indexOf('--model');
  const effortAt = got.args.indexOf('--effort');
  const toolsAt = got.args.indexOf('--tools');
  check('planning succeeds with one APPROVE verdict',
    result.status === 0 && /^VERDICT: APPROVE$/m.test(result.stdout), result.stdout + result.stderr);
  check('defaults remain fable with max effort and no tools',
    got.args[modelAt + 1] === 'fable' && got.args[effortAt + 1] === 'max' &&
      got.args[toolsAt + 1] === '', JSON.stringify(got.args));
  check('fresh external planner role and closed-world prompt are preserved',
    got.role === 'planner-claude-external' && /You have no repository access/.test(got.prompt) &&
      /ROUND: 2/.test(got.prompt), JSON.stringify(got));
  check('success reports the process census above the verdict',
    /PROCESS CENSUS:/.test(result.stdout) &&
      result.stdout.indexOf('PROCESS CENSUS:') < result.stdout.indexOf('VERDICT: APPROVE'), result.stdout);
  checkOwnedDescendant('successful planning', pid, result);
}

section('2. Deadline is runner-owned and reaps descendants');
{
  const fx = fixture();
  const pidFile = path.join(fx.dir, 'orphan.pid');
  const result = invoke(fx, {
    STUB_MODE: 'timeout',
    STUB_ORPHAN_PID_FILE: pidFile,
    ORCHESTRA_CLAUDE_PLAN_TIMEOUT_MS: '3000',
  }, [], 20000);
  const pid = trackOwnedPid(Number(fs.readFileSync(pidFile, 'utf8')));
  check('deadline fails closed with an unavailable verdict',
    /VERDICT: ULTRAPLAN_UNAVAILABLE/.test(result.stdout) &&
      /timed out after 3000ms/.test(result.stdout), result.stdout + result.stderr);
  check('deadline report includes a process census',
    /PROCESS CENSUS:/.test(result.stdout), result.stdout);
  checkOwnedDescendant('timed-out planning', pid, result);
}

section('3. Invalid reports and disabled supervision stay explicit');
{
  const fx = fixture();
  const empty = invoke(fx, { STUB_MODE: 'empty' });
  check('missing verdict fails closed',
    /VERDICT: ULTRAPLAN_UNAVAILABLE/.test(empty.stdout) &&
      /no single parseable/.test(empty.stdout), empty.stdout);
  const duplicate = invoke(fx, { STUB_MODE: 'duplicate' });
  check('duplicate verdict fails closed',
    /VERDICT: ULTRAPLAN_UNAVAILABLE/.test(duplicate.stdout) &&
      /no single parseable/.test(duplicate.stdout), duplicate.stdout);
  const off = invoke(fx, { ORCHESTRA_JOBRUN: 'off' });
  check('the shared supervision escape hatch is loud',
    /supervision is OFF for this run \(ORCHESTRA_JOBRUN=off\)/.test(off.stdout), off.stdout);
}


section('4. Large output defaults and percent-bearing shim tokens');
for (const supervise of [true, false]) {
  const fx = fixture();
  const result = invoke(
    fx,
    Object.assign({ STUB_MODE: 'large-valid' }, supervise ? {} : { ORCHESTRA_JOBRUN: 'off' }),
    [],
    20000
  );
  check(
    'planning accepts 2 MB output with supervision ' + (supervise ? 'on' : 'off'),
    result.status === 0 && /^VERDICT: APPROVE$/m.test(result.stdout) && result.stdout.length > 2000000,
    (result.stderr || '') + '\n' + String(result.stdout || '').slice(0, 1000)
  );
}
if (process.platform === 'win32') {
  const fx = fixture();
  const marker = path.join(fx.dir, 'percent-injection-marker.txt');
  const record = path.join(fx.dir, 'percent-injection-record.json');
  const attack = 'x" & echo PWNED>"' + marker + '" & rem "';
  const result = invoke(
    fx,
    { ORCHESTRA_PERCENT_ATTACK: attack, STUB_RECORD: record },
    ['--model', '%ORCHESTRA_PERCENT_ATTACK%'],
    20000
  );
  check(
    'planning rejects percent-bearing shim tokens before the engine launches',
    /VERDICT: ULTRAPLAN_UNAVAILABLE/.test(result.stdout) &&
      /percent characters are not supported in Windows command-shim tokens/.test(result.stdout) &&
      !fs.existsSync(marker) && !fs.existsSync(record),
    result.stdout + result.stderr
  );
}

for (const pid of ownedPids) {
  if (!isAlive(pid)) continue;
  try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  waitGone(pid, 5000);
}
for (const cleanup of cleanups.reverse()) {
  try { cleanup(); } catch (_) {}
}
console.log('\n' + (failures ? 'FAILED' : 'OK') + ' - ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);

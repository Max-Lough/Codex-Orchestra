#!/usr/bin/env node
/**
 * Process-supervision tests for packs/claude/hooks/orchestra-jobrun.js.
 *
 *   node tests/jobrun.test.js
 *
 * No dependencies and no framework, same as the other suites. The subject is
 * the containment and attribution boundary the runner now reports. The cases
 * are mostly not about parsing — they launch a real process that deliberately
 * never exits, let the runner return, and then ask the operating system whether
 * that exact owned process is still there.
 *
 * The mutation proof is built in rather than bolted on: every "the orphan is
 * gone" case has a `--preserve-survivors` twin over the same fixture, and the
 * twin asserts the orphan is STILL ALIVE. If the kill were removed, the first
 * case fails; if the kill were unconditional, the twin fails. Neither can pass
 * for the wrong reason — a process that would have died on its own would fail
 * the twin.
 *
 * The Windows kill group (a Job object held by a PowerShell process) is driven
 * through a line protocol, and tests/fixtures/stub-jobholder.js speaks that
 * protocol. That is deliberate: the driver is the half with the ordering and
 * timeout bugs, and it is exercised on every platform rather than only where
 * PowerShell exists.
 *
 * Exit-code discipline is inherited from the review and exec suites verbatim:
 * a failure sets the exit code the moment it exists, an `exit` handler
 * enforces it, and a suite that recorded no checks fails on that basis alone.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MASTER = path.resolve(__dirname, '..');
const JOBRUN =
  process.env.ORCHESTRA_TEST_JOBRUN ||
  path.join(MASTER, 'packs', 'claude', 'hooks', 'orchestra-jobrun.js');
const STUB_HOLDER = path.join(__dirname, 'fixtures', 'stub-jobholder.js');

const jobrun = require(JOBRUN);
const { censusBlock, _internals } = jobrun;

let failures = 0;
let passes = 0;
const cleanups = [];
// Every PID this suite creates on purpose — the orphans AND the launchers that
// started them. Whatever the cases prove, none of them may leave a process
// behind: a suite about orphans that orphans is a contradiction, and on a
// shared CI runner it is a leak. The launchers matter as much as the orphans
// here, because a case that FAILS is precisely one where the kill group did
// not do its job, so the suite cannot rely on the code under test to clean up
// after it.
const spawnedPids = new Set();

// Register whatever a receipt says this run launched, so the cleanup above
// covers the target as well as its children.
function trackReceipt(rec) {
  if (rec && rec.targetPid > 0) spawnedPids.add(rec.targetPid);
  for (const e of (rec && rec.census && rec.census.survivors) || []) {
    if (e.pid > 0) spawnedPids.add(e.pid);
  }
  return rec;
}

function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log('  PASS  ' + name);
  } else {
    failures++;
    process.exitCode = 1;
    console.log(
      '  FAIL  ' + name + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : '')
    );
  }
}

function section(title) {
  console.log('\n' + title);
}

function finish() {
  for (const pid of spawnedPids) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {
        /* already gone */
      }
    }
  }
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch (_) {
      /* cleanup is best effort */
    }
  }
  console.log(
    '\n' + (failures ? 'FAILED' : 'PASSED') + ' — ' + passes + ' passed, ' + failures + ' failed'
  );
}

process.on('exit', () => {
  if (failures > 0) process.exitCode = 1;
  else if (passes === 0) {
    console.log('\nFAILED — no checks ran at all (the suite did not execute)');
    process.exitCode = 1;
  }
});
process.on('unhandledRejection', (e) => {
  check('no unhandled rejection in the suite', false, (e && e.stack) || e);
  finish();
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  check('no uncaught exception in the suite', false, (e && e.stack) || e);
  finish();
  process.exit(1);
});

// ------------------------------------------------------------------ helpers

function isAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function sleepSync(msec) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, msec);
}

// Process termination is asynchronous on both platforms, so "is it gone?" is a
// question with a deadline, not an instant. A case that wants the opposite
// answer uses stillAliveAfter() below, which waits the same span and so cannot
// pass merely by asking sooner.
function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    sleepSync(100);
  }
  return !isAlive(pid);
}

function stillAliveAfter(pid, msec) {
  sleepSync(msec || 1500);
  return isAlive(pid);
}

function tmpdir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The supervisor writes its receipt TWICE: once at launch (so a supervisor
// that is itself killed still leaves the engine PID behind for a sweep) and
// once when it is done. A case that reads it the moment the tree dies can
// catch the first write, which is a race in the test, not in the runner.
function waitReceipt(file, timeoutMs) {
  // FIX (Windows CI, 2026-09-18): 15s was not enough and the cancellation case
  // read the pre-receipt instead. The supervisor's path there is: notice the
  // parent is gone (a 5s poll on Windows, because the liveness test costs a
  // process launch), terminate, take a Win32_Process census (a PowerShell
  // spawn), then the reap grace. On a loaded runner that lands right at 15s.
  // The kill itself was never in doubt — the same case's "the orphan is gone"
  // passed — so this is the test's reading window, not the runner's speed.
  const deadline = Date.now() + (timeoutMs || 45000);
  for (;;) {
    const rec = readJson(file);
    if (rec && rec.endedAt) return rec;
    if (Date.now() >= deadline) return rec;
    sleepSync(200);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

// A command that launches a never-exiting child and returns immediately —
// `python -c "import time; time.sleep(10**6)"` in the field, node here so the
// suite keeps its zero dependencies. `unref()` is the whole point: without it
// the launcher would wait for the child, which is exactly what the Codex
// command runner does NOT do.
//
// FIX (Windows CI, 2026-09-17): `detached` has to differ by platform, and the
// reason is not cosmetic. libuv puts every NON-detached child of a node
// process into a job object carrying JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so
// node's children die with node. An attached child therefore could not model
// an orphan on Windows at all — it vanished the moment this launcher exited,
// and "the orphan is gone" passed vacuously for a process that had never been
// alive. (The --preserve-survivors twin is what caught it, by failing: the
// whole reason those twins exist.)
//
// A detached child on Windows skips libuv's job, and node does NOT pass
// CREATE_BREAKAWAY_FROM_JOB, so it stays inside the supervisor's job by
// inheritance — exactly the real shape. On POSIX the opposite holds: a plain
// child already outlives its parent, and `detached` would setsid it out of the
// supervisor's process group, which is the escapee case, not this one.
function hangLauncher(dir, opts) {
  const o = opts || {};
  const detach = o.detached === undefined ? process.platform === 'win32' : o.detached;
  const file = path.join(dir, 'launch-orphan.js');
  fs.writeFileSync(
    file,
    [
      "const { spawn } = require('child_process');",
      "const fs = require('fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {",
      "  stdio: 'ignore',",
      '  env: ' + (o.clearEnv ? '{}' : 'process.env') + ',',
      '  detached: ' + (detach ? 'true' : 'false') + ',',
      '});',
      'child.unref();',
      "fs.writeFileSync(process.env.ORPHAN_PID_FILE, String(child.pid), 'utf8');",
      o.neverReturn ? 'setInterval(function () {}, 1000);' : '// and return, leaving it running',
      '',
    ].join('\n'),
    'utf8'
  );
  return file;
}

function runJobrun(args, env, timeoutMs) {
  return spawnSync(process.execPath, [JOBRUN].concat(args), {
    encoding: 'utf8',
    timeout: timeoutMs || 90000,
    env: Object.assign({}, process.env, env || {}),
  });
}

// ------------------------------------------------- 1. the CLI, normal exit

section('1. a command that returns while its child is still running');

{
  const dir = tmpdir('orchestra-jobrun-normal-');
  const pidFile = path.join(dir, 'orphan.pid');
  const receipt = path.join(dir, 'receipt.json');
  const launcher = hangLauncher(dir);

  const r = runJobrun(
    ['--receipt', receipt, '--token', 'TOK1', '--', process.execPath, launcher],
    { ORPHAN_PID_FILE: pidFile }
  );
  const orphan = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  spawnedPids.add(orphan);
  const rec = trackReceipt(readJson(receipt));

  check(
    'the launcher itself exited 0 and the supervisor passed that status through',
    r.status === 0,
    'status=' + r.status + ' stderr=' + (r.stderr || '').slice(0, 400)
  );
  check(
    'the orphan is gone once the supervisor returned',
    waitGone(orphan),
    'pid ' + orphan + ' is still alive; receipt=' + JSON.stringify(rec && rec.census)
  );
  check(
    'the receipt names it as a survivor that was killed',
    !!rec &&
      rec.census.survivors.some((s) => s.pid === orphan) &&
      rec.census.killed.indexOf(orphan) !== -1 &&
      rec.census.stubborn.length === 0,
    JSON.stringify(rec && rec.census, null, 2)
  );
  check(
    'the census entry carries an image name and a creation time, not just a number',
    !!rec &&
      rec.census.survivors.some((s) => s.pid === orphan && s.image && s.image !== '(unknown)' && s.started),
    JSON.stringify(rec && rec.census.survivors)
  );
  check(
    'the receipt is stamped with the run token it was given',
    !!rec && rec.token === 'TOK1',
    JSON.stringify(rec && rec.token)
  );
  check(
    'the receipt keeps whole-run coverage best-effort and separates assigned Job authority',
    !!rec && rec.census.coverage === 'best-effort' &&
      (process.platform === 'win32'
        ? rec.mechanism === 'windows-job-object' &&
          rec.jobAssignment && rec.jobAssignment.assigned === true &&
          rec.jobAssignment.membership === 'authoritative' &&
          rec.jobAssignment.enforcement === 'authoritative'
        : rec.mechanism === 'posix-process-group' &&
          rec.jobAssignment && rec.jobAssignment.assigned === false),
    JSON.stringify(rec && {
      mechanism: rec.mechanism,
      coverage: rec.census && rec.census.coverage,
      jobAssignment: rec.jobAssignment,
      note: rec.mechanismNote,
    })
  );
}

// A supervisor sits between the runner and the engine, so it must be
// TRANSPARENT about the engine's fate: the runners' exit forensics (who killed
// the engine, and whether it was this runner's own timer) read the status and
// the error code, and a supervisor that rewrote either would make every one of
// those reports a guess.

{
  const dir = tmpdir('orchestra-jobrun-exit-');
  const receipt = path.join(dir, 'receipt.json');
  const r = runJobrun(
    ['--receipt', receipt, '--', process.execPath, '-e', 'process.exit(3)'],
    {}
  );
  const rec = trackReceipt(readJson(receipt));
  check(
    "a non-zero exit is the command's own, passed through unchanged",
    r.status === 3 && !!rec && rec.exit.code === 3 && !rec.timedOut,
    'status=' + r.status + ' receipt=' + JSON.stringify(rec && rec.exit)
  );
}

{
  const dir = tmpdir('orchestra-jobrun-enoent-');
  const receipt = path.join(dir, 'receipt.json');
  const t0 = Date.now();
  const r = runJobrun(
    ['--receipt', receipt, '--', path.join(dir, 'no-such-engine-here')],
    {}
  );
  const rec = trackReceipt(readJson(receipt));
  check(
    'a command that cannot be launched fails fast and says ENOENT, rather than waiting on a kill group that holds nothing',
    Date.now() - t0 < 20000 &&
      r.status === jobrun.EXIT_SPAWN_FAILED &&
      !!rec &&
      rec.spawnError &&
      rec.spawnError.code === 'ENOENT',
    'elapsed=' + (Date.now() - t0) + 'ms status=' + r.status + ' receipt=' + JSON.stringify(rec && rec.spawnError)
  );
}

// ---------------------------------------- 2. THE MUTATION PROOF: kill off

section('2. mutation proof — with the kill disabled, the same orphan survives');

{
  const dir = tmpdir('orchestra-jobrun-preserve-');
  const pidFile = path.join(dir, 'orphan.pid');
  const receipt = path.join(dir, 'receipt.json');
  const launcher = hangLauncher(dir);

  runJobrun(
    ['--receipt', receipt, '--preserve-survivors', '--', process.execPath, launcher],
    { ORPHAN_PID_FILE: pidFile }
  );
  const orphan = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  spawnedPids.add(orphan);
  const rec = trackReceipt(readJson(receipt));

  // This is what makes case 1 a proof rather than a coincidence: over the same
  // fixture, with reaping off, the runner censuses the process and does NOT
  // kill it. A supervisor that killed regardless fails HERE, and so does one
  // whose case-1 pass came from a process that would have exited anyway —
  // because this asserts the survivor was found alive at census time.
  //
  // The assertion is about what the RUNNER did, deliberately. Whether the
  // process then outlives the supervisor is the platform's call, not ours:
  // Windows reaps some trees through job membership the runner never asked
  // for, so requiring the process to still be alive would be testing Windows,
  // not this code. The liveness half is therefore checked only where it is
  // the runner's to guarantee.
  check(
    'the receipt censuses it as a survivor and records that nothing was killed',
    !!rec &&
      rec.killSurvivors === false &&
      rec.census.survivors.some((s) => s.pid === orphan) &&
      rec.census.killed.length === 0,
    JSON.stringify(rec && rec.census, null, 2)
  );
  if (process.platform !== 'win32') {
    check(
      'with --preserve-survivors the orphan is still running after the supervisor returned',
      stillAliveAfter(orphan, 2000),
      'pid ' + orphan + ' died on its own — case 1 would then pass without any kill'
    );
  }
  check(
    'the census block says so in words a Director reads, not only in JSON',
    /reaping = OFF \(--preserve-survivors\)/.test(censusBlock(rec, { token: 'x' })) &&
      /LEFT RUNNING/.test(censusBlock(rec, { token: 'x' })),
    censusBlock(rec, { token: 'x' })
  );

  try {
    process.kill(orphan, 'SIGKILL');
  } catch (_) {
    /* the suite's own cleanup would catch it anyway */
  }
}

// ----------------------- 2b. Linux token attribution for a detached setsid escape

section('2b. Linux token attribution catches a detached setsid escape');

if (process.platform === 'linux') {
  {
    const dir = tmpdir('orchestra-jobrun-token-');
    const pidFile = path.join(dir, 'orphan.pid');
    const receipt = path.join(dir, 'receipt.json');
    const launcher = hangLauncher(dir, { detached: true });
    let orphan = 0;
    try {
      const r = runJobrun(
        ['--receipt', receipt, '--token', 'TOKEN-SETSID', '--', process.execPath, launcher],
        { ORPHAN_PID_FILE: pidFile }
      );
      orphan = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      spawnedPids.add(orphan);
      const rec = trackReceipt(readJson(receipt));
      check(
        'a real Linux detached setsid descendant is found and killed',
        r.status === 0 && orphan > 0 && waitGone(orphan),
        'status=' + r.status + ' pid=' + orphan + ' receipt=' + JSON.stringify(rec && rec.census)
      );
      check(
        'the detached survivor is attributed by the exact inherited token',
        !!rec &&
          rec.census.coverage === 'best-effort' &&
          rec.census.source === '/proc+token' &&
          rec.census.survivors.some((entry) => entry.pid === orphan && /(^|\+)token(\+|$)/.test(entry.via)) &&
          rec.census.killed.includes(orphan),
        JSON.stringify(rec && rec.census, null, 2)
      );
      check(
        'the POSIX receipt remains prominently best-effort after a successful token match',
        /COVERAGE: BEST-EFFORT/.test(censusBlock(rec, { token: 'TOKEN-SETSID' })) &&
          /clearing the inherited token/.test(censusBlock(rec, { token: 'TOKEN-SETSID' })),
        censusBlock(rec, { token: 'TOKEN-SETSID' })
      );
    } finally {
      if (orphan > 0 && isAlive(orphan)) {
        try { process.kill(orphan, 'SIGKILL'); } catch (_) {}
      }
    }
  }

  {
    const dir = tmpdir('orchestra-jobrun-envclear-');
    const pidFile = path.join(dir, 'orphan.pid');
    const receipt = path.join(dir, 'receipt.json');
    const launcher = hangLauncher(dir, { detached: true, clearEnv: true });
    let orphan = 0;
    try {
      runJobrun(
        ['--receipt', receipt, '--token', 'TOKEN-ENVCLEAR', '--', process.execPath, launcher],
        { ORPHAN_PID_FILE: pidFile }
      );
      orphan = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      spawnedPids.add(orphan);
      const rec = trackReceipt(readJson(receipt));
      check(
        'an env-cleared detached control demonstrates the disclosed residual without broad attribution',
        orphan > 0 &&
          stillAliveAfter(orphan, 1000) &&
          !!rec &&
          rec.census.coverage === 'best-effort' &&
          !rec.census.survivors.some((entry) => entry.pid === orphan),
        'pid=' + orphan + ' receipt=' + JSON.stringify(rec && rec.census, null, 2)
      );
    } finally {
      // This exact PID belongs to this fixture. Always remove it even when an
      // assertion above fails; never compensate with a name-based process kill.
      if (orphan > 0 && isAlive(orphan)) {
        try { process.kill(orphan, 'SIGKILL'); } catch (_) {}
      }
      if (orphan > 0) waitGone(orphan);
    }
  }
}

// ------------------------------------------------------- 3. the timeout path

section('3. the deadline path kills the whole tree, not just the root');

{
  const dir = tmpdir('orchestra-jobrun-timeout-');
  const pidFile = path.join(dir, 'orphan.pid');
  const receipt = path.join(dir, 'receipt.json');
  // This launcher never returns either, so the deadline — not the exit — is
  // what ends the run.
  const launcher = hangLauncher(dir, { neverReturn: true });

  const t0 = Date.now();
  const r = runJobrun(
    ['--receipt', receipt, '--deadline-ms', '2500', '--', process.execPath, launcher],
    { ORPHAN_PID_FILE: pidFile }
  );
  const elapsed = Date.now() - t0;
  const orphan = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  spawnedPids.add(orphan);
  const rec = trackReceipt(readJson(receipt));

  check(
    'the deadline fired rather than the run hanging',
    elapsed < 60000 && !!rec && rec.timedOut === true,
    'elapsed=' + elapsed + 'ms timedOut=' + (rec && rec.timedOut)
  );
  check(
    "the supervisor exits 124 — GNU timeout's convention, not a fake success",
    r.status === jobrun.EXIT_TIMEOUT,
    'status=' + r.status
  );
  check(
    'the orphan is gone after a timeout kill, not only after a clean exit',
    waitGone(orphan),
    'pid ' + orphan + ' survived the deadline kill'
  );
  check(
    'the receipt attributes the termination to the deadline',
    !!rec && rec.notes.some((n) => /deadline fired/.test(n)),
    JSON.stringify(rec && rec.notes)
  );
}

// ------------------------------- 4. cancellation: the launcher is killed

section('4. a TaskStop of the launcher takes the tree with it');

{
  const dir = tmpdir('orchestra-jobrun-cancel-');
  const pidFile = path.join(dir, 'orphan.pid');
  const receipt = path.join(dir, 'receipt.json');
  const launcher = hangLauncher(dir, { neverReturn: true });

  // A launcher that spawns the supervisor and is then killed outright, with
  // no chance to clean up — which is what a TaskStop, a closed terminal, or a
  // `kill -9` on the agent process all look like from here.
  //
  // FIX (2026-09-24): on Windows the launcher starts the supervisor DETACHED.
  // libuv puts a node process's non-detached children in a KILL_ON_JOB_CLOSE
  // job, so killing a node launcher takes its supervisor down in the same
  // instant, and the supervisor's own children go with it: the tree dies, but
  // nothing is left to write a receipt, so the receipt check below could never
  // pass (a scratch replay: supervisor gone 1.5s after the kill, `endedAt`
  // empty 45s later). That cascade is the product path's behaviour, and it
  // reaps the tree. The parent watch exists for a supervisor that OUTLIVES its
  // launcher, and only a detached supervisor does, so that is what this case
  // now drives on Windows. On POSIX nothing kills a child with its parent, so
  // the plain launch already exercises the watch there.
  const launchSupervisor =
    process.platform === 'win32'
      ? "require('child_process').spawn(process.execPath, process.argv.slice(1), { stdio: 'ignore', detached: true }); setInterval(function () {}, 1000)"
      : "require('child_process').spawnSync(process.execPath, process.argv.slice(1), { stdio: 'ignore' })";
  const driver = path.join(dir, 'driver.js');
  fs.writeFileSync(
    driver,
    [
      "const { spawn, spawnSync } = require('child_process');",
      'const launcherPid = spawn(process.execPath, [',
      '  "-e",',
      '  ' + JSON.stringify(launchSupervisor) + ',',
      '  ' + JSON.stringify(JOBRUN) + ',',
      '  "--receipt", ' + JSON.stringify(receipt) + ',',
      '  "--", process.execPath, ' + JSON.stringify(launcher),
      "], { stdio: 'ignore' }).pid;",
      'setTimeout(function () {',
      '  process.kill(launcherPid, "SIGKILL");',
      '  process.stdout.write(String(launcherPid));',
      '  process.exit(0);',
      '}, 3000);',
      '',
    ].join('\n'),
    'utf8'
  );
  const r = spawnSync(process.execPath, [driver], {
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, { ORPHAN_PID_FILE: pidFile }),
  });

  let orphan = 0;
  for (let i = 0; i < 50 && !orphan; i++) {
    orphan = parseInt((fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()) || '0', 10) || 0;
    if (!orphan) sleepSync(100);
  }
  spawnedPids.add(orphan);

  check(
    'the cancellation fixture really produced a running orphan to reap',
    orphan > 0,
    'no orphan PID was ever written; driver stderr=' + (r.stderr || '').slice(0, 400)
  );
  check(
    'the orphan is gone after the launcher was killed without warning',
    orphan > 0 && waitGone(orphan, 20000),
    'pid ' + orphan + ' outlived a killed launcher'
  );
  const rec = trackReceipt(waitReceipt(receipt));
  check(
    'the cancellation watch was armed, on a parent pid it could actually resolve',
    !!rec && rec.parentPid > 1,
    JSON.stringify(rec && { parentPid: rec.parentPid, parentPidSource: rec.parentPidSource })
  );
  check(
    'the receipt records the cancellation as a vanished parent, not a clean exit',
    !!rec && rec.parentVanished === true && rec.cancelled === true,
    JSON.stringify(
      rec && {
        cancelled: rec.cancelled,
        parentVanished: rec.parentVanished,
        // Which pid was watched and where the number came from: an unarmed
        // watch and a watch that never fired look identical without this.
        parentPid: rec.parentPid,
        parentPidSource: rec.parentPidSource,
        endedAt: rec.endedAt,
        notes: rec.notes,
      }
    )
  );
}

// ------------------------------------------ 5. the Windows holder protocol

section('5. the Windows job-holder protocol (driven on every platform)');

{
  const { JobHolder } = _internals;
  const run = async () => {
    // 5a. the happy path, end to end.
    const holder = new JobHolder({ killOnClose: true, timeoutMs: 8000 });
    const logFile = path.join(tmpdir('orchestra-holder-log-'), 'commands.log');
    process.env.ORCHESTRA_JOBRUN_HOLDER = STUB_HOLDER;
    process.env.STUB_HOLDER_LOG = logFile;
    process.env.STUB_HOLDER_MEMBERS = '4242|Godot_v4.6.3-stable_win64_console.exe|2026-09-15T22:14:03Z,4243|python.exe|';
    check('the holder starts', holder.start(), 'start() refused');
    await holder.ready;
    check(
      "the driver keeps the job's real LimitFlags off the READY line",
      holder.limitFlags === '0x2000',
      JSON.stringify(holder.limitFlags)
    );
    const assignErr = await holder.assign(1234);
    check('an accepted assignment reports no error', assignErr === '', assignErr);
    const members = await holder.members();
    check(
      'the job census is parsed into pid / image / creation time',
      Array.isArray(members) &&
        members.length === 2 &&
        members[0].pid === 4242 &&
        /Godot/.test(members[0].image) &&
        members[0].started === '2026-09-15T22:14:03Z' &&
        members[1].pid === 4243,
      JSON.stringify(members)
    );
    const killErr = await holder.kill(4242);
    check('an accepted kill reports no error', killErr === '', killErr);
    const termErr = await holder.terminate();
    check('TerminateJobObject reports no error when it succeeds', termErr === '', termErr);
    holder.close();
    await new Promise((r) => setTimeout(r, 600));
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    check(
      'closing the holder sends BYE — the handle must be released, not leaked',
      /^BYE$/m.test(log),
      log
    );
    check(
      'the holder is told to keep KILL_ON_JOB_CLOSE when reaping is on',
      /KILL_ON_CLOSE=1/.test(log),
      log
    );

    // 5b. a job that could not be created at all. The supervisor must degrade
    //     to the census reaper, and say so — never claim a guarantee it lost.
    process.env.STUB_HOLDER_FATAL = 'CreateJobObject failed: 5';
    const dead = new JobHolder({ killOnClose: true, timeoutMs: 8000 });
    dead.start();
    const deadErr = await dead.assign(999);
    check(
      'a holder that fails to create the job surfaces the reason, not a silent success',
      deadErr && /CreateJobObject failed: 5/.test(deadErr),
      JSON.stringify(deadErr)
    );
    dead.close();
    delete process.env.STUB_HOLDER_FATAL;

    // 5c. a REFUSED assignment (the real "access denied" shape).
    process.env.STUB_HOLDER_ASSIGN_ERR = 'AssignProcessToJobObject failed: 5';
    const refused = new JobHolder({ killOnClose: true, timeoutMs: 8000 });
    refused.start();
    const refusedErr = await refused.assign(4321);
    check(
      'a refused assignment is reported with the Win32 reason',
      /AssignProcessToJobObject failed: 5/.test(refusedErr),
      JSON.stringify(refusedErr)
    );
    refused.close();
    delete process.env.STUB_HOLDER_ASSIGN_ERR;

    // 5d. a WEDGED holder. The supervisor sits between the Director and the
    //     report: it may return a worse answer, never no answer.
    process.env.STUB_HOLDER_SILENT_ON = 'CENSUS';
    const wedged = new JobHolder({ killOnClose: true, timeoutMs: 1200 });
    wedged.start();
    await wedged.assign(5555);
    const t0 = Date.now();
    const none = await wedged.members();
    check(
      'a holder that never answers times the driver out instead of hanging it',
      Date.now() - t0 < 10000 && (none === null || none.length === 0),
      'elapsed=' + (Date.now() - t0) + 'ms result=' + JSON.stringify(none)
    );
    wedged.close();
    delete process.env.STUB_HOLDER_SILENT_ON;
    delete process.env.ORCHESTRA_JOBRUN_HOLDER;
    delete process.env.STUB_HOLDER_MEMBERS;
    delete process.env.STUB_HOLDER_LOG;
  };
  // The protocol cases are the only async ones; run them to completion before
  // the synchronous sections below continue.
  run().then(() => runRest()).catch((e) => {
    check('the holder-protocol section completed', false, (e && e.stack) || e);
    finish();
    process.exit(1);
  });
}

function runRest() {
  // ------------------------------------------------- 6. census bookkeeping

  section('6. census bookkeeping');

  {
    const { descendantsOf, mergeCensus, elapsedToIso } = _internals;
    const table = [
      { pid: 100, ppid: 1, pgid: 100, image: 'codex', started: '2026-09-15T10:00:00Z' },
      { pid: 101, ppid: 100, pgid: 100, image: 'godot', started: '2026-09-15T10:00:05Z' },
      { pid: 102, ppid: 101, pgid: 100, image: 'godot-child', started: '2026-09-15T10:00:06Z' },
      { pid: 103, ppid: 1, pgid: 103, image: 'unrelated', started: '2026-09-15T10:00:07Z' },
      // A RECYCLED pid: it claims 100 as its parent but predates it by a day.
      { pid: 104, ppid: 100, pgid: 100, image: 'imposter', started: '2026-09-14T10:00:00Z' },
    ];
    const found = descendantsOf(table, 100, '2026-09-15T10:00:00Z').map((r) => r.pid).sort();
    check(
      'the descendant walk finds children and grandchildren, and only those',
      JSON.stringify(found) === JSON.stringify([101, 102]),
      JSON.stringify(found)
    );
    check(
      'a process that predates its claimed parent is a recycled pid, not a descendant',
      found.indexOf(104) === -1,
      JSON.stringify(found)
    );
    const merged = mergeCensus([
      [{ pid: 7, image: 'a', via: 'job' }],
      [{ pid: 7, image: 'a', via: 'descendant' }, { pid: 8, image: 'b', via: 'descendant' }],
    ]);
    check(
      'a survivor seen by both the job list and the parentage walk is reported once, from both',
      merged.length === 2 && merged[0].pid === 7 && merged[0].via === 'job+descendant',
      JSON.stringify(merged)
    );
    check(
      "ps elapsed times parse in every POSIX spelling, and junk yields '' rather than a wrong time",
      elapsedToIso('01:02', 0) !== '' &&
        elapsedToIso('1-02:03:04', 0) !== '' &&
        elapsedToIso('not-a-time', 0) === '',
      [elapsedToIso('01:02', 0), elapsedToIso('1-02:03:04', 0), elapsedToIso('not-a-time', 0)].join(' | ')
    );
  }

  // ----------------------------------------------- 7. the census block text

  section('7. what the Director actually reads');

  {
    const clean = censusBlock(
      {
        token: 'TOKEN',
        mechanism: 'windows-job-object',
        mechanismNote: '',
        killSurvivors: true,
        census: {
          coverage: 'best-effort',
          before: [],
          survivors: [],
          killed: [],
          stubborn: [],
        },
        jobAssignment: {
          assigned: true,
          membership: 'authoritative',
          enforcement: 'authoritative',
        },
        notes: [],
      },
      { token: 'TOKEN' }
    );
    check(
      'a clean Windows Job report keeps lineage best-effort and scopes Job authority to assignment onward',
      /COVERAGE: BEST-EFFORT/.test(clean) &&
        !/COVERAGE: AUTHORITATIVE/.test(clean) &&
        /WINDOWS JOB BOUNDARY: membership = AUTHORITATIVE; enforcement = AUTHORITATIVE/.test(clean) &&
        /PRE-ASSIGNMENT WINDOW:/.test(clean) &&
        /ATTRIBUTED SURVIVORS: none observed/.test(clean) &&
        /KILL_ON_JOB_CLOSE, no BREAKAWAY_OK/.test(clean),
      clean
    );
    check(
      'the census carries its own provenance and this run\'s token, like the tree audit',
      /Census measured in-process by this runner \(run token TOKEN\)/.test(clean),
      clean
    );

    const legacyClean = censusBlock(
      {
        token: 'OLD',
        mechanism: 'windows-job-object',
        mechanismNote: '',
        killSurvivors: true,
        census: {
          coverage: 'authoritative',
          before: [],
          survivors: [],
          killed: [],
          stubborn: [],
        },
        notes: [],
      },
      { token: 'OLD' }
    );
    check(
      'legacy authoritative receipts cannot revive whole-run authoritative wording',
      /COVERAGE: BEST-EFFORT/.test(legacyClean) &&
        !/COVERAGE: AUTHORITATIVE/.test(legacyClean) &&
        /WINDOWS JOB BOUNDARY: membership = AUTHORITATIVE/.test(legacyClean) &&
        /legacy receipt/.test(legacyClean) &&
        /PRE-ASSIGNMENT WINDOW:/.test(legacyClean),
      legacyClean
    );

    const stubborn = censusBlock(
      {
        token: 'T',
        mechanism: 'posix-process-group',
        killSurvivors: true,
        census: {
          coverage: 'best-effort',
          before: [],
          survivors: [{ pid: 9, image: 'godot.exe', started: '2026-09-15T22:14:03Z', via: 'job' }],
          killed: [],
          stubborn: [{ pid: 9 }],
        },
        notes: [],
      },
      { token: 'T' }
    );
    check(
      'a survivor that would not die is called out, with the benchmark consequence named',
      /STILL ALIVE after the kill sweep/.test(stubborn) && /machine is not quiet/.test(stubborn),
      stubborn
    );

    const off = censusBlock(null, { token: 'T', disabled: true, disabledWhy: 'ORCHESTRA_JOBRUN=off' });
    check(
      'an unsupervised run says so, and says what that means',
      /supervision is OFF/.test(off) && /may still be running/.test(off),
      off
    );

    const missing = censusBlock(null, { token: 'T' });
    check(
      'a missing receipt reads as unavailable, never as a clean machine',
      /PROCESS CENSUS: unavailable/.test(missing) && !/ATTRIBUTED SURVIVORS: none/.test(missing),
      missing
    );
  }


  finish();
}

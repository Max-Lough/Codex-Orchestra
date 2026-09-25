#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.resolve(__dirname, '..', 'packs', 'claude', 'hooks', 'orchestra-visual.js');
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${name}\n`);
  } catch (error) {
    process.stderr.write(`not ok - ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-visual-'));
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, 'order.md'), 'Build a low-poly ship in Blender.\n');
  const binDir = path.join(root, 'claude bin');
  fs.mkdirSync(binDir);
  const stub = path.join(binDir, 'stub-claude.js');
  fs.writeFileSync(stub, `
const fs = require('fs');
const cp = require('child_process');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.VISUAL_RECORD, JSON.stringify({
    args: process.argv.slice(2), prompt, role: process.env.ORCHESTRA_ROLE || '', cwd: process.cwd()
  }));
  const mode = process.env.VISUAL_MODE || 'success';
  if (mode === 'abnormal') process.exit(9);
  if (mode === 'empty') return;
  if (mode === 'timeout') {
    const code = 'setTimeout(() => require("fs").writeFileSync(process.env.VISUAL_LATE_FILE, "late"), 1500)';
    const child = cp.spawn(process.execPath, ['-e', code], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
    return setInterval(() => {}, 1000);
  }
  process.stdout.write('STATUS: DONE\\n\\nCHANGES\\n- art/ship.blend — scripted asset\\n');
});
`);
  let bin = stub;
  if (process.platform === 'win32') {
    bin = path.join(binDir, 'claude.cmd');
    fs.writeFileSync(bin, '@"' + process.execPath + '" "' + stub + '" %*\r\n');
  } else {
    fs.writeFileSync(stub, '#!/usr/bin/env node\n' + fs.readFileSync(stub, 'utf8'));
    fs.chmodSync(stub, 0o755);
  }
  return {
    root,
    bin,
    record: path.join(root, 'record.json'),
    lateFile: path.join(root, 'late-write.txt'),
  };
}

function invoke(item, extraArgs = [], extraEnv = {}) {
  return spawnSync(process.execPath, [RUNNER, '--work-order', 'order.md'].concat(extraArgs), {
    cwd: item.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_PROJECT_DIR: item.root,
      CLAUDE_BIN: item.bin,
      VISUAL_RECORD: item.record,
      VISUAL_LATE_FILE: item.lateFile,
      ...extraEnv,
    },
  });
}

test('default visual executor uses the stable Opus alias at high effort', () => {
  const item = fixture();
  const result = invoke(item);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(fs.readFileSync(item.record, 'utf8'));
  assert(seen.args.includes('opus'), JSON.stringify(seen.args));
  assert.strictEqual(seen.args[seen.args.indexOf('--effort') + 1], 'high');
  assert.strictEqual(seen.role, 'executor-claude-visual-external');
  assert.strictEqual(seen.args[seen.args.indexOf('--allowedTools') + 1], 'Bash,Read,Grep,Glob,Edit,Write');
  assert.strictEqual(seen.args[seen.args.indexOf('--disallowedTools') + 1], 'Agent,NotebookEdit,mcp__*');
  assert.match(seen.prompt, /Opus 5\.5/);
  assert.match(seen.prompt, /Blender\/Godot versions/);
  assert.match(result.stdout, /policy: Opus 5\.5, effort: high/);
});

test('xhigh is an explicit supported visual-executor effort', () => {
  const item = fixture();
  const result = invoke(item, ['--effort', 'xhigh']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(fs.readFileSync(item.record, 'utf8'));
  assert.strictEqual(seen.args[seen.args.indexOf('--effort') + 1], 'xhigh');
  assert.match(result.stdout, /effort: xhigh/);
});

test('unsupported visual effort fails before launching Claude', () => {
  const item = fixture();
  const result = invoke(item, ['--effort', 'medium']);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /STATUS: EXEC_UNAVAILABLE/);
  assert.match(result.stdout, /high or xhigh/);
  assert(!fs.existsSync(item.record));
});

test('timeout reaps descendants before reporting unavailable', () => {
  const item = fixture();
  const result = invoke(item, ['--timeout-ms', '500'], { VISUAL_MODE: 'timeout' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /STATUS: EXEC_UNAVAILABLE/);
  assert.match(result.stdout, /PROCESS CENSUS/);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
  assert(!fs.existsSync(item.lateFile), 'descendant wrote after timeout');
});

test('Windows shim paths with spaces preserve every restriction flag', () => {
  const item = fixture();
  const result = invoke(item);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(fs.readFileSync(item.record, 'utf8'));
  for (const flag of ['--effort', '--permission-mode', '--tools', '--allowedTools', '--disallowedTools']) {
    assert(seen.args.includes(flag), flag + ' missing from ' + JSON.stringify(seen.args));
  }
});

test('model shell metacharacters are rejected before launch', () => {
  const item = fixture();
  const pwned = path.join(item.root, 'pwned.txt');
  const model = 'opus&echo INJECTED>' + pwned + '&rem';
  const result = invoke(item, ['--model', model]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /unsupported characters/);
  assert(!fs.existsSync(pwned));
  assert(!fs.existsSync(item.record));
});

test('abnormal exit and empty stdout fail loud', () => {
  const abnormal = fixture();
  const abnormalResult = invoke(abnormal, [], { VISUAL_MODE: 'abnormal' });
  assert.strictEqual(abnormalResult.status, 1);
  assert.match(abnormalResult.stdout, /status=9/);
  const empty = fixture();
  const emptyResult = invoke(empty, [], { VISUAL_MODE: 'empty' });
  assert.strictEqual(emptyResult.status, 1);
  assert.match(emptyResult.stdout, /wrote no executor report/);
});

test('missing flag values fail before reading an accidental path', () => {
  const item = fixture();
  const result = spawnSync(process.execPath, [RUNNER, '--work-order', '--effort', 'xhigh'], {
    cwd: item.root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_PROJECT_DIR: item.root, CLAUDE_BIN: item.bin },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /--work-order requires a value/);
});

test('work orders outside the project root are rejected', () => {
  const item = fixture();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-visual-outside-')), 'order.md');
  fs.writeFileSync(outside, 'outside\n');
  const result = spawnSync(process.execPath, [RUNNER, '--work-order', outside], {
    cwd: item.root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_PROJECT_DIR: item.root, CLAUDE_BIN: item.bin },
  });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /inside the project root/);
});

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} visual-executor checks passed.\n`);

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
  const stub = path.join(root, 'stub-claude.js');
  fs.writeFileSync(stub, `
const fs = require('fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.VISUAL_RECORD, JSON.stringify({
    args: process.argv.slice(2), prompt, role: process.env.ORCHESTRA_ROLE || '', cwd: process.cwd()
  }));
  process.stdout.write('STATUS: DONE\\n\\nCHANGES\\n- art/ship.blend — scripted asset\\n');
});
`);
  let bin = stub;
  if (process.platform === 'win32') {
    bin = path.join(root, 'claude.cmd');
    fs.writeFileSync(bin, '@"' + process.execPath + '" "' + stub + '" %*\r\n');
  } else {
    fs.writeFileSync(stub, '#!/usr/bin/env node\n' + fs.readFileSync(stub, 'utf8'));
    fs.chmodSync(stub, 0o755);
  }
  return { root, bin, record: path.join(root, 'record.json') };
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

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} visual-executor checks passed.\n`);

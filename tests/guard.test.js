#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GUARD = path.resolve(__dirname, '..', 'hooks', 'orchestra-guard.js');
let passed = 0;
let skipped = 0;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestra-guard-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.codex', 'plans'), { recursive: true });
  return root;
}

function run(root, input, env = {}) {
  const result = spawnSync(process.execPath, [GUARD], {
    cwd: root,
    input: typeof input === 'string' ? input : JSON.stringify({ cwd: root, ...input }),
    encoding: 'utf8',
    env: { ...process.env, ORCHESTRA_ROLE: '', ORCHESTRA_PAUSE: '', ...env },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function denied(output, fragment) {
  assert(output && output.hookSpecificOutput, 'expected hook denial output');
  assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
  if (fragment) assert.match(output.hookSpecificOutput.permissionDecisionReason, fragment);
}

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

test('SessionStart injects Director context', () => {
  const root = fixture();
  const output = run(root, { hook_event_name: 'SessionStart' });
  assert.match(output.hookSpecificOutput.additionalContext, /primary task is the Director/);
});

test('primary Director cannot read repository files', () => {
  const root = fixture();
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }), /does not use Read/);
});

test('spawned agents bypass the Director guard', () => {
  const root = fixture();
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'child-1' }), null);
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'exec_command' }, { ORCHESTRA_ROLE: 'executor' }), null);
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'exec_command' }, { ORCHESTRA_ROLE: 'reviewer-codex-external' }), null);
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }, { ORCHESTRA_ROLE: 'executor-codex-external' }), null);
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'web_search' }, { ORCHESTRA_ROLE: 'planner-codex-external' }), null);
});

test('literal markdown plan patches are the only write carve-out', () => {
  const root = fixture();
  const add = '*** Begin Patch\n*** Add File: .codex/plans/work.md\n+# Work\n*** End Patch';
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: add }), null);
  const del = '*** Begin Patch\n*** Delete File: .codex/plans/work.md\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: del }), /Director/);
  const code = '*** Begin Patch\n*** Add File: .codex/plans/work.js\n+throw new Error()\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: code }), /Director/);
});

test('Director cannot create its own pause file', () => {
  const root = fixture();
  const patch = '*** Begin Patch\n*** Add File: .codex/orchestra.pause\n+paused\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: patch }), /user-controlled/);
});

test('an out-of-band pause stands the guard down', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.codex', 'orchestra.pause'), 'paused\n');
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'exec_command' }), null);
});

test('functions.exec accepts goal tools but rejects worker tools', () => {
  const root = fixture();
  assert.strictEqual(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec',
    tool_input: 'const goal = await tools.get_goal({}); text(goal);',
  }), null);
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec',
    tool_input: 'const result = await tools.exec_command({cmd:"git status"}); text(result);',
  }), /functions\.exec/);
});

test('functions.exec rejects constructor-based nested-tool indirection', () => {
  const root = fixture();
  const source = 'await tools.get_goal({}); await [].filter.constructor("return tools.exec_command({cmd: `whoami`})")();';
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec', tool_input: source,
  }), /functions\.exec/);
  const computed = 'await tools.get_goal({}); await []["filter"]["constructor"]("return tools.exec_command({cmd: `whoami`})")();';
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec', tool_input: computed,
  }), /functions\.exec/);
  const composed = 'await tools.get_goal({}); await []["filter"]["con"+"structor"]("return tools.exec_command({cmd: `whoami`})")();';
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec', tool_input: composed,
  }), /functions\.exec/);
  const reflected = 'await tools.get_goal({}); const C = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(()=>{}), "constructor").value; await C("return tools.exec_command({cmd: `whoami`})")();';
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec', tool_input: reflected,
  }), /functions\.exec/);
});

test('functions.exec plan exception requires a literal safe patch', () => {
  const root = fixture();
  const source = "text(await tools.apply_patch('*** Begin Patch\\n*** Add File: .codex/plans/a.md\\n+# A\\n*** End Patch'));";
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'functions.exec', tool_input: source }), null);
  denied(run(root, {
    hook_event_name: 'PreToolUse', tool_name: 'functions.exec',
    tool_input: "const p = input; await tools.apply_patch(p);",
  }), /functions\.exec/);
});

test('malformed hook input fails open', () => {
  const root = fixture();
  assert.strictEqual(run(root, '{bad json'), null);
});

test('malformed Director policy fails closed with a repair message', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.codex', 'orchestra.json'), '{bad json');
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'Read' }), /malformed Director policy/);
});

test('configured allow and block rules are honored', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, '.codex', 'orchestra.json'), JSON.stringify({
    directorAllowedTools: ['Read'], directorBlockedPatterns: ['^mcp__danger__'],
  }));
  assert.strictEqual(run(root, { hook_event_name: 'PreToolUse', tool_name: 'Read' }), null);
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'mcp__danger__delete' }), /project policy/);
});

test('hardlinked plan files are denied', () => {
  const root = fixture();
  const outside = path.join(root, 'outside.md');
  const target = path.join(root, '.codex', 'plans', 'linked.md');
  fs.writeFileSync(outside, 'outside\n');
  fs.linkSync(outside, target);
  const patch = '*** Begin Patch\n*** Update File: .codex/plans/linked.md\n@@\n-outside\n+changed\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: patch }), /Director/);
});

test('symlink or junction escapes from the plans directory are denied', () => {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestra-outside-'));
  const link = path.join(root, '.codex', 'plans', 'escape');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      skipped += 1;
      process.stdout.write('ok - symlink escape (skipped: platform permission)\n');
      return;
    }
    throw error;
  }
  const patch = '*** Begin Patch\n*** Add File: .codex/plans/escape/pwn.md\n+# no\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: patch }), /Director/);

  const inRepo = path.join(root, 'src');
  const inRepoLink = path.join(root, '.codex', 'plans', 'inside-alias');
  fs.mkdirSync(inRepo);
  fs.symlinkSync(inRepo, inRepoLink, process.platform === 'win32' ? 'junction' : 'dir');
  const insidePatch = '*** Begin Patch\n*** Add File: .codex/plans/inside-alias/source.md\n+# no\n*** End Patch';
  denied(run(root, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: insidePatch }), /Director/);
});

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} guard checks passed${skipped ? ` (${skipped} skipped)` : ''}.\n`);

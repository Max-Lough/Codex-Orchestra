#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CODEX_ROOT = path.resolve(__dirname, '..');
const CLAUDE_ROOT = path.resolve(
  process.env.CLAUDE_ORCHESTRA_ROOT || path.join(CODEX_ROOT, '..', 'Claude-Orchestra')
);
const cleanups = [];
let passed = 0;
let failed = 0;

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('ok ' + passed + ' - ' + name);
  } else {
    failed += 1;
    console.log('not ok - ' + name);
    if (detail) console.log(String(detail).split('\n').map((line) => '    ' + line).join('\n'));
  }
}

function output(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

function runInstaller(root, target, args) {
  return spawnSync(process.execPath, [path.join(root, 'install.js'), target].concat(args || []), {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, {
      CLAUDE_PROJECT_DIR: target,
      ORCHESTRA_CODEX_HELPER_SIBLINGS: '',
    }),
  });
}

function initRepo(dir) {
  const result = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git init failed: ' + output(result));
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshot(root, selected) {
  const entries = [];
  const walk = (full, rel) => {
    if (!fs.existsSync(full)) {
      entries.push('M ' + rel);
      return;
    }
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      entries.push('D ' + rel);
      for (const name of fs.readdirSync(full).sort()) walk(path.join(full, name), rel + '/' + name);
    } else if (stat.isFile()) {
      entries.push('F ' + rel + ' ' + digest(full));
    } else {
      entries.push('X ' + rel);
    }
  };
  for (const rel of selected) walk(path.join(root, ...rel.split('/')), rel);
  return entries.join('\n');
}

const CLAUDE_SURFACE = ['.claude', 'CLAUDE.md', '.mcp.json'];
const CODEX_SURFACE = ['.codex', '.agents', 'AGENTS.md'];

function seedClaudeSurface(target) {
  write(path.join(target, '.claude', 'ORCHESTRA.md'), '# Claude protocol sentinel\n');
  write(path.join(target, '.claude', 'orchestra-install.json'), '{"version":"fixture","packs":["codex"],"specialists":[]}\n');
  write(path.join(target, '.claude', 'settings.json'), '{"hooks":{"PreToolUse":[{"fixture":true}]}}\n');
  write(path.join(target, '.claude', 'hooks', 'orchestra-guard.js'), '// Claude guard sentinel\n');
  write(path.join(target, '.claude', 'skills', 'orchestra-plan', 'SKILL.md'), '# Claude skill sentinel\n');
  write(path.join(target, 'CLAUDE.md'), '<!-- ORCHESTRA:BEGIN Claude fixture -->\n@.claude/ORCHESTRA.md\n<!-- ORCHESTRA:END -->\n');
  write(path.join(target, '.mcp.json'), '{"mcpServers":{"orchestra-engine":{"command":"fixture"}}}\n');
}

function guardDecision(target, role) {
  const guard = path.join(target, '.codex', 'hooks', 'orchestra-guard.js');
  const result = spawnSync(process.execPath, [guard], {
    cwd: target,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: {} }),
    env: Object.assign({}, process.env, { ORCHESTRA_ROLE: role || '', ORCHESTRA_PAUSE: '' }),
  });
  const text = String(result.stdout || '').trim();
  return text ? JSON.parse(text) : null;
}

function fixtureContract() {
  console.log('\nSynthetic Claude surface contract');
  const target = temp('orchestra-coexist-fixture-');
  initRepo(target);
  seedClaudeSurface(target);
  const before = snapshot(target, CLAUDE_SURFACE);

  const install = runInstaller(CODEX_ROOT, target, ['--packs', 'claude', '--no-specialists']);
  check('Codex install succeeds beside an existing Claude surface', install.status === 0, output(install));
  check('Codex install leaves every Claude-owned byte untouched', snapshot(target, CLAUDE_SURFACE) === before, snapshot(target, CLAUDE_SURFACE));
  check('both synthetic Claude and real Codex receipts coexist', fs.existsSync(path.join(target, '.claude', 'orchestra-install.json')) && fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')));

  write(path.join(target, '.claude', 'orchestra.pause'), 'paused\n');
  const withClaudePause = snapshot(target, CLAUDE_SURFACE);
  const claudePauseDecision = guardDecision(target, '');
  check('Claude pause file does not pause the Codex guard', claudePauseDecision && claudePauseDecision.hookSpecificOutput && claudePauseDecision.hookSpecificOutput.permissionDecision === 'deny', JSON.stringify(claudePauseDecision));
  check('Claude external reviewer role bypasses only the Codex Director guard', guardDecision(target, 'reviewer-codex-external') === null);
  check('Claude external executor role bypasses only the Codex Director guard', guardDecision(target, 'executor-codex-external') === null);
  check('Claude external planner role bypasses only the Codex Director guard', guardDecision(target, 'planner-codex-external') === null);

  const uninstall = runInstaller(CODEX_ROOT, target, ['--uninstall']);
  check('Codex uninstall succeeds beside Claude', uninstall.status === 0, output(uninstall));
  check('Codex uninstall leaves every Claude-owned byte untouched', snapshot(target, CLAUDE_SURFACE) === withClaudePause, snapshot(target, CLAUDE_SURFACE));
}

function liveContract() {
  const claudeInstaller = path.join(CLAUDE_ROOT, 'install.js');
  if (!fs.existsSync(claudeInstaller)) {
    console.log('\nLive sibling contract: skipped (set CLAUDE_ORCHESTRA_ROOT to a Claude-Orchestra checkout)');
    return;
  }

  console.log('\nLive sibling contract: ' + CLAUDE_ROOT);
  const first = temp('orchestra-coexist-claude-first-');
  initRepo(first);
  let result = runInstaller(CLAUDE_ROOT, first, ['--packs', 'codex', '--no-specialists']);
  check('Claude-first install succeeds with the Codex pack', result.status === 0, output(result));
  const claudeBeforeCodex = snapshot(first, CLAUDE_SURFACE);
  result = runInstaller(CODEX_ROOT, first, ['--packs', 'claude', '--no-specialists']);
  check('Codex-second install succeeds with the Claude pack', result.status === 0, output(result));
  check('Codex-second install preserves the real Claude surface byte-for-byte', snapshot(first, CLAUDE_SURFACE) === claudeBeforeCodex, snapshot(first, CLAUDE_SURFACE));
  const codexBeforeClaudeUpdate = snapshot(first, CODEX_SURFACE);
  result = runInstaller(CLAUDE_ROOT, first, []);
  check('Claude update succeeds after Codex is installed', result.status === 0, output(result));
  check('Claude update preserves the real Codex surface byte-for-byte', snapshot(first, CODEX_SURFACE) === codexBeforeClaudeUpdate, snapshot(first, CODEX_SURFACE));
  check('both cross-family packs are present together', fs.existsSync(path.join(first, '.claude', 'hooks', 'orchestra-review.js')) && fs.existsSync(path.join(first, '.codex', 'hooks', 'orchestra-review.js')));

  const installedClaudeReview = fs.readFileSync(path.join(first, '.claude', 'hooks', 'orchestra-review.js'), 'utf8');
  const installedClaudeExec = fs.readFileSync(path.join(first, '.claude', 'hooks', 'orchestra-exec.js'), 'utf8');
  const installedClaudePlan = fs.readFileSync(path.join(first, '.claude', 'hooks', 'orchestra-crossplan.js'), 'utf8');
  check('Claude review runner carries the external Codex isolation handshake', installedClaudeReview.includes('reviewer-codex-external') && installedClaudeReview.includes('features.hooks=false') && installedClaudeReview.includes('project_doc_max_bytes=0'));
  check('Claude execution runner carries the external Codex isolation handshake', installedClaudeExec.includes('executor-codex-external') && installedClaudeExec.includes('features.hooks=false') && installedClaudeExec.includes('project_doc_max_bytes=0'));
  check('Claude crossplan runner carries the external Codex isolation handshake', installedClaudePlan.includes('planner-codex-external') && installedClaudePlan.includes('features.hooks=false') && installedClaudePlan.includes('project_doc_max_bytes=0'));

  const claudeAfterUpdate = snapshot(first, CLAUDE_SURFACE);
  result = runInstaller(CODEX_ROOT, first, ['--uninstall']);
  check('Codex uninstall succeeds while Claude remains installed', result.status === 0, output(result));
  check('Codex uninstall preserves the complete Claude installation', snapshot(first, CLAUDE_SURFACE) === claudeAfterUpdate, snapshot(first, CLAUDE_SURFACE));
  check('Claude remains runnable after Codex uninstall', fs.existsSync(path.join(first, '.claude', 'ORCHESTRA.md')) && fs.existsSync(path.join(first, 'CLAUDE.md')));

  result = runInstaller(CODEX_ROOT, first, ['--packs', 'claude', '--no-specialists']);
  check('Codex can be reinstalled beside the surviving Claude installation', result.status === 0, output(result));
  const codexBeforeClaudeUninstall = snapshot(first, CODEX_SURFACE);
  result = runInstaller(CLAUDE_ROOT, first, ['--uninstall']);
  check('Claude uninstall succeeds while Codex remains installed', result.status === 0, output(result));
  check('Claude uninstall preserves the complete Codex installation', snapshot(first, CODEX_SURFACE) === codexBeforeClaudeUninstall, snapshot(first, CODEX_SURFACE));
  check('Codex remains runnable after Claude uninstall', fs.existsSync(path.join(first, '.codex', 'ORCHESTRA.md')) && fs.existsSync(path.join(first, 'AGENTS.md')));

  const second = temp('orchestra-coexist-codex-first-');
  initRepo(second);
  result = runInstaller(CODEX_ROOT, second, ['--packs', 'claude', '--no-specialists']);
  check('Codex-first install succeeds', result.status === 0, output(result));
  const codexBeforeClaude = snapshot(second, CODEX_SURFACE);
  result = runInstaller(CLAUDE_ROOT, second, ['--packs', 'codex', '--no-specialists']);
  check('Claude-second install succeeds', result.status === 0, output(result));
  check('Claude-second install preserves the Codex surface byte-for-byte', snapshot(second, CODEX_SURFACE) === codexBeforeClaude, snapshot(second, CODEX_SURFACE));
  check('reverse-order target contains both protocols and both receipts', fs.existsSync(path.join(second, '.codex', 'orchestra-install.json')) && fs.existsSync(path.join(second, '.claude', 'orchestra-install.json')) && fs.existsSync(path.join(second, 'AGENTS.md')) && fs.existsSync(path.join(second, 'CLAUDE.md')));
}

try {
  fixtureContract();
  liveContract();
} catch (error) {
  check('suite completed without an uncaught exception', false, error && error.stack ? error.stack : error);
} finally {
  for (const dir of cleanups.reverse()) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

console.log('\n' + (failed ? 'FAILED' : 'OK') + ' - ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

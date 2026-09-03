#!/usr/bin/env node
'use strict';

// Opt-in end-to-end smoke test. This spends one Codex model call and one Claude
// model call, so it is intentionally separate from the deterministic CI suite.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.argv.includes('--live')) {
  process.stderr.write('Refusing to spend model calls without --live.\n');
  process.exit(2);
}

const CODEX_ROOT = path.resolve(__dirname, '..');
const CLAUDE_ROOT = path.resolve(
  process.env.CLAUDE_ORCHESTRA_ROOT || path.join(CODEX_ROOT, '..', 'Claude-Orchestra')
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-live-coexist-'));
const project = path.join(root, 'project');
let passed = 0;

function run(command, args, options = {}) {
  return spawnSync(command, args, Object.assign({
    cwd: project,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }, options));
}

function must(name, result, pattern) {
  const out = String(result.stdout || '') + String(result.stderr || '');
  if (result.status !== 0 || (pattern && !pattern.test(out))) {
    throw new Error(name + ' failed (exit ' + result.status + ')\n' + out.slice(-8000));
  }
  passed += 1;
  process.stdout.write('ok ' + passed + ' - ' + name + '\n');
  return out;
}

function git(args) {
  const result = run('git', args);
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout || '').trim();
}

function digestTree(relativePaths) {
  const hash = crypto.createHash('sha256');
  function visit(absolute, relative) {
    if (!fs.existsSync(absolute)) {
      hash.update('missing\0' + relative + '\0');
      return;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      hash.update('dir\0' + relative + '\0');
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, name), path.join(relative, name));
      }
      return;
    }
    hash.update('file\0' + relative + '\0');
    hash.update(fs.readFileSync(absolute));
  }
  for (const relative of relativePaths) visit(path.join(project, relative), relative);
  return hash.digest('hex');
}

try {
  if (!fs.existsSync(path.join(CLAUDE_ROOT, 'install.js'))) {
    throw new Error('Claude-Orchestra sibling not found at ' + CLAUDE_ROOT);
  }
  fs.mkdirSync(project);
  must('fixture git init', run('git', ['init', '-q', '-b', 'main']));
  git(['config', 'user.email', 'orchestra-live@example.invalid']);
  git(['config', 'user.name', 'Orchestra Live Test']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(project, 'sample.txt'), 'one\n', 'utf8');
  git(['add', 'sample.txt']);
  git(['commit', '-qm', 'baseline']);
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(project, 'sample.txt'), 'two\n', 'utf8');
  git(['add', 'sample.txt']);
  git(['commit', '-qm', 'change sample']);
  const head = git(['rev-parse', 'HEAD']);

  must('Claude-Orchestra live install', run(process.execPath, [
    path.join(CLAUDE_ROOT, 'install.js'), project, '--packs', 'codex', '--no-specialists',
  ]));
  must('Codex-Orchestra live install', run(process.execPath, [
    path.join(CODEX_ROOT, 'install.js'), project, '--packs', 'claude', '--no-specialists',
  ]));

  const workOrder = path.join(root, 'work-order.md');
  const executorReport = path.join(root, 'executor-report.md');
  fs.writeFileSync(workOrder, 'Change sample.txt from one to two.\n', 'utf8');
  fs.writeFileSync(executorReport, 'Changed sample.txt and inspected the diff.\n', 'utf8');
  const surfaces = ['.claude', 'CLAUDE.md', '.mcp.json', '.codex', '.agents', 'AGENTS.md'];
  const before = digestTree(surfaces);

  const codexLive = run(process.execPath, [
    path.join(project, '.claude', 'hooks', 'orchestra-review.js'),
    '--doctor', '--no-repair', '--live',
  ], {
    timeout: 900000,
    env: Object.assign({}, process.env, {
      CLAUDE_PROJECT_DIR: project,
      ORCHESTRA_CODEX_HELPER_SIBLINGS: '',
    }),
  });
  must('real Codex external-worker integrity round trip', codexLive,
    /exec-lane report-integrity self-test: ok/);

  const claudeLive = run(process.execPath, [
    path.join(project, '.codex', 'hooks', 'orchestra-review.js'),
    '--work-order', workOrder,
    '--executor-report', executorReport,
    '--tier', 'inert', '--no-tests', '--retries', '0',
    '--base-ref', base, '--head-ref', head,
  ], {
    timeout: 900000,
    env: Object.assign({}, process.env, { CODEX_PROJECT_DIR: project }),
  });
  must('real Claude restricted safe-mode review', claudeLive,
    /^REVIEW ENGINE: Claude CLI/m);
  must('real Claude returned a review verdict', claudeLive,
    /^VERDICT: (?:APPROVE|REVISE)$/m);

  if (digestTree(surfaces) !== before) {
    throw new Error('a live child process changed an installed harness surface');
  }
  passed += 1;
  process.stdout.write('ok ' + passed + ' - live child processes left both harness surfaces byte-identical\n');
  process.stdout.write('\nOK - ' + passed + ' live coexistence checks passed.\n');
} catch (error) {
  process.stderr.write('\nFAILED - ' + ((error && error.stack) || error) + '\n');
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    // The OS will eventually reclaim a locked temp directory; report status is
    // determined by the actual coexistence checks above.
  }
}

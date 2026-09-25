#!/usr/bin/env node
'use strict';

// Genuine opt-in E2E: fresh Codex CLI -> installed project MCP -> real Claude
// CLI. The default path is a no-spend skip so this file is safe in CI.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { boundedDiagnostic } = require('../packs/claude/hooks/orchestra-redact');
const { validateClaudeReport } = require('../packs/claude/hooks/orchestra-review-report');
const { analyzeReviewEvents } = require('./review-mcp-live-analysis');

const ROOT = path.resolve(__dirname, '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const TEMP_PREFIX = 'codex-orchestra-review-mcp-live-';
const tempBase = path.resolve(os.tmpdir());
const EXPECTED_TIMEOUT_MS = 600000;
let runRoot = '';
let project = '';
let checks = 0;

function diagnostic(value) {
  return boundedDiagnostic(value, 4000, 256 * 1024) || '(no diagnostic output)';
}

function fail(stage, detail) {
  throw new Error('[' + stage + '] ' + detail);
}

function ok(name) {
  checks += 1;
  process.stdout.write('ok ' + checks + ' - ' + name + '\n');
}

function run(command, args, options) {
  return spawnSync(command, args, Object.assign({
    cwd: project,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
    windowsHide: true,
  }, options || {}));
}

function git(args) {
  const result = run('git', args, { timeout: 30000 });
  if (result.error || result.status !== 0) {
    fail('FIXTURE_GIT', diagnostic(result.error ? result.error.message : result.stderr || result.stdout));
  }
  return String(result.stdout || '').trim();
}

function hashTree(root) {
  const hash = crypto.createHash('sha256');
  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      hash.update('dir\0' + relative + '\0');
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!relative && name === '.git') continue;
        visit(path.join(absolute, name), relative ? path.join(relative, name) : name);
      }
    } else if (stat.isSymbolicLink()) {
      hash.update('link\0' + relative + '\0' + fs.readlinkSync(absolute) + '\0');
    } else {
      hash.update('file\0' + relative + '\0');
      hash.update(fs.readFileSync(absolute));
    }
  }
  visit(root, '');
  return hash.digest('hex');
}

function parseEvents(stdout) {
  const events = [];
  const invalid = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch (_) { invalid.push(line); }
  }
  return { events, invalid };
}

function tomlBasicString(value) {
  // JSON string quoting is a strict subset of TOML basic-string quoting for
  // ordinary filesystem paths and correctly escapes Windows backslashes.
  return JSON.stringify(String(value));
}

function safeCleanup() {
  const resolved = path.resolve(runRoot);
  if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error('refusing to clean an unvalidated temporary path: ' + resolved);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function replayEvents(overrides) {
  const report = 'REVIEW ENGINE: Claude CLI (replay)\nFINALITY: FINAL\n\n' +
    'VERDICT: APPROVE\n\n## FINDINGS\n- none\n\n## CLAIMS CHECKED\n' +
    '- documentation changed -> CONFIRMED by inspection (read review-marker.md)\n\n' +
    '## VERIFICATION\n- repository diff inspection -> PASS as a search, negative as evidence (only the marker changed)\n\n' +
    '## NITS\n- none\n';
  const args = {
    work_order: 'inert review',
    executor_report: 'documentation only',
    tier: 'inert',
    timeout_ms: EXPECTED_TIMEOUT_MS,
    retries: 0,
    no_tests: true,
  };
  const events = [
    { type: 'thread.started', thread_id: 'redacted', diagnostic: report },
    {
      type: 'item.started',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'orchestra_claude_review',
        tool: 'orchestra_review',
        status: 'in_progress',
        arguments: args,
      },
    },
    { type: 'item.completed', item: { id: 'unrelated', type: 'command_execution', status: 'completed', output: report } },
    {
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'mcp_tool_call',
        server: 'orchestra_claude_review',
        tool: 'orchestra_review',
        status: 'completed',
        arguments: JSON.stringify(args),
        result: { content: [{ type: 'text', text: report }] },
      },
    },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: report } },
  ];
  if (overrides) overrides({ events, args, report });
  return { events, args, report };
}

function analyzerReplayChecks() {
  const healthy = replayEvents();
  const result = analyzeReviewEvents(healthy.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (!result.ok || result.reportCount !== 1 || !result.relayMatches || result.id !== 'item_2') {
    fail('ANALYZER_REPLAY', JSON.stringify(result));
  }
  ok('replay counts the duplicated final relay as equality evidence, not a second report');

  const unrelated = replayEvents(({ events }) => {
    events.splice(2, 0, {
      type: 'item.completed',
      item: { id: 'other', type: 'mcp_tool_call', server: 'different_server', tool: 'other_tool', status: 'completed', result: 'VERDICT: REVISE' },
    });
  });
  if (!analyzeReviewEvents(unrelated.events, { timeoutMs: EXPECTED_TIMEOUT_MS }).ok) {
    fail('ANALYZER_REPLAY', 'unrelated events changed the target lifecycle result');
  }
  ok('replay ignores unrelated events and report-shaped strings outside the completed target MCP result');

  const wrongArgs = replayEvents(({ events, args }) => {
    args.retries = '0';
    events[3].item.arguments = JSON.stringify(args);
  });
  const wrongArgsResult = analyzeReviewEvents(wrongArgs.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (wrongArgsResult.ok || wrongArgsResult.stage !== 'MCP_TOOL_ARGUMENTS') fail('ANALYZER_REPLAY', JSON.stringify(wrongArgsResult));
  ok('replay rejects absent or mistyped no-retry and review-control arguments');

  const duplicate = replayEvents(({ events }) => { events.splice(2, 0, JSON.parse(JSON.stringify(events[1]))); });
  const duplicateResult = analyzeReviewEvents(duplicate.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (duplicateResult.ok || duplicateResult.stage !== 'MCP_TOOL_CALL_COUNT') fail('ANALYZER_REPLAY', JSON.stringify(duplicateResult));
  ok('replay rejects a duplicate MCP lifecycle event');

  const missing = replayEvents(({ events }) => { events.splice(3, 1); });
  const missingResult = analyzeReviewEvents(missing.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (missingResult.ok || missingResult.stage !== 'MCP_TOOL_CALL_COUNT') fail('ANALYZER_REPLAY', JSON.stringify(missingResult));
  ok('replay rejects a missing MCP completion');

  const divergent = replayEvents(({ events }) => { events[4].item.text += '\nnot an exact relay'; });
  const divergentResult = analyzeReviewEvents(divergent.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (divergentResult.ok || divergentResult.stage !== 'AGENT_RELAY') fail('ANALYZER_REPLAY', JSON.stringify(divergentResult));
  ok('replay rejects a divergent final agent relay');
}

analyzerReplayChecks();
if (!process.argv.includes('--live-mcp')) {
  process.stdout.write('\nSKIP - deterministic JSONL replay passed; pass --live-mcp to spend one Codex invocation and one Claude review.\n');
  process.exit(0);
}

runRoot = fs.mkdtempSync(path.join(tempBase, TEMP_PREFIX));
project = path.join(runRoot, 'project');

try {
  fs.mkdirSync(project);
  git(['init', '-q', '-b', 'main']);
  git(['config', '--local', 'user.email', 'orchestra-live@example.invalid']);
  git(['config', '--local', 'user.name', 'Orchestra MCP Live Test']);
  git(['config', '--local', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(project, 'review-marker.md'), '# Review marker\n\nBaseline documentation marker.\n', 'utf8');
  git(['add', 'review-marker.md']);
  git(['commit', '-qm', 'baseline review marker']);
  const base = git(['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(project, 'review-marker.md'), '# Review marker\n\nUpdated documentation marker.\n', 'utf8');
  git(['add', 'review-marker.md']);
  git(['commit', '-qm', 'update documentation marker']);
  const head = git(['rev-parse', 'HEAD']);
  ok('created a minimal committed baseline and head');

  const install = run(process.execPath, [
    path.join(ROOT, 'install.js'), project, '--packs', 'claude', '--no-specialists',
  ], { timeout: 120000 });
  if (install.error || install.status !== 0) {
    fail('INSTALL', diagnostic(install.error ? install.error.message : install.stderr || install.stdout));
  }
  const installedConfig = fs.readFileSync(path.join(project, '.codex', 'config.toml'), 'utf8');
  const receipt = JSON.parse(fs.readFileSync(path.join(project, '.codex', 'orchestra-install.json'), 'utf8'));
  if (receipt.version !== VERSION || !/\[mcp_servers\.orchestra_claude_review\]/.test(installedConfig)) {
    fail('PROJECT_MCP_DISCOVERY', 'the current source install did not register the project MCP server');
  }
  ok('installed v' + VERSION + ' source with the claude project MCP pack');

  const beforeHash = hashTree(project);
  const beforeStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const beforeWorktrees = git(['worktree', 'list', '--porcelain']);
  const input = {
    work_order: 'Inert documentation-only review. Confirm review-marker.md changes the prose marker from Baseline to Updated. Do not edit files and do not run tests, builds, linters, or formatters.',
    executor_report: 'Changed only review-marker.md in the committed range. The change is documentation-only. No tests were run because the work order explicitly forbids them.',
    base_ref: base,
    head_ref: head,
    tier: 'inert',
    timeout_ms: EXPECTED_TIMEOUT_MS,
    retries: 0,
    no_tests: true,
  };
  const prompt = [
    'This is an automated opt-in validation of the installed cross-family review transport.',
    'Do not read files, run commands, spawn agents, browse, or use any tool except the named MCP tool.',
    'Call mcp__orchestra_claude_review__orchestra_review exactly once with this exact JSON object:',
    JSON.stringify(input),
    'Wait for it to finish. Do not retry or call a substitute under any circumstance.',
    'After it returns, make your final response exactly the returned text with no preamble or markdown fence.',
  ].join('\n\n');
  // The fixture is disposable and the subprocess is also constrained by
  // read-only sandboxing plus ask-for-approval=never; the bypass is needed only
  // so a fresh CLI process may load this test's just-installed project MCP.
  const trustOverride = 'projects.' + tomlBasicString(path.resolve(project)) + '.trust_level="trusted"';
  const codexBin = process.env.CODEX_BIN || 'codex';
  // These are Codex-global options and intentionally precede the exec
  // subcommand. In particular, 0.153.2 rejects --ask-for-approval after exec.
  const codex = run(codexBin, [
    '--dangerously-bypass-hook-trust',
    '--ask-for-approval', 'never',
    '--cd', project,
    '--config', trustOverride,
    'exec',
    '--json',
    '--ephemeral',
    '--sandbox', 'read-only',
    prompt,
  ], {
    env: Object.assign({}, process.env, { ORCHESTRA_CLAUDE_REVIEW_RETRIES: '0' }),
  });
  if (codex.error) fail('CODEX_CLI_STARTUP', diagnostic(codex.error.message));

  const parsed = parseEvents(codex.stdout);
  if (!parsed.events.length || parsed.invalid.length) {
    fail('CODEX_CLI_PARSE_OR_STARTUP', 'expected a pure JSONL event stream; stderr: ' + diagnostic(codex.stderr));
  }
  ok('Codex CLI started one fresh ephemeral JSONL session');

  const analysis = analyzeReviewEvents(parsed.events, { timeoutMs: EXPECTED_TIMEOUT_MS });
  if (!analysis.ok) {
    const stage = analysis.stage === 'MCP_TOOL_CALL_NOT_OBSERVED' &&
      /orchestra_claude_review|MCP server|mcp server/i.test(String(codex.stderr || ''))
      ? 'PROJECT_MCP_DISCOVERY'
      : analysis.stage;
    fail(stage, analysis.error + '; stderr: ' + diagnostic(codex.stderr));
  }
  ok('project MCP discovery emitted one same-ID lifecycle with the exact inert/no-retry controls');

  const report = analysis.report;
  if (/^VERDICT:\s*REVIEW_UNAVAILABLE\s*$/m.test(report)) {
    const stage = /Claude review transport:/i.test(report) ? 'MCP_TRANSPORT' : 'CLAUDE_REVIEW';
    fail(stage, diagnostic(report));
  }
  if ((report.match(/^REVIEW ENGINE:\s*Claude CLI\b/gm) || []).length !== 1) {
    fail('CLAUDE_REPORT', 'expected exactly one Claude CLI engine attribution');
  }
  if ((report.match(/^FINALITY:\s*FINAL\b/gm) || []).length !== 1) {
    fail('CLAUDE_REPORT', 'expected exactly one FINAL finality line');
  }
  const validation = validateClaudeReport(report);
  if (!validation.ok || !['APPROVE', 'REVISE'].includes(validation.verdict)) {
    fail('CLAUDE_REPORT', validation.error || 'expected APPROVE or REVISE');
  }
  ok('completed MCP result has one validator-accepted Claude payload and the final agent relay matches it');

  if (codex.status !== 0) {
    fail('CODEX_CLI_COMPLETION', 'Codex exited ' + codex.status + ' after the tool result; stderr: ' + diagnostic(codex.stderr));
  }
  if (hashTree(project) !== beforeHash || git(['status', '--porcelain=v1', '--untracked-files=all']) !== beforeStatus || git(['rev-parse', 'HEAD']) !== head || git(['worktree', 'list', '--porcelain']) !== beforeWorktrees) {
    fail('FIXTURE_INTEGRITY', 'the Codex/Claude path changed fixture bytes, tree status, HEAD, or worktree registrations');
  }
  ok('the complete live path left fixture bytes, tree status, and HEAD unchanged');
  process.stdout.write('\nOK - ' + checks + ' live MCP checks passed.\n');
} catch (error) {
  process.stderr.write('\nFAILED - ' + diagnostic(error && error.stack ? error.stack : error) + '\n');
  process.exitCode = 1;
} finally {
  try { safeCleanup(); }
  catch (error) {
    process.stderr.write('\nFAILED - [CLEANUP] ' + diagnostic(error.message) + '\n');
    process.exitCode = 1;
  }
}

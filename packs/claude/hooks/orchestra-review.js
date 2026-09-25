#!/usr/bin/env node
/**
 * Anthropic-backed review runner for a Codex Director.
 *
 * The runner owns transport and evidence only. It starts a fresh Claude CLI
 * process, optionally in a detached worktree pinned to the requested commit,
 * and emits one final Orchestra outcome. It never turns a transport failure
 * into an approval.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { boundedDiagnostic, redactDiagnostic } = require('./orchestra-redact');
const jobrun = require('./orchestra-jobrun');
const { validateClaudeReport } = require('./orchestra-review-report');

const DEFAULTS = Object.freeze({
  bin: 'claude',
  model: 'opus',
  effort: 'high',
  timeoutMs: 1800000,
  retries: 0,
  authProbe: true,
  probeTimeoutMs: 90000,
  worktreeRoot: os.tmpdir(),
  killSurvivors: true,
  doNotRun: [],
  integrityIgnore: [],
});

function dieUsage(message) {
  process.stderr.write('ERROR: ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const result = {
    forbid: [],
    noTests: false,
    doctor: false,
    noAuthProbe: false,
  };
  const values = new Set([
    '--work-order', '--executor-report', '--tier', '--base-ref', '--head-ref',
    '--model', '--effort', '--timeout-ms', '--retries', '--probe-timeout-ms',
    '--worktree-root', '--claude-bin', '--forbid',
  ]);
  const keys = {
    '--work-order': 'workOrder',
    '--executor-report': 'executorReport',
    '--tier': 'tier',
    '--base-ref': 'baseRef',
    '--head-ref': 'headRef',
    '--model': 'model',
    '--effort': 'effort',
    '--timeout-ms': 'timeoutMs',
    '--retries': 'retries',
    '--probe-timeout-ms': 'probeTimeoutMs',
    '--worktree-root': 'worktreeRoot',
    '--claude-bin': 'bin',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--doctor') result.doctor = true;
    else if (arg === '--no-tests') result.noTests = true;
    else if (arg === '--no-auth-probe') result.noAuthProbe = true;
    else if (values.has(arg)) {
      if (index + 1 >= argv.length) dieUsage(arg + ' needs a value');
      const value = argv[++index];
      if (arg === '--forbid') result.forbid.push(value);
      else result[keys[arg]] = value;
    } else {
      dieUsage('unknown option: ' + arg);
    }
  }
  return result;
}

function projectRoot() {
  return path.resolve(process.env.CODEX_PROJECT_DIR || process.cwd());
}

function readProjectConfig(root) {
  const file = path.join(root, '.codex', 'orchestra.json');
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('the top level must be a JSON object');
    }
    if (parsed.claude === undefined) return {};
    if (!parsed.claude || typeof parsed.claude !== 'object' || Array.isArray(parsed.claude)) {
      throw new Error('the "claude" setting must be an object');
    }
    return parsed.claude;
  } catch (error) {
    throw new Error('.codex/orchestra.json is invalid JSON or schema: ' + error.message);
  }
}

function envValue(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name) && process.env[name] !== ''
    ? process.env[name]
    : undefined;
}

function firstDefined() {
  for (const value of arguments) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function retryValue(value) {
  return typeof value === 'string' && !value.trim() ? undefined : value;
}

function positiveInteger(value, label, fallback, allowZero) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(label + ' must be ' + (allowZero ? 'a non-negative' : 'a positive') + ' integer');
  }
  return number;
}

function booleanValue(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(label + ' must be true or false');
}

function stringList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item.trim());
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function configStringList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(label + ' must be an array of strings');
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function settings(args, config) {
  const resolved = {
    bin: String(firstDefined(args.bin, envValue('CLAUDE_BIN'), config.bin, DEFAULTS.bin)),
    model: String(firstDefined(args.model, envValue('ORCHESTRA_CLAUDE_REVIEW_MODEL'), config.reviewModel, DEFAULTS.model)),
    effort: String(firstDefined(args.effort, envValue('ORCHESTRA_CLAUDE_REVIEW_EFFORT'), config.reviewEffort, DEFAULTS.effort)),
    timeoutMs: positiveInteger(
      firstDefined(args.timeoutMs, envValue('ORCHESTRA_CLAUDE_REVIEW_TIMEOUT_MS'), config.reviewTimeoutMs),
      'review timeout', DEFAULTS.timeoutMs, false
    ),
    retries: positiveInteger(
      firstDefined(
        args.retries,
        retryValue(envValue('ORCHESTRA_CLAUDE_REVIEW_RETRIES')),
        retryValue(config.reviewRetries)
      ),
      'review retries', DEFAULTS.retries, true
    ),
    probeTimeoutMs: positiveInteger(
      firstDefined(args.probeTimeoutMs, envValue('ORCHESTRA_CLAUDE_PROBE_TIMEOUT_MS'), config.probeTimeoutMs),
      'probe timeout', DEFAULTS.probeTimeoutMs, false
    ),
    worktreeRoot: path.resolve(String(firstDefined(
      args.worktreeRoot,
      envValue('ORCHESTRA_CLAUDE_WORKTREE_ROOT'),
      config.worktreeRoot,
      DEFAULTS.worktreeRoot
    ))),
    authProbe: booleanValue(
      firstDefined(envValue('ORCHESTRA_CLAUDE_AUTH_PROBE'), config.authProbe),
      'auth probe', DEFAULTS.authProbe
    ),
    killSurvivors: booleanValue(
      firstDefined(
        envValue('ORCHESTRA_CLAUDE_REVIEW_KILL_SURVIVORS'),
        config.reviewKillSurvivors
      ),
      'review survivor reaping', DEFAULTS.killSurvivors
    ),
    supervise: String(envValue('ORCHESTRA_JOBRUN') || '').trim().toLowerCase() !== 'off',
    doNotRun: configStringList(config.doNotRun, 'claude.doNotRun')
      .concat(stringList(envValue('ORCHESTRA_CLAUDE_DO_NOT_RUN'))),
    integrityIgnore: configStringList(config.integrityIgnore, 'claude.integrityIgnore'),
  };
  if (args.noAuthProbe) resolved.authProbe = false;
  resolved.bin = resolved.bin.trim();
  resolved.model = resolved.model.trim();
  resolved.effort = resolved.effort.trim();
  if (!resolved.bin || !resolved.model || !resolved.effort) {
    throw new Error('Claude binary, review model, and review effort must not be empty');
  }
  if (resolved.retries > 1) throw new Error('review retries may not exceed 1');
  return resolved;
}

function engineLaunchSpec(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command))) {
    const words = [command].concat(args);
    if (words.some((word) => String(word).includes('%'))) {
      throw new Error('percent characters are not supported in Windows command-shim tokens');
    }
    const line = words
      .map((word) => '"' + String(word).replace(/"/g, '""') + '"')
      .join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', '"' + line + '"'],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args: args.slice(), windowsVerbatimArguments: false };
}

function engineSpawnOptions(options) {
  return Object.assign({
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }, options || {});
}

function run(command, args, options) {
  const childOptions = engineSpawnOptions(options);
  const spec = engineLaunchSpec(command, args);
  if (spec.windowsVerbatimArguments) childOptions.windowsVerbatimArguments = true;
  return spawnSync(spec.command, spec.args, childOptions);
}

function runSupervised(command, args, options, cfg) {
  const token = crypto.randomBytes(8).toString('hex');
  if (!cfg.supervise) {
    return {
      result: run(command, args, options),
      census: jobrun.censusBlock(null, {
        token,
        disabled: true,
        disabledWhy: 'ORCHESTRA_JOBRUN=off',
      }),
    };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-review-jobrun-'));
  try {
    const spec = engineLaunchSpec(command, args);
    const childOptions = engineSpawnOptions(options);
    if (spec.windowsVerbatimArguments) childOptions.windowsVerbatimArguments = true;
    const result = jobrun.superviseSync(
      spec.command,
      spec.args,
      childOptions,
      {
        receiptFile: path.join(scratch, 'jobrun.json'),
        deadlineMs: cfg.timeoutMs,
        killSurvivors: cfg.killSurvivors,
        token,
        scratchDir: scratch,
      }
    );
    return {
      result,
      census: jobrun.censusBlock(result.receipt, { token }),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function commandFailure(result) {
  const summary = commandFailureSummary(result);
  return summary ? summary + commandDiagnostics(result) : '';
}

function commandFailureSummary(result) {
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') return 'timed out';
    return redactDiagnostic(result.error.message);
  }
  if (result.signal) return 'terminated by signal ' + result.signal;
  if (result.status !== 0) return 'exited with status ' + result.status;
  return '';
}

function processFailureStage(result) {
  if (result.error) {
    return result.error.code === 'ETIMEDOUT' ? 'claude_timeout' : 'claude_spawn';
  }
  if (result.signal || result.status !== 0) return 'claude_abnormal_exit';
  return 'claude_process';
}

function retryableProcessFailure(result) {
  // A runner-detected timeout is the sole retryable outcome. A CLI exit or
  // signal can represent expired authentication or rejected configuration, so
  // retrying it would spend another inference without new evidence.
  return Boolean(result.error && result.error.code === 'ETIMEDOUT');
}

function diagnosticPreview(value, limit = 2000, scanCap = 256 * 1024) {
  const raw = String(value || '');
  if (raw.length > scanCap) return '[diagnostic omitted: exceeded safe redaction scan cap]';
  const clean = redactDiagnostic(raw).trim();
  if (!clean || clean.length <= limit) return clean;
  const omitted = clean.length - limit;
  const marker = '\n... [' + omitted + ' characters omitted] ...\n';
  const available = Math.max(2, limit - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return clean.slice(0, head) + marker + clean.slice(-tail);
}

function commandDiagnostics(result) {
  const stderr = diagnosticPreview(result && result.stderr);
  const stdout = diagnosticPreview(result && result.stdout);
  const parts = [];
  if (stderr) parts.push('stderr: ' + oneLine(stderr));
  if (stdout) parts.push('stdout: ' + oneLine(stdout));
  return parts.length ? ': ' + parts.join(' / ') : '';
}

function commandDiagnosticBlocks(result) {
  const blocks = [];
  for (const [label, value] of [['stdout', result && result.stdout], ['stderr', result && result.stderr]]) {
    const preview = diagnosticPreview(value);
    if (preview) blocks.push({ label: 'Claude ' + label + ' preview', preview });
  }
  return blocks;
}

function reportValidationError(report) {
  const parts = [String(report.error || 'Claude returned an invalid final review report')];
  if (report.expectedGrammar) parts.push('expected grammar: ' + report.expectedGrammar);
  if (report.offendingEntry !== undefined) {
    parts.push('offending entry: ' + diagnosticPreview(report.offendingEntry, 1000));
  }
  return parts.join('; ');
}

function authSummary(value) {
  const text = String(value || '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const method = [parsed.authMethod, parsed.apiProvider].filter((item) => typeof item === 'string' && item).join(', ');
      return (parsed.loggedIn === false ? 'not logged in' : 'logged in') + (method ? ' (' + method + ')' : '');
    }
  } catch (_) {
    // Older Claude CLIs may return a human-readable status instead of JSON.
  }
  return boundedDiagnostic(text.split(/\r?\n/)[0], 2000);
}

function probeClaude(cfg) {
  const version = run(cfg.bin, ['--version'], { timeout: cfg.probeTimeoutMs });
  const versionFailure = commandFailure(version);
  if (versionFailure) return { ok: false, detail: 'Claude CLI version probe ' + versionFailure };
  let authText = '';
  if (cfg.authProbe) {
    const auth = run(cfg.bin, ['auth', 'status'], { timeout: cfg.probeTimeoutMs });
    const authFailure = commandFailure(auth);
    if (authFailure) return { ok: false, detail: 'Claude CLI auth probe ' + authFailure };
    authText = String(auth.stdout || auth.stderr || '').trim();
  }
  return {
    ok: true,
    version: String(version.stdout || version.stderr || '').trim().split(/\r?\n/)[0],
    auth: authSummary(authText),
  };
}

function doctor(cfg) {
  const probe = probeClaude(cfg);
  if (!probe.ok) {
    process.stdout.write(
      'CLAUDE REVIEW DOCTOR: NEEDS ATTENTION\n' +
      'DETAIL: ' + probe.detail + '\n' +
      'NEXT: install/authenticate Claude CLI, or correct CLAUDE_BIN and the claude config block.\n'
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'CLAUDE REVIEW DOCTOR: OK\n' +
    'BINARY: ' + cfg.bin + '\n' +
    'VERSION: ' + (probe.version || 'available') + '\n' +
    'AUTH: ' + (cfg.authProbe ? (probe.auth || 'authenticated') : 'probe disabled') + '\n' +
    'MODEL: ' + cfg.model + '\n'
  );
}

function git(root, args, timeout) {
  return run('git', ['-C', root].concat(args), { timeout: timeout || 60000 });
}

function gitValue(root, args, label) {
  const result = git(root, args);
  const failure = commandFailure(result);
  if (failure) throw new Error(label + ' failed: ' + failure);
  return String(result.stdout || '').trim();
}

function resolveCommit(root, ref, label) {
  return gitValue(root, ['rev-parse', '--verify', ref + '^{commit}'], label);
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function checkoutForAttempt(root, cfg, baseRef, headRef) {
  if (!headRef) return { cwd: root, label: 'live working tree', cleanup: () => {} };
  fs.mkdirSync(cfg.worktreeRoot, { recursive: true });
  const realProject = fs.realpathSync(root);
  const realWorktreeRoot = fs.realpathSync(cfg.worktreeRoot);
  if (inside(realProject, realWorktreeRoot)) {
    throw new Error('worktree root must be outside the reviewed repository: ' + realWorktreeRoot);
  }
  const head = resolveCommit(root, headRef, 'head ref');
  const base = baseRef ? resolveCommit(root, baseRef, 'base ref') : '';
  const worktree = fs.mkdtempSync(path.join(realWorktreeRoot, 'orchestra-claude-review-'));
  if (inside(realProject, fs.realpathSync(worktree))) {
    fs.rmSync(worktree, { recursive: true, force: true });
    throw new Error('resolved worktree path is inside the reviewed repository');
  }
  const added = git(root, ['worktree', 'add', '--detach', worktree, head], 120000);
  const failure = commandFailure(added);
  if (failure) {
    fs.rmSync(worktree, { recursive: true, force: true });
    throw new Error('could not create pinned review worktree: ' + failure);
  }
  let cleaned = false;
  return {
    cwd: worktree,
    head,
    base,
    label: 'pinned worktree @ ' + head,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      git(root, ['worktree', 'remove', '--force', worktree], 120000);
      if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
      git(root, ['worktree', 'prune'], 60000);
    },
  };
}

function globRegex(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
}

function auditTree(root, ignorePatterns) {
  const ignores = ignorePatterns.map(globRegex);
  const tracked = gitValue(root, ['ls-files', '-z'], 'tracked-file inventory').split('\0').filter(Boolean);
  const others = gitValue(root, ['ls-files', '--others', '--exclude-standard', '-z'], 'untracked-file inventory').split('\0').filter(Boolean);
  const files = Array.from(new Set(tracked.concat(others))).sort();
  const snapshot = new Map();
  for (const relative of files) {
    const slash = relative.replace(/\\/g, '/');
    if (ignores.some((pattern) => pattern.test(slash))) continue;
    const file = path.join(root, relative);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        snapshot.set(slash, 'link:' + fs.readlinkSync(file));
      } else if (stat.isFile()) {
        snapshot.set(slash, 'file:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      } else {
        snapshot.set(slash, 'other:' + stat.mode);
      }
    } catch (_) {
      snapshot.set(slash, 'missing');
    }
  }
  return snapshot;
}

function auditDelta(before, after) {
  const names = Array.from(new Set(Array.from(before.keys()).concat(Array.from(after.keys())))).sort();
  return names.filter((name) => before.get(name) !== after.get(name));
}

function verificationBlock(root) {
  try {
    const file = path.join(root, '.codex', 'orchestra.json');
    if (!fs.existsSync(file)) return 'No verification manifest is configured.';
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config.verification) return 'No verification manifest is configured.';
    return 'PROJECT VERIFICATION MANIFEST (.codex/orchestra.json)\n' + JSON.stringify(config.verification, null, 2);
  } catch (error) {
    return 'Verification manifest could not be read: ' + error.message;
  }
}

function buildPrompt(options) {
  const prohibitions = [];
  if (options.noTests) {
    prohibitions.push(
      'HARD PROHIBITION --no-tests: do not run tests, builds, linters, formatters, or any command whose purpose is verification. Review by reading only.'
    );
  }
  for (const command of options.forbid) {
    prohibitions.push('HARD PROHIBITION --forbid: do not run or invoke `' + command.replace(/`/g, '\\`') + '` in any form.');
  }
  const scope = options.head
    ? 'PINNED SCOPE\nHEAD: ' + options.head + '\n' +
      (options.base ? 'BASE: ' + options.base + '\nReview exactly `git diff ' + options.base + '..' + options.head + '`.\n' : 'Review the pinned HEAD commit and its claimed intent.\n')
    : 'LIVE SCOPE\nReview the current working tree exactly as it exists now.\n';
  return `You are the independent Anthropic Reviewer in the Orchestra harness.
The author and Director are OpenAI Codex agents. This is the mandatory
cross-family review of an OpenAI-authored campaign. Presume the change is
broken until you fail to break it. Work only in the current repository.

${scope}
RULES
1. Read the actual diff and surrounding code. Treat the author report as a
   claim, not evidence.
2. Independently run the declared verification unless a HARD PROHIBITION below
   forbids it. Never edit, stage, commit, or intentionally alter files.
3. Hunt concrete failure scenarios: boundaries, empty state, error paths,
   concurrency, cleanup, security, API contracts, and untouched callers.
4. Audit scope. Missing requested behavior and unexplained changes are findings.
5. Review tier is ${options.tier}. If inert, prove every changed line is
   behavior-neutral first; any behavior-bearing line is a CRITICAL tier
   violation and forces full-depth review.
6. CRITICAL or MAJOR findings force REVISE. MINOR-only may approve. Style-only
   preferences are NITS. Do not fix anything.

${prohibitions.length ? prohibitions.join('\n') : 'No additional command prohibitions.'}

${options.verification}

WORK ORDER / INTENT
---
${options.workOrder}
---

AUTHOR REPORT / CLAIM
---
${options.authorReport}
---

Return exactly this structure, with no preamble. Use these Markdown headings
exactly once and in this order. Every list entry must be concrete; do not use
placeholder prose. Start each semantic entry with a top-level "- ". Indent
wrapped prose and nested evidence beneath that entry. Fence code examples and
indent the complete fence beneath its owning entry; tokens inside a fence are
examples, never report structure. For predictable output, use the canonical
CLAIMS CHECKED and VERIFICATION form \`- <subject> -> STATUS <evidence>\` with
an unformatted uppercase status. The validator also accepts a Unicode right
arrow and exact paired **bold**, __bold__, *italic*, _italic_, or \`code\`
wrappers around only the status. Keep the subject, arrow, and status on the
same top-level bullet. Evidence may follow inline or in a clearly owned,
indented non-fenced prose continuation or evidence-only nested bullet. Do not
move the arrow or status into a continuation or nested bullet, add a competing
status construct, use an em dash as the arrow, or rely on fenced content as the
only evidence. A command you could not run is still recorded as NOT-RUN with
the specific reason. The block below is an
APPROVE example; for REVISE, change its verdict and replace the FINDINGS "none"
entry with a
concrete form such as \`- [MAJOR] src/app.js:17 - stale value
survives reload - callers see old state\`. The status examples below are exact,
valid forms; explanatory evidence after the status is required. Explained
UNVERIFIED claims and NOT-RUN checks record evidence limits and may accompany
APPROVE. REFUTED claims and FAIL checks require REVISE.

VERDICT: APPROVE

## FINDINGS
- none

## CLAIMS CHECKED
- author says reload is fixed -> CONFIRMED by inspection (read src/app.js:17)

## VERIFICATION
- npm test -> PASS (65 passed)
- repository search for stale callers -> PASS as a search, negative as evidence (no remaining callers matched)
- changed-file behavior audit -> PASS by inspection (read every changed line)

## NITS
- none
`;
}

function reviewArgs(cfg) {
  return [
    '--print',
    '--restricted',
    '--safe-mode',
    '--no-session-persistence',
    '--output-format', 'text',
    '--model', cfg.model,
    '--effort', cfg.effort,
    '--permission-mode', 'dontAsk',
    '--tools', 'Bash,Read,Grep,Glob',
    '--allowedTools', 'Bash,Read,Grep,Glob',
    '--disallowedTools', 'Edit,Write,NotebookEdit,mcp__*',
    '--disable-slash-commands',
  ];
}

function attemptReview(root, cfg, request) {
  let checkout;
  let stage = 'checkout';
  let census = '';
  try {
    checkout = checkoutForAttempt(root, cfg, request.baseRef, request.headRef);
    stage = 'integrity_audit';
    const before = auditTree(checkout.cwd, cfg.integrityIgnore);
    const prompt = buildPrompt({
      workOrder: request.workOrder,
      authorReport: request.authorReport,
      tier: request.tier,
      noTests: request.noTests,
      forbid: request.forbid,
      head: checkout.head,
      base: checkout.base,
      verification: verificationBlock(root),
    });
    stage = 'claude_process';
    const supervised = runSupervised(cfg.bin, reviewArgs(cfg), {
      cwd: checkout.cwd,
      input: prompt,
      timeout: cfg.timeoutMs,
      env: Object.assign({}, process.env, {
        ORCHESTRA_ROLE: 'reviewer-claude-external',
      }),
    }, cfg);
    const result = supervised.result;
    census = supervised.census;
    stage = 'integrity_audit';
    const after = auditTree(checkout.cwd, cfg.integrityIgnore);
    const changed = auditDelta(before, after);
    if (result.supervisionError) {
      return {
        ok: false,
        stage: 'process_supervision',
        retryable: false,
        detail: 'Claude CLI review supervision failed: ' + result.supervisionError,
        diagnostics: commandDiagnosticBlocks(result),
        changed,
        checkout: checkout.label,
        census,
      };
    }
    const failure = commandFailureSummary(result);
    if (failure) {
      return {
        ok: false,
        stage: processFailureStage(result),
        retryable: retryableProcessFailure(result),
        detail: 'Claude CLI review ' + failure,
        diagnostics: commandDiagnosticBlocks(result),
        changed,
        checkout: checkout.label,
        census,
      };
    }
    const response = String(result.stdout || '').trim();
    stage = 'report_contract';
    const report = validateClaudeReport(response);
    if (!report.ok || report.verdict === 'REVIEW_UNAVAILABLE') {
      return {
        ok: false,
        stage,
        retryable: false,
        detail: 'Claude returned an invalid final review report',
        validationError: report.verdict === 'REVIEW_UNAVAILABLE'
          ? 'REVIEW_UNAVAILABLE is not a Claude verdict'
          : reportValidationError(report),
        diagnostics: commandDiagnosticBlocks(result),
        changed,
        checkout: checkout.label,
        census,
      };
    }
    return { ok: true, response, changed, checkout: checkout.label, census };
  } catch (error) {
    return {
      ok: false,
      stage,
      retryable: false,
      detail: error.message,
      changed: [],
      checkout: checkout ? checkout.label : '',
      census,
    };
  } finally {
    if (checkout) checkout.cleanup();
  }
}

function readRequired(file, label) {
  if (!file) throw new Error('missing ' + label + ' path');
  try {
    return fs.readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    throw new Error('cannot read ' + label + ': ' + error.message);
  }
}

function finality(attempts, maximum) {
  return 'FINALITY: FINAL (attempts ' + attempts + '/' + maximum + '; no later verdict will be produced by this run)';
}

function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' / ').trim();
}

function safeEngineOutput(value) {
  return String(value)
    .split(/\r?\n/)
    .map((line) => /^(REVIEW ENGINE:|FINALITY:|STAGE:|INTEGRITY WARNING:|=== CLAUDE OUTPUT ===)/.test(line)
      ? '> ' + line
      : line)
    .join('\n');
}

function unavailable(detail, attempts, maximum, integrityPaths) {
  const failures = Array.isArray(detail)
    ? detail
    : [detail && typeof detail === 'object' ? detail : { detail: String(detail || '') }];
  const stages = Array.from(new Set(failures.map((failure) => failure.stage || 'unknown')));
  const detailLines = failures.map((failure) => {
    const prefix = failure.attempt ? 'attempt ' + failure.attempt + ': ' : '';
    const stage = failure.stage || 'unknown';
    return '- ' + prefix + 'stage=' + stage + '; ' + oneLine(boundedDiagnostic(failure.detail, 2000));
  });
  const validationLines = failures.filter((failure) => failure.validationError).map((failure) => {
    const prefix = failure.attempt ? 'attempt ' + failure.attempt + ': ' : '';
    // Validation errors are short, authoritative parser output. Keep them on
    // their own line instead of burying them in a second tail truncation.
    return '- ' + prefix + oneLine(boundedDiagnostic(failure.validationError, 2000));
  });
  const diagnosticBlocks = [];
  const censusBlocks = failures
    .filter((failure) => failure.census)
    .map((failure) => {
      const prefix = failure.attempt ? 'PROCESS CENSUS (attempt ' + failure.attempt + '):' : '';
      return prefix
        ? failure.census.replace(/^PROCESS CENSUS:/, prefix)
        : failure.census;
    });
  for (const failure of failures) {
    for (const diagnostic of failure.diagnostics || []) {
      const prefix = failure.attempt ? 'attempt ' + failure.attempt + ' ' : '';
      diagnosticBlocks.push(
        prefix + diagnostic.label + ':\n' +
        diagnostic.preview.split(/\r?\n/).map((line) => '> ' + line).join('\n')
      );
    }
  }
  process.stdout.write(
    'REVIEW ENGINE: NONE - no verdict produced (attempted: Claude CLI, cross-vendor)\n' +
    finality(attempts, maximum) + '\n' +
    'STAGE: ' + stages.join(',') + '\n' +
    (integrityPaths.length
      ? 'INTEGRITY WARNING: the review checkout changed: ' + integrityPaths.join(', ') + '\n'
      : '') +
    (censusBlocks.length ? censusBlocks.join('\n') + '\n' : '') +
    '\nVERDICT: REVIEW_UNAVAILABLE\n\n' +
    'DETAIL\n' + detailLines.join('\n') + '\n' +
    (validationLines.length ? '\nVALIDATION ERROR\n' + validationLines.join('\n') + '\n' : '') +
    (diagnosticBlocks.length ? '\nDIAGNOSTICS (bounded, redacted head and tail)\n' + diagnosticBlocks.join('\n') + '\n' : '') +
    '\n' +
    'NEXT\n- Run `node .codex/hooks/orchestra-review.js --doctor`; then retry or use the native OpenAI reviewer and report that Claude did not review.\n'
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = projectRoot();
  let cfg;
  try {
    cfg = settings(args, readProjectConfig(root));
  } catch (error) {
    if (args.doctor) {
      process.stdout.write(
        'CLAUDE REVIEW DOCTOR: NEEDS ATTENTION\n' +
        'DETAIL: ' + oneLine(boundedDiagnostic(error.message, 2000)) + '\n' +
        'NEXT: repair .codex/orchestra.json or the reported Claude review setting.\n'
      );
      process.exitCode = 1;
      return;
    }
    return unavailable({ stage: 'configuration', detail: error.message }, 0, 0, []);
  }
  if (args.doctor) return doctor(cfg);
  if (args.baseRef && !args.headRef) {
    return unavailable({ stage: 'input', detail: '--base-ref requires --head-ref so the reviewed checkout is immutable' }, 0, 0, []);
  }
  const tier = String(args.tier || 'full').toLowerCase();
  if (!['full', 'inert'].includes(tier)) {
    return unavailable({ stage: 'input', detail: 'unsupported tier: ' + tier + ' (use full or inert)' }, 0, 0, []);
  }
  let workOrder;
  let authorReport;
  try {
    workOrder = readRequired(args.workOrder, '--work-order');
    authorReport = readRequired(args.executorReport, '--executor-report');
  } catch (error) {
    return unavailable({ stage: 'input', detail: error.message }, 0, 0, []);
  }
  const probe = probeClaude(cfg);
  if (!probe.ok) return unavailable({ stage: 'preflight', detail: probe.detail }, 0, 0, []);

  const request = {
    baseRef: args.baseRef || '',
    headRef: args.headRef || '',
    workOrder,
    authorReport,
    tier,
    noTests: args.noTests,
    forbid: Array.from(new Set(cfg.doNotRun.concat(args.forbid))).filter(Boolean),
  };
  const maximum = cfg.retries + 1;
  const failures = [];
  const integrity = new Set();
  for (let attempt = 1; attempt <= maximum; attempt += 1) {
    const outcome = attemptReview(root, cfg, request);
    for (const item of outcome.changed || []) integrity.add(item);
    if (outcome.ok) {
      process.stdout.write(
        'REVIEW ENGINE: Claude CLI (requested model: ' + cfg.model + ', effort: ' + cfg.effort +
          ', timeout: ' + cfg.timeoutMs + 'ms, fresh context, tier: ' + tier +
          ', checkout: ' + outcome.checkout + ')\n' +
        finality(attempt, maximum) + '\n' +
        (integrity.size
          ? 'INTEGRITY WARNING: the review checkout changed: ' + Array.from(integrity).sort().join(', ') + '\n'
          : '') +
        (outcome.census ? outcome.census + '\n' : '') +
        '\n=== CLAUDE OUTPUT ===\n' + safeEngineOutput(outcome.response) + '\n'
      );
      return;
    }
    failures.push({
      attempt,
      stage: outcome.stage,
      detail: outcome.detail,
      validationError: outcome.validationError,
      diagnostics: outcome.diagnostics || [],
      census: outcome.census || '',
    });
    if (!outcome.retryable) {
      unavailable(failures, attempt, attempt, Array.from(integrity).sort());
      return;
    }
  }
  unavailable(failures, maximum, maximum, Array.from(integrity).sort());
}

try {
  main();
} catch (error) {
  unavailable({ stage: 'runner_internal', detail: 'review runner failed: ' + error.message }, 0, 0, []);
}

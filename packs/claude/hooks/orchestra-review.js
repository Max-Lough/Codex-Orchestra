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

const DEFAULTS = Object.freeze({
  bin: 'claude',
  model: 'opus',
  effort: 'high',
  timeoutMs: 1800000,
  retries: 1,
  authProbe: true,
  probeTimeoutMs: 90000,
  worktreeRoot: os.tmpdir(),
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
      firstDefined(args.retries, envValue('ORCHESTRA_CLAUDE_REVIEW_RETRIES'), config.reviewRetries),
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

function run(command, args, options) {
  const childOptions = Object.assign({
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }, options || {});
  // npm-distributed CLIs are commonly .cmd shims on Windows. CreateProcess
  // cannot execute them directly, so use cmd.exe only for that explicit file
  // kind. Reject command-string metacharacters instead of exposing a generic
  // shell interpolation surface for config-controlled model/effort values.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const words = [command].concat(args);
    if (words.some((word) => /[\r\n%&|<>^!\u0000]/.test(String(word)))) {
      return { error: new Error('unsafe character in Windows command-shim argument') };
    }
    childOptions.shell = true;
    return spawnSync(command, args, childOptions);
  }
  return spawnSync(command, args, childOptions);
}

function commandFailure(result) {
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') return 'timed out';
    return result.error.message;
  }
  if (result.signal) return 'terminated by signal ' + result.signal;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 2000);
    return 'exited with status ' + result.status + (detail ? ': ' + detail : '');
  }
  return '';
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
  return text.split(/\r?\n/)[0];
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

Return exactly this structure, with no preamble:

VERDICT: APPROVE | REVISE

FINDINGS
- [CRITICAL|MAJOR|MINOR] path:line - defect - concrete failure scenario
- or "none"

CLAIMS CHECKED
- "author claim" -> CONFIRMED | REFUTED | UNVERIFIED (how checked)

VERIFICATION
- command -> actual result

NITS
- non-blocking suggestions or "none"
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
  try {
    checkout = checkoutForAttempt(root, cfg, request.baseRef, request.headRef);
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
    const result = run(cfg.bin, reviewArgs(cfg), {
      cwd: checkout.cwd,
      input: prompt,
      timeout: cfg.timeoutMs,
      env: Object.assign({}, process.env, {
        ORCHESTRA_ROLE: 'reviewer-claude-external',
      }),
    });
    const after = auditTree(checkout.cwd, cfg.integrityIgnore);
    const changed = auditDelta(before, after);
    const failure = commandFailure(result);
    if (failure) {
      return { ok: false, detail: 'Claude CLI review ' + failure, changed, checkout: checkout.label };
    }
    const response = String(result.stdout || '').trim();
    const verdicts = response.match(/^VERDICT:\s*(APPROVE|REVISE)\s*$/gm) || [];
    if (verdicts.length !== 1) {
      return {
        ok: false,
        detail: 'Claude returned ' + verdicts.length + ' parseable verdict lines; exactly one is required',
        changed,
        checkout: checkout.label,
      };
    }
    return { ok: true, response, changed, checkout: checkout.label };
  } catch (error) {
    return { ok: false, detail: error.message, changed: [], checkout: checkout ? checkout.label : '' };
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
    .map((line) => /^(REVIEW ENGINE:|FINALITY:|INTEGRITY WARNING:|=== CLAUDE OUTPUT ===)/.test(line)
      ? '> ' + line
      : line)
    .join('\n');
}

function unavailable(detail, attempts, maximum, integrityPaths) {
  process.stdout.write(
    'REVIEW ENGINE: NONE - no verdict produced (attempted: Claude CLI, cross-vendor)\n' +
    finality(attempts, maximum) + '\n' +
    (integrityPaths.length
      ? 'INTEGRITY WARNING: the review checkout changed: ' + integrityPaths.join(', ') + '\n'
      : '') +
    '\nVERDICT: REVIEW_UNAVAILABLE\n\n' +
    'DETAIL\n- ' + oneLine(detail) + '\n\n' +
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
        'DETAIL: ' + oneLine(error.message) + '\n' +
        'NEXT: repair .codex/orchestra.json or the reported Claude review setting.\n'
      );
      process.exitCode = 1;
      return;
    }
    return unavailable(error.message, 0, 0, []);
  }
  if (args.doctor) return doctor(cfg);
  if (args.baseRef && !args.headRef) {
    return unavailable('--base-ref requires --head-ref so the reviewed checkout is immutable', 0, cfg.retries + 1, []);
  }
  const tier = String(args.tier || 'full').toLowerCase();
  if (!['full', 'inert'].includes(tier)) {
    return unavailable('unsupported tier: ' + tier + ' (use full or inert)', 0, cfg.retries + 1, []);
  }
  let workOrder;
  let authorReport;
  try {
    workOrder = readRequired(args.workOrder, '--work-order');
    authorReport = readRequired(args.executorReport, '--executor-report');
  } catch (error) {
    return unavailable(error.message, 0, cfg.retries + 1, []);
  }
  const probe = probeClaude(cfg);
  if (!probe.ok) return unavailable(probe.detail, 0, cfg.retries + 1, []);

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
        '\n=== CLAUDE OUTPUT ===\n' + safeEngineOutput(outcome.response) + '\n'
      );
      return;
    }
    failures.push('attempt ' + attempt + ': ' + outcome.detail);
  }
  unavailable(failures.join('; '), maximum, maximum, Array.from(integrity).sort());
}

try {
  main();
} catch (error) {
  unavailable('review runner failed: ' + error.message, 0, 0, []);
}

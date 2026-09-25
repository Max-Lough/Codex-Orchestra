#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const jobrun = require('./orchestra-jobrun');
const engineLaunch = require('./orchestra-engine-launch');

const DEFAULTS = {
  bin: 'claude',
  model: 'opus', // Stable Claude CLI alias; harness policy is Opus 5.5.
  effort: 'high',
  timeoutMs: 1800000,
  killSurvivors: true,
};

function parseArgs(argv) {
  const keys = {
    '--work-order': 'workOrder',
    '--model': 'model',
    '--effort': 'effort',
    '--timeout-ms': 'timeoutMs',
    '--claude-bin': 'bin',
  };
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!Object.prototype.hasOwnProperty.call(keys, flag)) {
      throw new Error('unknown option: ' + flag);
    }
    if (index + 1 >= argv.length || String(argv[index + 1]).startsWith('--')) {
      throw new Error(flag + ' requires a value');
    }
    result[keys[flag]] = argv[++index];
  }
  return result;
}

function positiveInteger(input, label, fallback) {
  if (input === undefined || input === null || input === '') return fallback;
  const number = Number(input);
  if (!Number.isInteger(number) || number <= 0) throw new Error(label + ' must be a positive integer');
  return number;
}

function firstDefined() {
  for (const value of arguments) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function booleanValue(input, fallback, label) {
  if (input === undefined || input === '') return fallback;
  if (typeof input === 'boolean') return input;
  const normalized = String(input).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(label + ' must be true or false');
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readWorkOrder(root, file) {
  const lexicalRoot = path.resolve(root);
  const target = path.resolve(lexicalRoot, file);
  if (!isContained(lexicalRoot, target)) {
    throw new Error('--work-order must stay inside the project root');
  }
  const lstat = fs.lstatSync(target);
  if (!lstat.isFile() || lstat.isSymbolicLink()) {
    throw new Error('--work-order must name a regular project file, not a link');
  }
  const realRoot = fs.realpathSync(lexicalRoot);
  const realTarget = fs.realpathSync(target);
  if (!isContained(realRoot, realTarget)) {
    throw new Error('--work-order resolves outside the project root');
  }
  return fs.readFileSync(realTarget, 'utf8');
}

function readConfig(root) {
  const file = path.join(root, '.codex', 'orchestra.json');
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('.codex/orchestra.json must contain an object');
  }
  if (parsed.claude === undefined) return {};
  if (!parsed.claude || typeof parsed.claude !== 'object' || Array.isArray(parsed.claude)) {
    throw new Error('the "claude" setting must be an object');
  }
  return parsed.claude;
}

function resolveSettings(root, args) {
  const config = readConfig(root);
  const effort = String(
    args.effort || process.env.ORCHESTRA_CLAUDE_VISUAL_EFFORT ||
    config.visualEffort || DEFAULTS.effort
  ).trim().toLowerCase();
  if (!['high', 'xhigh'].includes(effort)) {
    throw new Error('visual effort must be high or xhigh');
  }
  const resolved = {
    bin: String(args.bin || process.env.CLAUDE_BIN || config.bin || DEFAULTS.bin).trim(),
    model: String(args.model || process.env.ORCHESTRA_CLAUDE_VISUAL_MODEL || config.visualModel || DEFAULTS.model).trim(),
    effort,
    timeoutMs: positiveInteger(
      firstDefined(args.timeoutMs, process.env.ORCHESTRA_CLAUDE_VISUAL_TIMEOUT_MS, config.visualTimeoutMs),
      'visual timeout',
      DEFAULTS.timeoutMs
    ),
    killSurvivors: booleanValue(
      process.env.ORCHESTRA_CLAUDE_VISUAL_KILL_SURVIVORS ?? config.visualKillSurvivors,
      DEFAULTS.killSurvivors,
      'visual survivor reaping'
    ),
  };
  if (!resolved.bin) throw new Error('Claude binary must not be empty');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/\-\[\]]*$/.test(resolved.model)) {
    throw new Error('visual model contains unsupported characters');
  }
  return resolved;
}

function buildPrompt(workOrder) {
  return `You are the external Anthropic visual-development Executor in the
Codex-Orchestra harness. Harness policy selects Opus 5.5. Work directly in the
current repository and execute the work order exactly as scoped. You are a
partner to the Astra Director/executor, never the reviewer of your own work.

VISUAL / BLENDER CHARTER
1. Establish pinned Blender/Godot versions and asset/export paths first.
2. Prefer reproducible headless Blender scripts over unrecorded manual edits.
3. Produce, render previews, inspect them visually, and adjust within the
   order's iteration budget.
4. Emit inspectable render/export/log evidence and mesh/material/texture stats.
5. Verify export and Godot import, including scene, collider, LOD, scale,
   naming, origin, and import warnings.
6. Treat poly, texture, material, scope, and time budgets as hard constraints.
7. Do not commit, push, broaden scope, or approve your own work.

WORK ORDER
---
${workOrder}
---

Return exactly:
STATUS: DONE | PARTIAL | BLOCKED | CHECKPOINT

CHANGES
- <path> — <what changed and why>

ARTIFACTS
- <absolute path> — <render/export/log and what to inspect>

STATS
- <asset> — <tris/verts, materials, textures, collider/LOD status>

VERIFICATION
- <command> → <actual result and key warnings>

DEVIATIONS
- <difference from the order, or none>

CONCERNS
- <risk, budget pressure, or visual defect, or none>
`;
}

function unavailable(reason, census) {
  process.stdout.write(
    'EXEC ENGINE: NONE - no Anthropic visual executor result was produced\n' +
    (census ? census + '\n' : '') +
    'STATUS: EXEC_UNAVAILABLE\n\nREASON\n- ' + String(reason).replace(/[\r\n]+/g, ' ') + '\n'
  );
  process.exitCode = 1;
}

function runSupervised(command, args, options, cfg) {
  const token = crypto.randomBytes(8).toString('hex');
  const spec = engineLaunch.engineLaunchSpec(command, args);
  const childOptions = engineLaunch.engineSpawnOptions(options);
  if (spec.windowsVerbatimArguments) childOptions.windowsVerbatimArguments = true;
  if (String(process.env.ORCHESTRA_JOBRUN || '').trim().toLowerCase() === 'off') {
    return {
      result: spawnSync(spec.command, spec.args, childOptions),
      census: jobrun.censusBlock(null, { token, disabled: true, disabledWhy: 'ORCHESTRA_JOBRUN=off' }),
    };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-visual-jobrun-'));
  try {
    const result = jobrun.superviseSync(spec.command, spec.args, childOptions, {
      receiptFile: path.join(scratch, 'jobrun.json'),
      deadlineMs: cfg.timeoutMs,
      killSurvivors: cfg.killSurvivors,
      token,
      scratchDir: scratch,
    });
    return { result, census: jobrun.censusBlock(result.receipt, { token }) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const root = path.resolve(process.env.CODEX_PROJECT_DIR || process.cwd());
  let cfg;
  let workOrder;
  try {
    const args = parseArgs(argv);
    const workOrderPath = args.workOrder;
    if (!workOrderPath) throw new Error('--work-order is required');
    cfg = resolveSettings(root, args);
    workOrder = readWorkOrder(root, workOrderPath);
  } catch (error) {
    return unavailable(error.message);
  }
  const args = [
    '--print', '--restricted', '--safe-mode', '--no-session-persistence',
    '--output-format', 'text', '--model', cfg.model, '--effort', cfg.effort,
    '--permission-mode', 'dontAsk',
    '--tools', 'Bash,Read,Grep,Glob,Edit,Write',
    '--allowedTools', 'Bash,Read,Grep,Glob,Edit,Write',
    '--disallowedTools', 'Agent,NotebookEdit,mcp__*',
    '--disable-slash-commands',
  ];
  let supervised;
  try {
    supervised = runSupervised(cfg.bin, args, {
      cwd: root,
      input: buildPrompt(workOrder),
      timeout: cfg.timeoutMs,
      env: { ...process.env, ORCHESTRA_ROLE: 'executor-claude-visual-external' },
    }, cfg);
  } catch (error) {
    return unavailable(error.message);
  }
  const result = supervised.result;
  const census = supervised.census;
  if (result.supervisionError) return unavailable('Claude CLI process supervision failed: ' + result.supervisionError, census);
  if (result.error) return unavailable(result.error.message, census);
  if (result.signal || result.status !== 0) {
    return unavailable('Claude CLI exited abnormally (status=' + result.status + ', signal=' + (result.signal || 'none') + ')', census);
  }
  if (!String(result.stdout || '').trim()) return unavailable('Claude CLI wrote no executor report', census);
  process.stdout.write(
    'EXEC ENGINE: Claude CLI (requested model: ' + cfg.model +
    ', policy: Opus 5.5, effort: ' + cfg.effort + ', fresh context)\n' +
    census + '\n\n' +
    String(result.stdout).trimEnd() + '\n'
  );
}

main();

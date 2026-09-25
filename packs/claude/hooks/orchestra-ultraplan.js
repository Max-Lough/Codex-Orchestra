#!/usr/bin/env node
/**
 * Optional Anthropic planning counterpart for a Codex Director.
 * It receives plan text and a closed-world brief, launches a fresh Claude CLI
 * process with repository tools disabled, and relays one critique/revision.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const jobrun = require('./orchestra-jobrun');

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

function read(file, label) {
  if (!file) throw new Error('missing ' + label + ' path');
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function unavailable(detail, census) {
  process.stdout.write(
    'ULTRA-PLAN ENGINE: NONE - no verdict produced (attempted: Claude CLI)\n' +
    (census ? census + '\n' : '') + '\n' +
    'VERDICT: ULTRAPLAN_UNAVAILABLE\n\nDETAIL\n- ' + detail + '\n\n' +
    'NEXT\n- Check Claude CLI with `node .codex/hooks/orchestra-review.js --doctor`, then retry or continue without the cross-family consultation.\n'
  );
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

function booleanValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('ORCHESTRA_CLAUDE_PLAN_KILL_SURVIVORS must be true or false');
}

function engineSpawnOptions(options) {
  return Object.assign({
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  }, options || {});
}

function commandSupervised(command, args, options, timeout, killSurvivors) {
  const token = crypto.randomBytes(8).toString('hex');
  if (String(process.env.ORCHESTRA_JOBRUN || '').trim().toLowerCase() === 'off') {
    const spec = engineLaunchSpec(command, args);
    const childOptions = engineSpawnOptions(options);
    if (spec.windowsVerbatimArguments) childOptions.windowsVerbatimArguments = true;
    return {
      result: spawnSync(spec.command, spec.args, childOptions),
      census: jobrun.censusBlock(null, {
        token,
        disabled: true,
        disabledWhy: 'ORCHESTRA_JOBRUN=off',
      }),
    };
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-claude-plan-jobrun-'));
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
        deadlineMs: timeout,
        killSurvivors,
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
function prompt(plan, brief, round) {
  return `You are the independent Anthropic planning counterpart in an
Orchestra roundabout. The standing plan was drafted by an OpenAI Director.
You have no repository access; the supplied brief is the complete fact set.

ROUND: ${round}

ROUND BRIEF
---
${brief}
---

STANDING PLAN
---
${plan}
---

Review for missing requirements, unsafe sequencing or parallelism, hidden
coupling, unverifiable acceptance criteria, weak recovery, and oversized work
orders. Do not invent repository facts.

Return either:

VERDICT: APPROVE

RATIONALE
<why no change is required>

or:

VERDICT: REVISE

CRITIQUE
1. <specific issue and consequence>

UPDATED PLAN
<complete replacement plan>
`;
}

function main() {
  let plan;
  let brief;
  try {
    plan = read(value('--plan'), '--plan');
    brief = read(value('--brief'), '--brief');
  } catch (error) {
    return unavailable(error.message);
  }
  const round = Number(value('--round') || 1);
  if (!Number.isInteger(round) || round < 1) return unavailable('invalid --round value');
  const model = (value('--model') || process.env.ORCHESTRA_CLAUDE_PLAN_MODEL || 'fable').trim();
  const effort = (value('--effort') || process.env.ORCHESTRA_CLAUDE_PLAN_EFFORT || 'max').trim();
  const timeout = Number(process.env.ORCHESTRA_CLAUDE_PLAN_TIMEOUT_MS || 900000);
  const binary = (process.env.CLAUDE_BIN || 'claude').trim();
  const deadlineMs = Number.isInteger(timeout) && timeout > 0 ? timeout : 900000;
  const killSurvivors = booleanValue(process.env.ORCHESTRA_CLAUDE_PLAN_KILL_SURVIVORS, true);
  const supervised = commandSupervised(binary, [
    '--print', '--restricted', '--safe-mode', '--no-session-persistence',
    '--output-format', 'text', '--model', model, '--effort', effort,
    '--permission-mode', 'dontAsk', '--tools', '',
  ], {
    cwd: process.cwd(),
    input: prompt(plan, brief, round),
    timeout: deadlineMs,
    env: Object.assign({}, process.env, {
      ORCHESTRA_ROLE: 'planner-claude-external',
    }),
  }, deadlineMs, killSurvivors);
  const result = supervised.result;
  const census = supervised.census;
  if (result.supervisionError) {
    return unavailable('Claude CLI process supervision failed: ' + result.supervisionError, census);
  }
  if (result.error) {
    const detail = result.error.code === 'ETIMEDOUT'
      ? 'Claude CLI planning consultation timed out after ' + deadlineMs + 'ms'
      : 'failed to launch Claude CLI: ' + result.error.message;
    return unavailable(detail, census);
  }
  if (result.status !== 0) {
    return unavailable('Claude CLI exited with status ' + result.status + ': ' + String(result.stderr || '').trim().slice(0, 2000), census);
  }
  const response = String(result.stdout || '').trim();
  const verdicts = response.match(/^VERDICT:\s*(APPROVE|REVISE)\s*$/gm) || [];
  if (verdicts.length !== 1) return unavailable('Claude returned no single parseable APPROVE/REVISE verdict', census);
  if (/^VERDICT:\s*REVISE\s*$/m.test(response) && !/^UPDATED PLAN\s*$/m.test(response)) {
    return unavailable('Claude requested revision without a complete UPDATED PLAN', census);
  }
  process.stdout.write(
    'ULTRA-PLAN ENGINE: Claude CLI (requested model: ' + model + ', effort: ' + effort + ', fresh context, round: ' + round + ')\n' +
    census + '\n\n' + response + '\n'
  );
}

try {
  main();
} catch (error) {
  unavailable('ultra-plan runner failed: ' + error.message);
}

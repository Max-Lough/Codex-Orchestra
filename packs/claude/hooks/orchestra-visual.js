#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULTS = {
  bin: 'claude',
  model: 'opus', // Stable Claude CLI alias; harness policy is Opus 5.5.
  effort: 'high',
  timeoutMs: 1800000,
};

function value(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function positiveInteger(input, fallback) {
  const number = Number(input);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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

function resolveSettings(root, argv) {
  const config = readConfig(root);
  const effort = String(
    value(argv, '--effort') || process.env.ORCHESTRA_CLAUDE_VISUAL_EFFORT ||
    config.visualEffort || DEFAULTS.effort
  ).trim().toLowerCase();
  if (!['high', 'xhigh'].includes(effort)) {
    throw new Error('visual effort must be high or xhigh');
  }
  return {
    bin: String(value(argv, '--claude-bin') || process.env.CLAUDE_BIN || config.bin || DEFAULTS.bin).trim(),
    model: String(value(argv, '--model') || process.env.ORCHESTRA_CLAUDE_VISUAL_MODEL || config.visualModel || DEFAULTS.model).trim(),
    effort,
    timeoutMs: positiveInteger(
      value(argv, '--timeout-ms') || process.env.ORCHESTRA_CLAUDE_VISUAL_TIMEOUT_MS || config.visualTimeoutMs,
      DEFAULTS.timeoutMs
    ),
  };
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

function unavailable(reason) {
  process.stdout.write(
    'EXEC ENGINE: NONE - no Anthropic visual executor result was produced\n' +
    'STATUS: EXEC_UNAVAILABLE\n\nREASON\n- ' + String(reason).replace(/[\r\n]+/g, ' ') + '\n'
  );
  process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  const workOrderPath = value(argv, '--work-order');
  if (!workOrderPath) return unavailable('--work-order is required');
  const root = path.resolve(process.env.CODEX_PROJECT_DIR || process.cwd());
  let cfg;
  let workOrder;
  try {
    cfg = resolveSettings(root, argv);
    workOrder = fs.readFileSync(path.resolve(root, workOrderPath), 'utf8');
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
  const result = spawnSync(cfg.bin, args, {
    cwd: root,
    input: buildPrompt(workOrder),
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cfg.bin),
    timeout: cfg.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ORCHESTRA_ROLE: 'executor-claude-visual-external' },
  });
  if (result.error) return unavailable(result.error.message);
  if (result.signal || result.status !== 0) {
    return unavailable('Claude CLI exited abnormally (status=' + result.status + ', signal=' + (result.signal || 'none') + ')');
  }
  if (!String(result.stdout || '').trim()) return unavailable('Claude CLI wrote no executor report');
  process.stdout.write(
    'EXEC ENGINE: Claude CLI (requested model: ' + cfg.model +
    ', policy: Opus 5.5, effort: ' + cfg.effort + ', fresh context)\n\n' +
    String(result.stdout).trimEnd() + '\n'
  );
}

main();

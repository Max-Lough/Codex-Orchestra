#!/usr/bin/env node
'use strict';
/**
 * Blocking MCP transport for the Claude review runner.
 *
 * The server exposes one read-only tool. It serializes typed review inputs to
 * temporary files, waits for orchestra-review.js to close, and returns the
 * runner's stdout byte-for-byte. Transport failures are normal, explicit
 * REVIEW_UNAVAILABLE reports so the Director only has to relay the result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { boundedDiagnostic, redactDiagnostic } = require('./orchestra-redact');

const SERVER_NAME = 'orchestra-claude-review';
// Keep a complete successful report below the custom agent's MCP tool-output
// budget. Crossing the cap is unavailable, never a silently truncated review.
const OUTPUT_CAP = 32 * 1024;
const DIAGNOSTIC_CAP = 4000;
const DEFAULT_REVIEW_TIMEOUT_MS = 1800000;
const DEFAULT_PROBE_TIMEOUT_MS = 90000;
const DEFAULT_RETRIES = 1;
const TASKKILL_TIMEOUT_MS = 5000;

function resolveRoot() {
  if (process.env.ORCHESTRA_MCP_ROOT) return path.resolve(process.env.ORCHESTRA_MCP_ROOT);
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    if (result.status === 0 && String(result.stdout || '').trim()) {
      return path.resolve(String(result.stdout).trim());
    }
  } catch (_) {
    // Fall back to the MCP server's launch directory.
  }
  return process.cwd();
}

const ROOT = resolveRoot();
const HOOKS_DIR = process.env.ORCHESTRA_MCP_HOOKS_DIR
  ? path.resolve(process.env.ORCHESTRA_MCP_HOOKS_DIR)
  : __dirname;
const RUNNER = path.join(HOOKS_DIR, 'orchestra-review.js');

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function projectClaudeConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex', 'orchestra.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      parsed.claude && typeof parsed.claude === 'object' && !Array.isArray(parsed.claude)
      ? parsed.claude
      : {};
  } catch (_) {
    return {};
  }
}

function effectiveBackstopMs(timeoutArg) {
  const config = projectClaudeConfig();
  const timeoutMs = positiveInteger(timeoutArg) ||
    positiveInteger(process.env.ORCHESTRA_CLAUDE_REVIEW_TIMEOUT_MS) ||
    positiveInteger(config.reviewTimeoutMs) ||
    DEFAULT_REVIEW_TIMEOUT_MS;
  let retries = nonNegativeInteger(process.env.ORCHESTRA_CLAUDE_REVIEW_RETRIES);
  if (retries === undefined) retries = nonNegativeInteger(config.reviewRetries);
  if (retries === undefined) retries = DEFAULT_RETRIES;
  retries = Math.min(retries, 1);
  const probeMs = positiveInteger(process.env.ORCHESTRA_CLAUDE_PROBE_TIMEOUT_MS) ||
    positiveInteger(config.probeTimeoutMs) ||
    DEFAULT_PROBE_TIMEOUT_MS;
  const configured = positiveInteger(process.env.ORCHESTRA_MCP_BACKSTOP_MS);
  const calculated = timeoutMs * (retries + 1) + probeMs + 300000;
  return Math.min(configured || calculated, 2147000000);
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function textResult(id, text) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: String(text) }],
      // REVIEW_UNAVAILABLE is a valid lane outcome, not an MCP protocol error.
      isError: false,
    },
  });
}

function oneLine(value) {
  return String(value || '').replace(/[\r\n]+/g, ' / ').trim();
}

function diagnosticTail(value, cap) {
  return boundedDiagnostic(value, cap, cap * 4);
}

function quotedDiagnostic(label, value) {
  const tail = diagnosticTail(value, DIAGNOSTIC_CAP);
  if (!tail) return '';
  return label + '\n' + tail.split(/\r?\n/).map((line) => '> ' + line).join('\n');
}

function unavailableReport(reason, diagnostics) {
  const blocks = (diagnostics || []).filter(Boolean);
  return (
    'REVIEW ENGINE: NONE - no verdict produced (attempted: Claude CLI, cross-vendor)\n' +
    'FINALITY: FINAL (transport completed; no later verdict will be produced by this call)\n\n' +
    'VERDICT: REVIEW_UNAVAILABLE\n\n' +
    'DETAIL\n- Claude review transport: ' + oneLine(boundedDiagnostic(reason, 2000)) + '\n' +
    (blocks.length ? '\nDIAGNOSTICS (bounded and redacted)\n' + blocks.join('\n') + '\n' : '') +
    '\nNEXT\n- Run `node .codex/hooks/orchestra-review.js --doctor`; then retry or use the native OpenAI reviewer and report that Claude did not review.\n'
  );
}

function returnUnavailable(id, reason, diagnostics) {
  textResult(id, unavailableReport(reason, diagnostics));
}

function makeRunDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orchestra-review-mcp-'));
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

function removeRunDir(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function writeInput(dir, name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return file;
}

function requireString(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('missing required string parameter: ' + name);
  }
  return value;
}

function optionalString(args, name, runnerArgs, flag) {
  if (args[name] === undefined || args[name] === null || args[name] === '') return;
  if (typeof args[name] !== 'string') throw new Error(name + ' must be a string');
  runnerArgs.push(flag, args[name]);
}

function buildRunnerArgs(input, dir) {
  const workOrder = requireString(input, 'work_order');
  const executorReport = requireString(input, 'executor_report');
  const args = [
    '--work-order', writeInput(dir, 'work-order.txt', workOrder),
    '--executor-report', writeInput(dir, 'executor-report.txt', executorReport),
  ];
  optionalString(input, 'base_ref', args, '--base-ref');
  optionalString(input, 'head_ref', args, '--head-ref');
  if (input.tier !== undefined) {
    if (!['full', 'inert'].includes(input.tier)) throw new Error('tier must be full or inert');
    args.push('--tier', input.tier);
  }
  if (input.timeout_ms !== undefined) {
    const timeout = positiveInteger(input.timeout_ms);
    if (!timeout) throw new Error('timeout_ms must be a positive integer');
    args.push('--timeout-ms', String(timeout));
  }
  if (input.no_tests !== undefined && typeof input.no_tests !== 'boolean') {
    throw new Error('no_tests must be a boolean');
  }
  if (input.no_tests) args.push('--no-tests');
  if (input.forbid !== undefined) {
    if (!Array.isArray(input.forbid) || input.forbid.some((item) => typeof item !== 'string')) {
      throw new Error('forbid must be an array of strings');
    }
    for (const command of input.forbid) if (command.trim()) args.push('--forbid', command);
  }
  return args;
}

const IN_FLIGHT = new Map();

function killTree(run) {
  if (!run || !run.child || !run.child.pid) return;
  const child = run.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    run.killOutcome = run.killOutcome || 'the runner had already exited';
    run.treeConfirmed = true;
    return;
  }
  const pid = child.pid;
  if (process.platform === 'win32') {
    let confirmed = false;
    let detail = '';
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8',
        timeout: TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
      confirmed = !result.error && result.status === 0;
      detail = result.error ? result.error.message : oneLine(result.stderr || result.stdout);
    } catch (error) {
      detail = error.message;
    }
    try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
    run.treeConfirmed = confirmed;
    run.killOutcome = confirmed
      ? 'taskkill confirmed the runner process tree was stopped'
      : 'taskkill could not confirm the whole tree' + (detail ? ': ' + detail : '');
    return;
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return true;
      try { child.kill(signal); } catch (_) { /* already gone */ }
      return false;
    }
  };
  run.treeConfirmed = signalGroup('SIGKILL');
  run.killOutcome = run.treeConfirmed
    ? 'SIGKILL was sent to the runner process group'
    : 'only the direct runner process could be signalled';
}

function drainInFlight() {
  for (const run of IN_FLIGHT.values()) {
    try { killTree(run); } catch (_) { /* process teardown */ }
    removeRunDir(run.dir);
  }
  IN_FLIGHT.clear();
}

process.on('exit', drainInFlight);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  try {
    process.on(signal, () => {
      drainInFlight();
      process.exit(0);
    });
  } catch (_) { /* signal unavailable on this platform */ }
}

function appendBounded(state, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = OUTPUT_CAP - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  state.chunks.push(bytes.subarray(0, remaining));
  state.bytes += Math.min(bytes.length, remaining);
  if (bytes.length > remaining) state.truncated = true;
}

function runReview(id, runnerArgs, progressToken, dir) {
  if (!fs.existsSync(RUNNER)) {
    removeRunDir(dir);
    returnUnavailable(id, 'review runner is missing at ' + RUNNER);
    return;
  }

  let child;
  try {
    child = spawn(process.execPath, [RUNNER].concat(runnerArgs), {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CODEX_PROJECT_DIR: ROOT }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  } catch (error) {
    removeRunDir(dir);
    returnUnavailable(id, 'runner process could not be spawned: ' + error.message);
    return;
  }

  const run = {
    child,
    dir,
    cancelled: false,
    cancelReason: '',
    killOutcome: '',
    treeConfirmed: false,
    answered: false,
  };
  IN_FLIGHT.set(id, run);
  const stdout = { chunks: [], bytes: 0, truncated: false };
  const stderr = { chunks: [], bytes: 0, truncated: false };
  child.stdout.on('data', (chunk) => appendBounded(stdout, chunk));
  child.stderr.on('data', (chunk) => appendBounded(stderr, chunk));

  const started = Date.now();
  const backstopMs = effectiveBackstopMs(argValue(runnerArgs, '--timeout-ms'));
  let backstopFired = false;
  const backstopTimer = setTimeout(() => {
    backstopFired = true;
    killTree(run);
  }, backstopMs);

  let progressTimer = null;
  if (progressToken !== undefined && progressToken !== null) {
    const progressEvery = positiveInteger(process.env.ORCHESTRA_MCP_PROGRESS_MS) || 30000;
    progressTimer = setInterval(() => {
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: Math.floor((Date.now() - started) / 1000),
          message: 'Claude review runner in progress; the runner owns timeout and retry policy.',
        },
      });
    }, progressEvery);
  }

  function complete(reason, diagnostics, relay) {
    if (run.answered) return;
    run.answered = true;
    clearTimeout(backstopTimer);
    if (progressTimer) clearInterval(progressTimer);
    IN_FLIGHT.delete(id);
    removeRunDir(dir);
    if (relay !== undefined) textResult(id, relay);
    else returnUnavailable(id, reason, diagnostics);
  }

  child.on('error', (error) => {
    complete('runner process failed to launch or crashed at the OS level: ' + error.message);
  });

  child.on('close', (code, signal) => {
    const elapsed = Date.now() - started;
    const out = Buffer.concat(stdout.chunks).toString('utf8');
    const err = Buffer.concat(stderr.chunks).toString('utf8');
    const outDiagnostic = quotedDiagnostic(
      'runner stdout tail' + (stdout.truncated ? ' (capture truncated)' : '') + ':',
      out
    );
    const errDiagnostic = quotedDiagnostic(
      'runner stderr tail' + (stderr.truncated ? ' (capture truncated)' : '') + ':',
      err
    );
    const diagnostics = [outDiagnostic, errDiagnostic];

    if (run.cancelled) {
      const confirmation = run.treeConfirmed ? '' : '; the whole descendant tree could not be confirmed stopped';
      complete(
        'call was cancelled after ' + elapsed + 'ms' +
          (run.cancelReason ? ': ' + run.cancelReason : '') +
          '; ' + (run.killOutcome || 'the runner was signalled') + confirmation,
        diagnostics
      );
      return;
    }
    if (backstopFired) {
      complete(
        'runner exceeded the transport backstop of ' + backstopMs + 'ms and was stopped; ' +
          (run.killOutcome || 'the runner was signalled'),
        diagnostics
      );
      return;
    }
    if (code !== 0 || signal) {
      complete(
        'runner exited abnormally (code=' + code + ', signal=' + (signal || 'none') + ') after ' + elapsed + 'ms',
        diagnostics
      );
      return;
    }
    if (stdout.truncated) {
      complete('runner stdout exceeded the ' + OUTPUT_CAP + '-byte transport capture limit', diagnostics);
      return;
    }
    if (!out.trim()) {
      complete('runner exited 0 after ' + elapsed + 'ms but wrote no report to stdout', diagnostics);
      return;
    }
    const verdicts = out.match(/^VERDICT:\s*(APPROVE|REVISE|REVIEW_UNAVAILABLE)\s*$/gm) || [];
    if (verdicts.length !== 1) {
      complete(
        'runner exited 0 but produced ' + verdicts.length + ' recognized verdict lines; exactly one is required',
        diagnostics
      );
      return;
    }
    complete('', [], out);
  });
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function cancelRun(id, reason) {
  const run = IN_FLIGHT.get(id);
  if (!run) return;
  run.cancelled = true;
  run.cancelReason = typeof reason === 'string' ? oneLine(reason) : '';
  killTree(run);
}

const REVIEW_TOOL = {
  name: 'orchestra_review',
  description:
    'Run one independent Claude CLI review. This call blocks until the complete runner attempt chain closes, ' +
    'then returns the runner report verbatim. Call exactly once. APPROVE and REVISE are Claude verdicts; ' +
    'REVIEW_UNAVAILABLE is final for this call and must be relayed without retry or reinterpretation.',
  annotations: {
    title: 'Run Claude cross-family review',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      work_order: {
        type: 'string',
        description: 'The complete Director work order, verbatim.',
      },
      executor_report: {
        type: 'string',
        description: 'The complete author/executor report, verbatim.',
      },
      base_ref: {
        type: 'string',
        description: 'Commit the reviewed change is measured from. Pass with head_ref when supplied.',
      },
      head_ref: {
        type: 'string',
        description: 'Exact committed review target. Always pass when supplied.',
      },
      tier: {
        type: 'string',
        enum: ['full', 'inert'],
        description: 'Only pass when the order explicitly selects a tier.',
      },
      timeout_ms: {
        type: 'integer',
        minimum: 1,
        description: 'Only pass when the order explicitly sets the per-attempt timeout.',
      },
      no_tests: {
        type: 'boolean',
        description: 'Only true when the order explicitly prohibits tests.',
      },
      forbid: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific commands explicitly prohibited by the order.',
      },
    },
    required: ['work_order', 'executor_report'],
  },
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handleMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  const id = message.id;
  const method = message.method;
  const params = message.params || {};

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '3.0.2' },
          instructions: 'Call orchestra_review exactly once per review. It blocks through runner completion. Relay its text exactly; never reinterpret a verdict or retry REVIEW_UNAVAILABLE.',
        },
      });
      return;
    }
    if (method === 'notifications/initialized') return;
    if (method === 'notifications/cancelled') {
      if (params.requestId !== undefined && params.requestId !== null) {
        cancelRun(params.requestId, params.reason);
      }
      return;
    }
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [REVIEW_TOOL] } });
      return;
    }
    if (method === 'tools/call') {
      if (params.name !== REVIEW_TOOL.name) {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + params.name } });
        return;
      }
      const dir = makeRunDir();
      let runnerArgs;
      try {
        runnerArgs = buildRunnerArgs(params.arguments || {}, dir);
      } catch (error) {
        removeRunDir(dir);
        returnUnavailable(id, 'the call could not be started: ' + error.message);
        return;
      }
      const progressToken = params._meta && params._meta.progressToken;
      runReview(id, runnerArgs, progressToken, dir);
      return;
    }
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    }
  } catch (error) {
    if (id !== undefined) returnUnavailable(id, 'internal transport error: ' + error.message);
  }
}

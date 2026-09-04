#!/usr/bin/env node
'use strict';
/**
 * Regression tests for the blocking reviewer-claude MCP transport.
 * A tiny runner stub exercises process completion independently of Claude.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = process.env.ORCHESTRA_TEST_TRANSPORT ||
  path.join(ROOT, 'packs', 'claude', 'hooks', 'orchestra-review-mcp.js');
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
    console.log('  PASS  ' + name);
  } else {
    failed += 1;
    process.exitCode = 1;
    console.log('  FAIL  ' + name + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''));
  }
}

function section(name) {
  console.log('\n' + name);
}

function makeRunnerDir() {
  const dir = temp('orchestra-review-transport-runner-');
  write(path.join(dir, 'orchestra-review.js'), `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : '';
};
const mode = process.env.STUB_RUNNER_MODE || 'approve';
if (process.env.STUB_RUNNER_RECORD) {
  fs.writeFileSync(process.env.STUB_RUNNER_RECORD, JSON.stringify({
    args,
    workOrder: fs.readFileSync(value('--work-order'), 'utf8'),
    executorReport: fs.readFileSync(value('--executor-report'), 'utf8'),
    cwd: process.cwd(),
    projectDir: process.env.CODEX_PROJECT_DIR || '',
  }, null, 2));
}
if (mode === 'empty') process.exit(0);
if (mode === 'whitespace') { process.stdout.write('  \\r\\n\\t'); process.exit(0); }
if (mode === 'nonzero') {
  console.error('transport failed; Bearer visible-secret-token; ANTHROPIC_API_KEY=sk-ant-visible-secret');
  process.exit(9);
}
if (mode === 'malformed') {
  console.log('ordinary diagnostics with no verdict; OPENAI_API_KEY=sk-visible-secret');
  process.exit(0);
}
if (mode === 'oversize') {
  process.stdout.write('x'.repeat(40000) + '\\nVERDICT: APPROVE\\n');
  process.exit(0);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else {
  const report = mode === 'revise'
    ? 'REVIEW ENGINE: Claude CLI (stub)\\nFINALITY: FINAL\\n\\nVERDICT: REVISE\\n\\nFINDINGS\\n- issue\\n'
    : 'Claude CLI metadata: before\\nREVIEW ENGINE: Claude CLI (stub)\\nFINALITY: FINAL\\n\\nVERDICT: APPROVE\\n\\nFINDINGS\\n- none\\nClaude CLI metadata: after\\n';
  const delay = Number(process.env.STUB_RUNNER_DELAY_MS || 0);
  setTimeout(() => process.stdout.write(report), delay);
}
`);
  return dir;
}

function rpcCall(options) {
  return new Promise((resolve, reject) => {
    const project = options.project || temp('orchestra-review-transport-project-');
    const child = spawn(process.execPath, [SERVER], {
      cwd: project,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        ORCHESTRA_MCP_ROOT: project,
        ORCHESTRA_MCP_HOOKS_DIR: options.hooksDir,
        STUB_RUNNER_MODE: options.mode || 'approve',
      }, options.env || {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const messages = [];

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.stdin.end(); } catch (_) { /* already closed */ }
      try { child.kill(); } catch (_) { /* already closed */ }
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) {
          finish(new Error('invalid JSON-RPC output: ' + line));
          return;
        }
        messages.push(message);
        if (message.id === 0) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'orchestra_review',
              arguments: options.arguments || {
                work_order: 'work order',
                executor_report: 'executor report',
              },
              _meta: { progressToken: 'review-progress' },
            },
          });
          if (options.cancelAfterMs !== undefined) {
            setTimeout(() => send({
              jsonrpc: '2.0',
              method: 'notifications/cancelled',
              params: { requestId: 1, reason: 'test interruption' },
            }), options.cancelAfterMs);
          }
        } else if (message.id === 1) {
          finish(null, { message, messages, stderr });
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (!settled) finish(new Error('MCP server closed before response (code=' + code + '): ' + stderr));
    });
    const timeout = setTimeout(() => finish(new Error('MCP call timed out: ' + stderr)), options.clientTimeoutMs || 10000);
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
  });
}

function textOf(call) {
  return call.message && call.message.result && call.message.result.content &&
    call.message.result.content[0] && call.message.result.content[0].text;
}

function verdictCount(text) {
  return (String(text).match(/^VERDICT:\s*(APPROVE|REVISE|REVIEW_UNAVAILABLE)\s*$/gm) || []).length;
}

async function main() {
  const hooksDir = makeRunnerDir();

  section('1. Valid reports block to process close and relay byte-for-byte');
  const expectedApprove = 'Claude CLI metadata: before\nREVIEW ENGINE: Claude CLI (stub)\nFINALITY: FINAL\n\nVERDICT: APPROVE\n\nFINDINGS\n- none\nClaude CLI metadata: after\n';
  const started = Date.now();
  const approve = await rpcCall({ hooksDir, env: { STUB_RUNNER_DELAY_MS: '150' } });
  check('transport waits for runner close', Date.now() - started >= 125, JSON.stringify(approve.messages));
  check('APPROVE with metadata is relayed verbatim', textOf(approve) === expectedApprove, textOf(approve));
  check('successful tool result is not marked as an MCP error', approve.message.result.isError === false, JSON.stringify(approve.message));
  const revise = await rpcCall({ hooksDir, mode: 'revise' });
  check('REVISE is relayed unchanged', /^VERDICT: REVISE$/m.test(textOf(revise)) && /- issue/.test(textOf(revise)), textOf(revise));

  section('2. Empty, malformed, and abnormal completions fail loud');
  const empty = await rpcCall({ hooksDir, mode: 'empty' });
  check('exit-zero empty stdout becomes REVIEW_UNAVAILABLE', /runner exited 0.+no report/.test(textOf(empty)) && /^VERDICT: REVIEW_UNAVAILABLE$/m.test(textOf(empty)) && verdictCount(textOf(empty)) === 1, textOf(empty));
  const whitespace = await rpcCall({ hooksDir, mode: 'whitespace' });
  check('whitespace-only stdout becomes REVIEW_UNAVAILABLE', /wrote no report/.test(textOf(whitespace)) && verdictCount(textOf(whitespace)) === 1, textOf(whitespace));
  const malformed = await rpcCall({ hooksDir, mode: 'malformed' });
  check('diagnostics without a verdict become REVIEW_UNAVAILABLE', /0 recognized verdict lines/.test(textOf(malformed)) && /ordinary diagnostics/.test(textOf(malformed)) && verdictCount(textOf(malformed)) === 1, textOf(malformed));
  check('malformed diagnostics are redacted', !/sk-visible-secret/.test(textOf(malformed)) && /OPENAI_API_KEY=\[REDACTED\]/.test(textOf(malformed)), textOf(malformed));
  const nonzero = await rpcCall({ hooksDir, mode: 'nonzero' });
  check('nonzero runner exit becomes REVIEW_UNAVAILABLE', /code=9/.test(textOf(nonzero)) && verdictCount(textOf(nonzero)) === 1, textOf(nonzero));
  check('nonzero diagnostics are bounded and redacted', !/visible-secret/.test(textOf(nonzero)) && /Bearer \[REDACTED\]/.test(textOf(nonzero)) && /ANTHROPIC_API_KEY=\[REDACTED\]/.test(textOf(nonzero)), textOf(nonzero));
  const oversize = await rpcCall({ hooksDir, mode: 'oversize' });
  check('capture overflow is unavailable rather than silently truncated', /exceeded the 32768-byte transport capture limit/.test(textOf(oversize)) && verdictCount(textOf(oversize)) === 1, textOf(oversize));
  const missingDir = temp('orchestra-review-transport-missing-');
  const missing = await rpcCall({ hooksDir: missingDir });
  check('missing runner becomes REVIEW_UNAVAILABLE', /review runner is missing/.test(textOf(missing)) && verdictCount(textOf(missing)) === 1, textOf(missing));

  section('3. Timeout and cancellation stop the subprocess and return a report');
  const timeout = await rpcCall({
    hooksDir,
    mode: 'hang',
    env: { ORCHESTRA_MCP_BACKSTOP_MS: '75' },
    clientTimeoutMs: 10000,
  });
  check('transport backstop becomes REVIEW_UNAVAILABLE', /exceeded the transport backstop/.test(textOf(timeout)) && verdictCount(textOf(timeout)) === 1, textOf(timeout));
  const cancelled = await rpcCall({ hooksDir, mode: 'hang', cancelAfterMs: 75, clientTimeoutMs: 10000 });
  check('interrupted call becomes REVIEW_UNAVAILABLE', /call was cancelled/.test(textOf(cancelled)) && /test interruption/.test(textOf(cancelled)) && verdictCount(textOf(cancelled)) === 1, textOf(cancelled));

  section('4. Typed serialization preserves exact content and arguments');
  const project = temp('orchestra-review-transport-project-');
  const record = path.join(temp('orchestra-review-transport-record-'), 'record.json');
  const workOrder = 'Path C:\\Users\\maxtl\\Project; `backticks`; "quotes";\nline two; base 258687598fbc43095537757584e666d9859cc6fe';
  const executorReport = 'Report at D:\\work\\tree\nhead 3b8e0cbb7794d8af008d1dcec560a5fae0ada593';
  const serialized = await rpcCall({
    hooksDir,
    project,
    env: { STUB_RUNNER_RECORD: record },
    arguments: {
      work_order: workOrder,
      executor_report: executorReport,
      base_ref: '258687598fbc43095537757584e666d9859cc6fe',
      head_ref: '3b8e0cbb7794d8af008d1dcec560a5fae0ada593',
      tier: 'inert',
      timeout_ms: 12345,
      no_tests: true,
      forbid: ['npm test', 'echo "quoted"'],
    },
  });
  const seen = JSON.parse(fs.readFileSync(record, 'utf8'));
  check('work order and report survive serialization exactly', seen.workOrder === workOrder && seen.executorReport === executorReport, JSON.stringify(seen));
  check('refs and explicit controls reach the runner as argv values', seen.args.includes('258687598fbc43095537757584e666d9859cc6fe') && seen.args.includes('3b8e0cbb7794d8af008d1dcec560a5fae0ada593') && seen.args.includes('12345') && seen.args.includes('echo "quoted"'), JSON.stringify(seen.args));
  check('runner receives the exact project root without shell quoting', path.resolve(seen.cwd) === path.resolve(project) && path.resolve(seen.projectDir) === path.resolve(project), JSON.stringify(seen));
  check('transport removes serialized temporary inputs after completion', !fs.existsSync(seen.args[seen.args.indexOf('--work-order') + 1]) && !fs.existsSync(seen.args[seen.args.indexOf('--executor-report') + 1]), JSON.stringify(seen.args));
  check('serialized review still relays a valid report', /^VERDICT: APPROVE$/m.test(textOf(serialized)), textOf(serialized));
}

main().catch((error) => {
  check('suite ran to completion', false, error && error.stack ? error.stack : error);
}).finally(() => {
  for (const dir of cleanups.reverse()) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  console.log('\n' + (failed ? 'FAILED' : 'OK') + ' - ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
});

'use strict';

const SERVER = 'orchestra_claude_review';
const TOOL = 'orchestra_review';

function normalizedText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

function reportLike(value) {
  return typeof value === 'string' && /^REVIEW ENGINE:/m.test(value) && /^VERDICT:/m.test(value);
}

function collectStrings(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, output);
}

function identity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (String(item.type || '').toLowerCase() !== 'mcp_tool_call') return null;
  const server = String(item.server || item.server_name || item.mcp_server || '');
  const tool = String(item.tool || item.tool_name || '');
  return server === SERVER && tool === TOOL ? { server, tool } : null;
}

function lifecycle(event) {
  const item = event && event.item;
  const target = identity(item);
  if (!target) return null;
  const eventType = String(event.type || '').toLowerCase();
  const status = String(item.status || '').toLowerCase();
  const phase = eventType === 'item.started' && status === 'in_progress' ? 'started'
    : eventType === 'item.completed' && (status === 'completed' || status === 'success') ? 'completed'
      : '';
  return {
    id: String(item.id || item.call_id || ''),
    phase,
    eventType,
    status,
    item,
  };
}

function parseArgumentValue(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch (_) { return { ok: false, error: 'tool arguments string is not valid JSON' }; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'tool arguments must be an observable JSON object' };
  }
  return { ok: true, value: parsed };
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function observableArguments(items) {
  const parsed = [];
  for (const item of items) {
    for (const key of ['arguments', 'args', 'input']) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      const candidate = parseArgumentValue(item[key]);
      if (!candidate.ok) return candidate;
      parsed.push(candidate.value);
    }
  }
  if (!parsed.length) return { ok: false, error: 'the MCP lifecycle did not expose tool arguments' };
  if (new Set(parsed.map(stable)).size !== 1) {
    return { ok: false, error: 'the MCP start/completion lifecycle exposed divergent tool arguments' };
  }
  return { ok: true, value: parsed[0] };
}

function canonicalReport(completedItem) {
  const strings = [];
  // These are the only result-bearing fields accepted as transport evidence.
  // In particular, do not recursively search the full JSONL stream: Codex's
  // final agent_message intentionally repeats the same report.
  for (const key of ['result', 'output', 'content']) {
    if (Object.prototype.hasOwnProperty.call(completedItem, key)) {
      collectStrings(completedItem[key], strings);
    }
  }
  const reports = strings.filter(reportLike);
  const normalized = Array.from(new Set(reports.map(normalizedText)));
  if (normalized.length !== 1) {
    return { ok: false, error: 'completed MCP result must contain exactly one unique review payload; found ' + normalized.length };
  }
  return { ok: true, report: reports.find((value) => normalizedText(value) === normalized[0]), count: 1 };
}

function finalAgentRelay(events) {
  const messages = [];
  for (const event of events) {
    const item = event && event.item;
    if (String(event && event.type || '').toLowerCase() !== 'item.completed' ||
        !item || String(item.type || '').toLowerCase() !== 'agent_message') continue;
    const strings = [];
    for (const key of ['text', 'message', 'content', 'output']) {
      if (Object.prototype.hasOwnProperty.call(item, key)) collectStrings(item[key], strings);
    }
    const text = strings.filter((value) => value.trim()).join('\n');
    if (text) messages.push(text);
  }
  return messages.length ? messages[messages.length - 1] : '';
}

function fail(stage, error) {
  return { ok: false, stage, error };
}

function analyzeReviewEvents(events, expected) {
  const observations = events.map(lifecycle).filter(Boolean);
  if (!observations.length) return fail('MCP_TOOL_CALL_NOT_OBSERVED', 'no orchestra review MCP lifecycle item was emitted');
  if (observations.some((item) => !item.id || !item.phase)) {
    return fail('MCP_TOOL_CALL_LIFECYCLE', 'orchestra MCP items must expose id, event phase, and matching lifecycle status');
  }
  const started = observations.filter((item) => item.phase === 'started');
  const completed = observations.filter((item) => item.phase === 'completed');
  const ids = new Set(observations.map((item) => item.id));
  if (ids.size !== 1 || started.length !== 1 || completed.length !== 1 || started[0].id !== completed[0].id) {
    return fail(
      'MCP_TOOL_CALL_COUNT',
      'expected one same-ID MCP start/completion lifecycle; observed ' + ids.size +
        ' identities, ' + started.length + ' starts, and ' + completed.length + ' completions'
    );
  }

  const args = observableArguments([started[0].item, completed[0].item]);
  if (!args.ok) return fail('MCP_TOOL_ARGUMENTS', args.error);
  const expectedTimeoutMs = expected && expected.timeoutMs;
  if (args.value.retries !== 0 || args.value.tier !== 'inert' || args.value.no_tests !== true ||
      args.value.timeout_ms !== expectedTimeoutMs) {
    return fail(
      'MCP_TOOL_ARGUMENTS',
      'expected retries=0 (number), tier=inert, no_tests=true, timeout_ms=' + expectedTimeoutMs +
        '; observed ' + JSON.stringify({
          retries: args.value.retries,
          tier: args.value.tier,
          no_tests: args.value.no_tests,
          timeout_ms: args.value.timeout_ms,
        })
    );
  }

  const canonical = canonicalReport(completed[0].item);
  if (!canonical.ok) return fail('MCP_TRANSPORT', canonical.error);
  const relay = finalAgentRelay(events);
  if (!relay) return fail('AGENT_RELAY', 'no completed final agent_message was emitted');
  if (normalizedText(relay) !== normalizedText(canonical.report)) {
    return fail('AGENT_RELAY', 'the final agent_message diverged from the completed MCP result');
  }
  return {
    ok: true,
    id: started[0].id,
    args: args.value,
    report: canonical.report,
    reportCount: canonical.count,
    relayMatches: true,
  };
}

module.exports = { analyzeReviewEvents, normalizedText };

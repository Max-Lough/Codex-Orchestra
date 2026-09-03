#!/usr/bin/env node
/**
 * Codex-Orchestra Director guard.
 *
 * Codex loads this file for SessionStart and PreToolUse from
 * .codex/hooks.json. It injects a compact activation reminder at session
 * start and blocks worker operations in the primary task. Custom Orchestra
 * agent profiles disable hooks in their spawned sessions, so executors and
 * reviewers can use their role-appropriate tools.
 *
 * This is intentionally a guardrail rather than a security boundary. Hosted
 * tools and specialized paths may not traverse local hooks. The protocol in
 * AGENTS.md remains authoritative.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_BASENAME = 'orchestra.json';
const PAUSE_BASENAME = 'orchestra.pause';
const PLANS_DIRNAME = 'plans';

// Canonical Codex names plus compatibility aliases used by local clients.
const BLOCKED = new Set([
  'Bash',
  'PowerShell',
  'shell_command',
  'exec_command',
  'apply_patch',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Grep',
  'Glob',
  'Read',
]);

const EXEC_WRAPPERS = new Set(['functions.exec', 'exec']);
const DIRECTOR_SAFE_NESTED = new Set([
  'update_plan',
  'create_goal',
  'get_goal',
  'update_goal',
]);
const EXTERNAL_WORKER_ROLES = new Set([
  'reviewer-codex-external',
  'executor-codex-external',
  'planner-codex-external',
]);
const FORBIDDEN_EXEC_IDENTIFIERS = new Set([
  'eval',
  'Function',
  'Object',
  'Reflect',
  'Proxy',
  'constructor',
  '__proto__',
  'prototype',
  'process',
  'require',
  'module',
  'WebAssembly',
  'import',
  'fetch',
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'globalThis',
  'this',
]);
const FORBIDDEN_EXEC_MEMBER_STRINGS = new Set(['constructor', '__proto__', 'prototype']);

function writeJson(value) {
  process.stdout.write(JSON.stringify(value));
}

function allow() {
  process.exit(0);
}

function sessionContext(message) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: message,
    },
  });
  process.exit(0);
}

function deny(reason) {
  writeJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

function findProjectRoot(cwd) {
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch (_) {
      return path.resolve(cwd || process.cwd());
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd || process.cwd());
    current = parent;
  }
}

function isPaused(root) {
  if (process.env.ORCHESTRA_PAUSE === '1') return true;
  try {
    return fs.existsSync(path.join(root, '.codex', PAUSE_BASENAME));
  } catch (_) {
    return false;
  }
}

function isSubagent(input) {
  if (input.agent_id || input.agent_type) return true;
  const role = (process.env.ORCHESTRA_ROLE || '').trim().toLowerCase();
  if (EXTERNAL_WORKER_ROLES.has(role)) return true;
  return role !== '' && role !== 'director';
}

function compileRegexes(values) {
  const result = { patterns: [], invalid: false };
  if (values === undefined) return result;
  if (!Array.isArray(values)) {
    result.invalid = true;
    return result;
  }
  for (const value of values) {
    if (typeof value !== 'string') {
      result.invalid = true;
      continue;
    }
    try {
      result.patterns.push(new RegExp(value));
    } catch (_) {
      result.invalid = true;
    }
  }
  return result;
}

function loadPolicy(root) {
  const empty = { blocked: [], allowed: [], planPatterns: [], invalid: false };
  try {
    const file = path.join(root, '.codex', CONFIG_BASENAME);
    if (!fs.existsSync(file)) return empty;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ...empty, invalid: true };
    }
    const blocked = compileRegexes(config.directorBlockedPatterns);
    const plans = compileRegexes(config.directorPlanPatterns);
    const allowedValid =
      config.directorAllowedTools === undefined ||
      (Array.isArray(config.directorAllowedTools) &&
        config.directorAllowedTools.every((value) => typeof value === 'string'));
    return {
      blocked: blocked.patterns,
      allowed: (Array.isArray(config.directorAllowedTools)
        ? config.directorAllowedTools
        : []
      ).filter((value) => typeof value === 'string'),
      planPatterns: plans.patterns,
      invalid: blocked.invalid || plans.invalid || !allowedValid,
    };
  } catch (_) {
    return { ...empty, invalid: true };
  }
}

function normalizeToolInput(toolInput) {
  if (typeof toolInput === 'string') {
    return { source: toolInput, fallback: false };
  }
  if (toolInput && typeof toolInput === 'object') {
    for (const key of ['source', 'code', 'script', 'command']) {
      if (typeof toolInput[key] === 'string') {
        return { source: toolInput[key], fallback: false };
      }
    }
    try {
      return { source: JSON.stringify(toolInput), fallback: true };
    } catch (_) {
      return { source: '', fallback: true };
    }
  }
  return { source: '', fallback: true };
}

function patchOperations(toolInput) {
  const normalized = normalizeToolInput(toolInput);
  if (normalized.fallback || normalized.source === '') return null;
  const command = normalized.source.replace(/\r\n?/g, '\n');
  const lines = command.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (
    lines.length < 3 ||
    lines[0] !== '*** Begin Patch' ||
    lines[lines.length - 1] !== '*** End Patch'
  ) {
    return null;
  }
  const operations = [];
  const pattern = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    operations.push({ action: match[1], file: match[2].trim() });
  }
  if (operations.length === 0) return null;
  const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
  for (let index = 1; index < lines.length - 1; index += 1) {
    if (lines[index].startsWith('*** ') && !fileHeader.test(lines[index])) {
      return null;
    }
  }
  return operations;
}

function projectRelative(root, file) {
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function isContained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function nearestExisting(file) {
  let current = file;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function hasSafePlanTarget(root, file) {
  try {
    const rootReal = fs.realpathSync(root);
    const target = path.resolve(root, file);
    if (!isContained(path.resolve(root), target)) return false;

    const existing = nearestExisting(target);
    if (existing === null) return false;
    if (!isContained(rootReal, fs.realpathSync(existing))) return false;

    const relativeExisting = path.relative(path.resolve(root), existing);
    let cursor = path.resolve(root);
    for (const part of relativeExisting.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return false;
    }

    if (fs.existsSync(target)) {
      const lstat = fs.lstatSync(target);
      if (lstat.isSymbolicLink()) return false;
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.nlink > 1) return false;
      if (!isContained(rootReal, fs.realpathSync(target))) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function isPlanPath(root, file, planPatterns) {
  const relative = projectRelative(root, file);
  if (relative === null) return false;
  const defaultPrefix = '.codex/' + PLANS_DIRNAME + '/';
  const matchesDefault = relative.startsWith(defaultPrefix) && /\.md$/i.test(relative);
  const matchesConfigured = planPatterns.some((pattern) => pattern.test(relative));
  return (matchesDefault || matchesConfigured) && hasSafePlanTarget(root, file);
}

function isPlanPatch(root, toolName, toolInput, planPatterns) {
  if (toolName !== 'apply_patch') return false;
  const operations = patchOperations(toolInput);
  if (operations === null) return false;
  return operations.every(
    (operation) =>
      operation.action !== 'Delete' &&
      isPlanPath(root, operation.file, planPatterns)
  );
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source.startsWith('/*', index)) {
      const close = source.indexOf('*/', index + 2);
      if (close === -1) return -1;
      index = close + 2;
      continue;
    }
    break;
  }
  return index;
}

function readStringLiteral(source, start) {
  const quote = source[start];
  if (!['\'', '"', '`'].includes(quote)) return null;
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      return null;
    }
    if (char !== '\\') {
      if (quote !== '`' && (char === '\n' || char === '\r')) return null;
      value += char;
      index += 1;
      continue;
    }
    index += 1;
    if (index >= source.length) return null;
    const escaped = source[index];
    const simple = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '0': '\0',
    };
    if (Object.prototype.hasOwnProperty.call(simple, escaped)) {
      value += simple[escaped];
      index += 1;
      continue;
    }
    if (escaped === '\n') {
      index += 1;
      continue;
    }
    if (escaped === '\r') {
      index += source[index + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (escaped === 'x') {
      const digits = source.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/i.test(digits)) return null;
      value += String.fromCharCode(parseInt(digits, 16));
      index += 3;
      continue;
    }
    if (escaped === 'u') {
      const digits = source.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(digits)) return null;
      value += String.fromCharCode(parseInt(digits, 16));
      index += 5;
      continue;
    }
    value += escaped;
    index += 1;
  }
  return null;
}

function scanNestedToolCalls(source) {
  const calls = [];
  let error = null;

  function scanCode(start, stopAtBrace) {
    let index = start;
    let braceDepth = 0;
    while (index < source.length) {
      const trivia = skipTrivia(source, index);
      if (trivia === -1) {
        error = 'unterminated comment';
        return source.length;
      }
      index = trivia;
      if (index >= source.length) break;
      const char = source[index];
      if (char === '\'' || char === '"') {
        const literal = readStringLiteral(source, index);
        if (literal === null) {
          error = 'unparseable string literal';
          return source.length;
        }
        const next = skipTrivia(source, literal.end);
        if (source.slice(0, index).trimEnd().endsWith('[') && next !== -1 && source[next] === ']' && FORBIDDEN_EXEC_MEMBER_STRINGS.has(literal.value)) {
          error = 'executable constructor or prototype indirection';
          return source.length;
        }
        index = literal.end;
        continue;
      }
      if (char === '`') {
        index = scanTemplate(index + 1);
        if (error !== null) return source.length;
        continue;
      }
      if (char === '[' || char === ']' || char === '\\') {
        error = 'dynamic member, array, or escaped-identifier syntax';
        return source.length;
      }
      if (char === '{') {
        braceDepth += 1;
        index += 1;
        continue;
      }
      if (char === '}') {
        if (stopAtBrace && braceDepth === 0) return index + 1;
        braceDepth = Math.max(0, braceDepth - 1);
        index += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(char)) {
        const startIdentifier = index;
        index += 1;
        while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
          index += 1;
        }
        const identifier = source.slice(startIdentifier, index);
        if (FORBIDDEN_EXEC_IDENTIFIERS.has(identifier)) {
          error = 'executable indirection or global-object access';
          return source.length;
        }
        if (identifier !== 'tools') continue;
        const dot = skipTrivia(source, index);
        if (dot === -1 || source[dot] !== '.') {
          error = 'dynamic or indirect tools access';
          return source.length;
        }
        const nameStart = skipTrivia(source, dot + 1);
        if (nameStart === -1 || !/[A-Za-z_$]/.test(source[nameStart])) {
          error = 'unparseable nested tool name';
          return source.length;
        }
        let nameEnd = nameStart + 1;
        while (
          nameEnd < source.length &&
          /[A-Za-z0-9_$]/.test(source[nameEnd])
        ) {
          nameEnd += 1;
        }
        const openParen = skipTrivia(source, nameEnd);
        if (openParen === -1 || source[openParen] !== '(') {
          error = 'indirect nested tool call';
          return source.length;
        }
        calls.push({
          name: source.slice(nameStart, nameEnd),
          openParen,
        });
        index = openParen + 1;
        continue;
      }
      index += 1;
    }
    if (stopAtBrace) error = 'unterminated template expression';
    return source.length;
  }

  function scanTemplate(start) {
    let index = start;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === '`') return index + 1;
      if (source[index] === '$' && source[index + 1] === '{') {
        index = scanCode(index + 2, true);
        if (error !== null) return source.length;
        continue;
      }
      index += 1;
    }
    error = 'unterminated template literal';
    return source.length;
  }

  scanCode(0, false);
  return { calls, error };
}

function literalCallArgument(source, call) {
  const start = skipTrivia(source, call.openParen + 1);
  if (start === -1) return null;
  const literal = readStringLiteral(source, start);
  if (literal === null) return null;
  const close = skipTrivia(source, literal.end);
  if (close === -1 || source[close] !== ')') return null;
  return literal.value;
}

function nestedExecAllowed(root, toolInput, planPatterns) {
  const normalized = normalizeToolInput(toolInput);
  if (normalized.fallback || normalized.source === '') return false;
  const scan = scanNestedToolCalls(normalized.source);
  if (scan.error !== null || scan.calls.length === 0) return false;
  for (const call of scan.calls) {
    if (DIRECTOR_SAFE_NESTED.has(call.name)) continue;
    if (call.name !== 'apply_patch') return false;
    const patch = literalCallArgument(normalized.source, call);
    if (patch === null) return false;
    if (!isPlanPatch(root, 'apply_patch', patch, planPatterns)) {
      return false;
    }
  }
  return true;
}

function defaultDenial(toolName) {
  return (
    'Orchestra: the primary task is the Director and does not use ' +
    toolName +
    ' for repository work. Delegate where/what recon to scout, causal recon ' +
    'to detective, edits and commands to executor or a specialist, and ' +
    'verification to reviewer. The Director exception is Markdown under ' +
    '.codex/plans/. The pause switch is user-controlled and out-of-band. ' +
    'See the managed Orchestra block in AGENTS.md.'
  );
}

function policyDenial(toolName) {
  return (
    'Orchestra: project policy in .codex/' +
    CONFIG_BASENAME +
    ' blocks ' +
    toolName +
    ' in the Director task. Delegate the operation to the appropriate ' +
    'subagent; mutating MCP and app calls are execution.'
  );
}

function wrapperDenial() {
  return (
    'Orchestra: functions.exec in the Director task may call only Director ' +
    'planning/goal tools or a literal apply_patch restricted to Markdown ' +
    'under .codex/plans/. ' +
    'Delegate commands, repository reads, external tools, dynamic calls, and ' +
    'unknown nested tools to the appropriate subagent.'
  );
}

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (_) {
    return allow();
  }

  const root = findProjectRoot(input.cwd);
  const event = input.hook_event_name;

  if (event === 'SessionStart') {
    if (isSubagent(input)) return allow();
    if (isPaused(root)) {
      return sessionContext(
        'Orchestra is paused for this project. Do not claim independent ' +
          'Orchestra execution or review unless those stages actually run.'
      );
    }
    return sessionContext(
      'Orchestra is active. This primary task is the Director: coordinate ' +
        'scout, detective, executor, reviewer, and specialists; do not perform ' +
        'repository search, edits, commands, tests, or self-review here. The ' +
        'full protocol is in the managed AGENTS.md block and ' +
        '.codex/ORCHESTRA.md.'
    );
  }

  if (event !== 'PreToolUse') return allow();
  if (isPaused(root) || isSubagent(input)) return allow();

  const toolName = input.tool_name;
  if (typeof toolName !== 'string' || toolName === '') return allow();

  const policy = loadPolicy(root);
  if (policy.invalid) {
    return deny(
      'Orchestra: .codex/orchestra.json contains malformed Director policy. ' +
        'Fix the JSON and ensure directorBlockedPatterns, directorAllowedTools, ' +
        'and directorPlanPatterns are arrays of valid strings.'
    );
  }
  if (EXEC_WRAPPERS.has(toolName)) {
    if (nestedExecAllowed(root, input.tool_input, policy.planPatterns)) {
      return allow();
    }
    return deny(wrapperDenial());
  }
  if (policy.allowed.includes(toolName)) return allow();
  if (isPlanPatch(root, toolName, input.tool_input, policy.planPatterns)) {
    return allow();
  }

  if (BLOCKED.has(toolName)) return deny(defaultDenial(toolName));
  if (policy.blocked.some((pattern) => pattern.test(toolName))) {
    return deny(policyDenial(toolName));
  }
  return allow();
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    main(raw);
  } catch (_) {
    allow();
  }
});

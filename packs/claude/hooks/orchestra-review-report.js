/**
 * Structural validation for the Claude cross-family review report.
 *
 * Both the Claude runner and its MCP relay use this module. It deliberately
 * validates only the report contract, leaving runner/transport ownership,
 * redaction, timeout, and cancellation policy in their respective layers.
 */
'use strict';

const SECTION_NAMES = ['FINDINGS', 'CLAIMS CHECKED', 'VERIFICATION', 'NITS'];
const ALL_STATUSES = ['CONFIRMED', 'REFUTED', 'UNVERIFIED', 'PASS', 'FAIL', 'NOT-RUN'];
const STATUS_NEAR_MISSES = ['OK', 'MAYBE', 'UNKNOWN', 'FAILED', 'SKIPPED'];
const COMPETING_STATUSES = ALL_STATUSES.concat(STATUS_NEAR_MISSES);
const VERDICT_RE = /^VERDICT:\s*(APPROVE|REVISE|REVIEW_UNAVAILABLE)\s*$/;
// Counted headings are common in real reviews. Keep the semantic heading
// closed while accepting `FINDINGS (2)` and `FINDINGS (2 issues)`.
const SECTION_RE = /^(?:#{1,6}\s+)?(FINDINGS|CLAIMS CHECKED|VERIFICATION|NITS)(?:\s*\(\s*\d+(?:\s+[^()\r\n]+)?\s*\))?\s*:?\s*$/;
// A placeholder is only a complete semantic entry. A sentence may mention a
// TODO path or say that one branch was not applicable without becoming empty.
const PLACEHOLDER_MARKER_RE = /^(?:n\/?a|not applicable|tbd|todo|unknown|not provided|placeholder|\.{3}|\[\]|\[(?:n\/?a|not applicable|tbd|todo|unknown|not provided|placeholder)\])$/i;

function lineList(text) {
  return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
}

function meaningful(value) {
  const trimmed = String(value || '').trim();
  return Boolean(trimmed) && !PLACEHOLDER_MARKER_RE.test(trimmed);
}

function concreteEvidence(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return false;
  const core = trimmed
    .replace(/^[\s(:\-\u2013\u2014]+/, '')
    .replace(/[\s)\].,;:\-\u2013\u2014]+$/, '')
    .trim();
  return meaningful(core) && /[A-Za-z0-9]/.test(core);
}

function fenceDelimiter(line) {
  // A fence owned by a top-level `- ` entry may use the list container's two
  // columns plus Markdown's usual three-column fence indent. Keep the bound
  // exact so deeper indentation cannot hide report structure or semantics.
  const match = /^ {0,5}(`{3,}|~{3,})(.*)$/.exec(line);
  return match ? { marker: match[1][0], length: match[1].length, suffix: match[2] } : null;
}

function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let active = null;
  for (let index = 0; index < lines.length; index += 1) {
    const delimiter = fenceDelimiter(lines[index]);
    if (!active) {
      if (delimiter) {
        active = delimiter;
        fenced[index] = true;
      }
      continue;
    }
    fenced[index] = true;
    if (delimiter && delimiter.marker === active.marker &&
        delimiter.length >= active.length && !delimiter.suffix.trim()) {
      active = null;
    }
  }
  return { fenced, closed: !active };
}

function indentation(value) {
  const match = /^[ \t]*/.exec(value);
  // Tabs count as four columns only to compare relative list nesting. The
  // validator does not otherwise reinterpret Markdown indentation.
  return match[0].replace(/\t/g, '    ').length;
}

function listEntries(lines, fenced, start, end, label) {
  const entries = [];
  let current = null;
  let baseIndent = null;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (fenced[index]) {
      if (!current) {
        return { ok: false, error: label + ' cannot begin with a fenced block before its first list entry' };
      }
      current.continuations.push({ line, index, fenced: true });
      continue;
    }

    const bullet = /^(\s*)-\s+(\S.*)$/.exec(line);
    if (bullet) {
      const indent = indentation(bullet[1]);
      if (baseIndent === null) baseIndent = indent;
      if (indent === baseIndent) {
        current = { value: bullet[2].trim(), continuations: [], nested: [], index };
        entries.push(current);
        continue;
      }
      if (current && indent > baseIndent) {
        const nested = { value: bullet[2].trim(), index };
        current.nested.push(nested);
        current.continuations.push({ line, index, fenced: false });
        continue;
      }
    }

    // Wrapped prose and nested structures must remain visibly attached to the
    // preceding top-level entry. A fence itself may be at the base indentation;
    // its contents were already classified above and cannot spoof semantics.
    if (!current || indentation(line) <= baseIndent) {
      return { ok: false, error: label + ' must contain top-level Markdown list entries; found free-floating prose' };
    }
    current.continuations.push({ line, index, fenced: false });
  }
  return entries.length ? { ok: true, entries } : { ok: false, error: label + ' must not be empty' };
}

function semanticEntries(entries) {
  const output = [];
  for (const entry of entries) {
    output.push({ value: entry.value, index: entry.index, topLevel: true });
    for (const nested of entry.nested) output.push({ value: nested.value, index: nested.index, topLevel: false });
  }
  return output;
}

function explicitNoneOrEntries(entries, label, validateEntry) {
  const values = entries.map((entry) => entry.value);
  const none = values.filter((value) => /^none$/i.test(value));
  if (none.length) {
    if (values.length !== 1 || entries[0].nested.some((entry) => meaningful(entry.value))) {
      return { ok: false, error: label + ' cannot mix "none" with entries' };
    }
    return { ok: true, none: true, actionable: false };
  }
  let actionable = false;
  for (const value of values) {
    const result = validateEntry(value);
    if (!result.ok) return result;
    actionable = true;
  }
  return { ok: true, none: false, actionable };
}

function statusConstructs(value, statuses) {
  const alternatives = statuses.map((status) => status.replace('-', '[- ]')).join('|');
  const status = '(?:\\*\\*(?:' + alternatives + ')\\*\\*' +
    '|__(?:' + alternatives + ')__' +
    '|\\*(?:' + alternatives + ')\\*' +
    '|_(?:' + alternatives + ')_' +
    '|`(?:' + alternatives + ')`' +
    '|(?:' + alternatives + '))';
  const matcher = new RegExp('(^|\\s)(->|\\u2192)\\s+(' + status + ')(?=$|\\s)', 'ig');
  const matches = [];
  let match;
  while ((match = matcher.exec(String(value || ''))) !== null) {
    const start = match.index + match[1].length;
    matches.push({
      start,
      end: matcher.lastIndex,
      status: match[3]
        .replace(/^(?:\*\*|__|\*|_|`)/, '')
        .replace(/(?:\*\*|__|\*|_|`)$/, '')
        .toUpperCase()
        .replace(' ', '-'),
    });
  }
  return matches;
}

function diagnosticEntry(entry) {
  return [entry.value].concat(
    entry.continuations
      .filter((continuation) => !continuation.fenced)
      .map((continuation) => continuation.line.trim())
  ).join('\n');
}

function hasOwnedStatusConstruct(entry) {
  if (statusConstructs(entry.value, ALL_STATUSES).length) return true;
  return entry.continuations.some((continuation) =>
    !continuation.fenced && statusConstructs(continuation.line, ALL_STATUSES).length
  );
}

function parseStatusEntry(entry, statuses, label, expectedGrammar) {
  const offendingEntry = diagnosticEntry(entry);
  const candidates = statusConstructs(entry.value, statuses);
  const allCandidates = statusConstructs(entry.value, ALL_STATUSES);
  const competingCandidates = statusConstructs(entry.value, COMPETING_STATUSES);
  if (candidates.length !== 1 || allCandidates.length !== 1 ||
      competingCandidates.length !== 1) {
    return { ok: false, error: label, offendingEntry, expectedGrammar };
  }
  const match = candidates[0];
  const subject = entry.value.slice(0, match.start).trim();
  const inlineEvidence = entry.value.slice(match.end).trim();
  const continuationEvidence = [];
  for (const continuation of entry.continuations) {
    if (continuation.fenced) continue;
    if (statusConstructs(continuation.line, COMPETING_STATUSES).length) {
      return { ok: false, error: label, offendingEntry, expectedGrammar };
    }
    continuationEvidence.push(continuation.line.trim());
  }
  const evidence = [inlineEvidence].concat(continuationEvidence).filter(Boolean).join(' ');
  if (!meaningful(subject) || !concreteEvidence(evidence)) {
    return { ok: false, error: label, offendingEntry, expectedGrammar };
  }
  return { ok: true, subject, status: match.status, evidence };
}

function validateClaudeReport(text) {
  const lines = lineList(text);
  const fenceState = fencedLines(lines);
  if (!fenceState.closed) return { ok: false, error: 'report contains an unclosed fenced code block' };
  const verdicts = [];
  const sections = [];
  lines.forEach((line, index) => {
    if (fenceState.fenced[index]) return;
    if (/^VERDICT\s*:/.test(line)) {
      const verdict = VERDICT_RE.exec(line);
      verdicts.push({ index, verdict: verdict ? verdict[1] : '' });
    }
    const section = SECTION_RE.exec(line);
    if (section) sections.push({ index, name: section[1] });
  });

  if (verdicts.length !== 1) {
    return { ok: false, error: 'expected exactly one verdict line; found ' + verdicts.length };
  }
  const verdict = verdicts[0].verdict;
  if (!verdict) {
    return { ok: false, error: 'VERDICT must be APPROVE, REVISE, or REVIEW_UNAVAILABLE' };
  }
  if (verdict === 'REVIEW_UNAVAILABLE') return validateUnavailable(lines, fenceState.fenced, verdicts[0]);
  if (sections.length !== SECTION_NAMES.length) {
    return { ok: false, error: 'expected exactly one each of FINDINGS, CLAIMS CHECKED, VERIFICATION, and NITS; found ' + sections.length + ' section headings' };
  }
  for (let index = 0; index < SECTION_NAMES.length; index += 1) {
    if (sections[index].name !== SECTION_NAMES[index]) {
      return { ok: false, error: 'sections must appear once in this order: FINDINGS, CLAIMS CHECKED, VERIFICATION, NITS' };
    }
  }
  if (verdicts[0].index >= sections[0].index) {
    return { ok: false, error: 'VERDICT must appear before the report sections' };
  }

  const bodies = {};
  for (let index = 0; index < sections.length; index += 1) {
    const parsed = listEntries(
      lines,
      fenceState.fenced,
      sections[index].index,
      index + 1 < sections.length ? sections[index + 1].index : lines.length,
      sections[index].name
    );
    if (!parsed.ok) return parsed;
    bodies[sections[index].name] = parsed.entries;
  }

  const findings = explicitNoneOrEntries(bodies.FINDINGS, 'FINDINGS', (value) => {
    const match = /^\[(CRITICAL|MAJOR|MINOR)\]\s+(.+)$/.exec(value);
    if (!match || !meaningful(match[2]) || match[2].length < 12) {
      return { ok: false, error: 'FINDINGS entries must be severity-tagged actionable entries' };
    }
    return { ok: true };
  });
  if (!findings.ok) return findings;

  const claimRecords = [];
  for (const entry of bodies['CLAIMS CHECKED']) {
    const parsed = parseStatusEntry(
      entry,
      ['CONFIRMED', 'REFUTED', 'UNVERIFIED'],
      'CLAIMS CHECKED entries must name a claim, an authoritative status, and concrete evidence',
      '<claim> -> CONFIRMED|REFUTED|UNVERIFIED <concrete inline or indented evidence>'
    );
    if (!parsed.ok) return parsed;
    claimRecords.push(parsed);
  }

  const verificationRecords = [];
  for (const entry of bodies.VERIFICATION) {
    const parsed = parseStatusEntry(
      entry,
      ['PASS', 'FAIL', 'NOT-RUN'],
      'VERIFICATION entries must name a real command/check, PASS/FAIL/NOT-RUN, and concrete evidence',
      '<command/check> -> PASS|FAIL|NOT-RUN <concrete inline or indented evidence>'
    );
    if (!parsed.ok) return parsed;
    if (/^(?:none|n\/?a|verification|check)$/i.test(parsed.subject)) {
      return {
        ok: false,
        error: 'VERIFICATION entries must name a real command/check, PASS/FAIL/NOT-RUN, and concrete evidence',
        offendingEntry: diagnosticEntry(entry),
        expectedGrammar: '<command/check> -> PASS|FAIL|NOT-RUN <concrete inline or indented evidence>',
      };
    }
    verificationRecords.push(parsed);
  }

  const nits = explicitNoneOrEntries(bodies.NITS, 'NITS', (value) => {
    return meaningful(value) ? { ok: true } : { ok: false, error: 'NITS entries must be explicit suggestions or "none"' };
  });
  if (!nits.ok) return nits;

  if (bodies.FINDINGS.some(hasOwnedStatusConstruct) || bodies.NITS.some(hasOwnedStatusConstruct)) {
    return { ok: false, error: 'structured claim/check statuses must appear only in CLAIMS CHECKED or VERIFICATION entries' };
  }

  const allSemantic = SECTION_NAMES.flatMap((name) => semanticEntries(bodies[name]));
  for (const entry of allSemantic) {
    if (!meaningful(entry.value)) {
      return { ok: false, error: 'report entries must not use whole-entry placeholders' };
    }
  }
  const blockingSeverity = allSemantic.some((entry) => /^\[(?:CRITICAL|MAJOR)\](?:\s|$)/.test(entry.value));
  const decisiveAdverseStatus = claimRecords.some((entry) => entry.status === 'REFUTED') ||
    verificationRecords.some((entry) => entry.status === 'FAIL');
  const actionableFinding = semanticEntries(bodies.FINDINGS).some((entry) =>
    /^\[(?:CRITICAL|MAJOR|MINOR)\]\s+\S/.test(entry.value)
  );

  if (verdict === 'APPROVE' && (blockingSeverity || decisiveAdverseStatus)) {
    return { ok: false, error: 'APPROVE contradicts a blocking severity or decisive adverse status in the report evidence' };
  }
  if (verdict === 'REVISE' && !actionableFinding && !decisiveAdverseStatus) {
    return { ok: false, error: 'REVISE requires an actionable finding or decisive adverse status' };
  }
  return { ok: true, verdict };
}

function validateUnavailable(lines, fenced, verdict) {
  const hasEngine = lines.some((line, index) => !fenced[index] && /^REVIEW ENGINE: NONE\b/.test(line));
  const hasFinality = lines.some((line, index) => !fenced[index] && /^FINALITY: FINAL\b/.test(line));
  const hasDetail = lines.some((line, index) => !fenced[index] && /^(?:#{1,6}\s+)?DETAIL\s*:?\s*$/.test(line));
  const hasNext = lines.some((line, index) => !fenced[index] && /^(?:#{1,6}\s+)?NEXT\s*:?\s*$/.test(line));
  if (!hasEngine || !hasFinality || !hasDetail || !hasNext || verdict.index < 1) {
    return { ok: false, error: 'REVIEW_UNAVAILABLE must be a complete final unavailable report' };
  }
  return { ok: true, verdict: 'REVIEW_UNAVAILABLE' };
}

module.exports = { validateClaudeReport };

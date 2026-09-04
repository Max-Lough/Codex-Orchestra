'use strict';

const DEFAULT_SCAN_CAP = 256 * 1024;

function redactDiagnostic(value) {
  return String(value || '')
    .replace(
      /((?:["']?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)["']?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|(?:Basic|Bearer)\s+[^\s,;}]+|[^\s,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\b(?:Basic|Bearer)\s+[^\s"']+/gi, (match) => {
      const scheme = match.slice(0, match.indexOf(' '));
      return scheme + ' [REDACTED]';
    })
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\u0000/g, '');
}

function boundedDiagnostic(value, limit, scanCap = DEFAULT_SCAN_CAP) {
  const raw = String(value || '');
  if (raw.length > scanCap) {
    return '[diagnostic omitted: exceeded safe redaction scan cap]';
  }
  const clean = redactDiagnostic(raw).trim();
  if (!clean) return '';
  return clean.length > limit ? '[truncated] ' + clean.slice(-limit) : clean;
}

module.exports = { DEFAULT_SCAN_CAP, boundedDiagnostic, redactDiagnostic };

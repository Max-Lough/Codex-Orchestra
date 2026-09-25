'use strict';

const assert = require('assert');
const { validateClaudeReport } = require('../packs/claude/hooks/orchestra-review-report');
const { reportContractFixtures, reviewReport } = require('./review-report-fixtures');

const fixtures = reportContractFixtures();
let checked = 0;

for (const [name, report] of fixtures.invalid) {
  const result = validateClaudeReport(report);
  assert.strictEqual(result.ok, false, name + ' unexpectedly passed: ' + JSON.stringify(result));
  checked += 1;
}

for (const [name, report, verdict] of fixtures.valid) {
  const result = validateClaudeReport(report);
  assert.deepStrictEqual(result, { ok: true, verdict }, name + ' unexpectedly failed');
  checked += 1;
}

const continuationOnlyEvidence = reviewReport('APPROVE', [
  ['FINDINGS', '- none'],
  ['CLAIMS CHECKED', '- changed export → **CONFIRMED**\n  - read src/app.js:17'],
  ['VERIFICATION', '- node tests/value.test.js -> `PASS`\n  observed exit 0 with 65 passing assertions'],
  ['NITS', '- none'],
]);
assert.deepStrictEqual(
  validateClaudeReport(continuationOnlyEvidence),
  { ok: true, verdict: 'APPROVE' },
  'owned non-fenced continuation evidence should satisfy both structured entries'
);
checked += 1;

const fencedOnlyEvidence = continuationOnlyEvidence
  .replace('  - read src/app.js:17', '  ```text\n  read src/app.js:17\n  ```');
const fencedOnlyResult = validateClaudeReport(fencedOnlyEvidence);
assert.strictEqual(fencedOnlyResult.ok, false, 'fenced evidence must remain inert');
assert.match(fencedOnlyResult.error, /CLAIMS CHECKED entries/);
checked += 1;

const arrows = [
  ['ASCII arrow', '->'],
  ['Unicode arrow', '\u2192'],
];
const wrappers = [
  ['plain status', (status) => status],
  ['bold status', (status) => '**' + status + '**'],
  ['underscore-bold status', (status) => '__' + status + '__'],
  ['italic status', (status) => '*' + status + '*'],
  ['underscore-italic status', (status) => '_' + status + '_'],
  ['code status', (status) => '`' + status + '`'],
];
const evidenceStyles = [
  ['inline evidence', ' (read src/app.js:17)'],
  ['owned prose evidence', '\n  Read src/app.js:17 and observed the concrete result.'],
  ['evidence-only nested bullet', '\n  - read src/app.js:17 and observed the concrete result'],
];

for (const status of ['CONFIRMED', 'UNVERIFIED', 'REFUTED']) {
  for (const [arrowName, arrow] of arrows) {
    for (const [wrapperName, wrap] of wrappers) {
      for (const [evidenceName, evidence] of evidenceStyles) {
        const adverse = status === 'REFUTED';
        const report = reviewReport(adverse ? 'REVISE' : 'APPROVE', [
          ['FINDINGS', '- none'],
          ['CLAIMS CHECKED', '- cross-product claim ' + arrow + ' ' + wrap(status) + evidence],
          ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)'],
          ['NITS', '- none'],
        ]);
        assert.deepStrictEqual(
          validateClaudeReport(report),
          { ok: true, verdict: adverse ? 'REVISE' : 'APPROVE' },
          [status, arrowName, wrapperName, evidenceName].join(' / ')
        );
        checked += 1;
      }
    }
  }
}

for (const status of ['PASS', 'NOT-RUN', 'FAIL']) {
  for (const [arrowName, arrow] of arrows) {
    for (const [wrapperName, wrap] of wrappers) {
      for (const [evidenceName, evidence] of evidenceStyles) {
        const adverse = status === 'FAIL';
        const report = reviewReport(adverse ? 'REVISE' : 'APPROVE', [
          ['FINDINGS', '- none'],
          ['CLAIMS CHECKED', '- cross-product claim -> CONFIRMED (read src/app.js:17)'],
          ['VERIFICATION', '- node tests/value.test.js ' + arrow + ' ' + wrap(status) + evidence],
          ['NITS', '- none'],
        ]);
        assert.deepStrictEqual(
          validateClaudeReport(report),
          { ok: true, verdict: adverse ? 'REVISE' : 'APPROVE' },
          [status, arrowName, wrapperName, evidenceName].join(' / ')
        );
        checked += 1;
      }
    }
  }
}

const ordinaryEvidenceArrows = reviewReport('APPROVE', [
  ['FINDINGS', '- none'],
  ['CLAIMS CHECKED', '- inline mapping is documented -> CONFIRMED (traced API -> JSON mapping)\n- prose mapping is documented -> CONFIRMED\n  Observed input \u2192 output through the expected branch.'],
  ['VERIFICATION', '- dataflow inspection -> PASS\n  - inspected API -> JSON mapping without a competing status'],
  ['NITS', '- none'],
]);
assert.deepStrictEqual(
  validateClaudeReport(ordinaryEvidenceArrows),
  { ok: true, verdict: 'APPROVE' },
  'ordinary arrows in inline, prose-continuation, and nested evidence must remain valid'
);
checked += 1;

const unknownCompetitor = reviewReport('APPROVE', [
  ['FINDINGS', '- none'],
  ['CLAIMS CHECKED', '- claim -> CONFIRMED (read src/app.js:17)\n  competing claim -> UNKNOWN (source unavailable)'],
  ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)'],
  ['NITS', '- none'],
]);
assert.strictEqual(validateClaudeReport(unknownCompetitor).ok, false, 'UNKNOWN competitor must fail closed');
checked += 1;

for (const malformed of ['**CONFIRMED*', '__CONFIRMED_', '*CONFIRMED**', '_CONFIRMED__', '`CONFIRMED']) {
  for (const [, arrow] of arrows) {
    const report = reviewReport('APPROVE', [
      ['FINDINGS', '- none'],
      ['CLAIMS CHECKED', '- malformed wrapper claim ' + arrow + ' ' + malformed + ' (read src/app.js:17)'],
      ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)'],
      ['NITS', '- none'],
    ]);
    assert.strictEqual(validateClaudeReport(report).ok, false, 'malformed wrapper passed: ' + malformed);
    checked += 1;
  }
}

console.log('review report validator: ' + checked + ' semantic cases passed');

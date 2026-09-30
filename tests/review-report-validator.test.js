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

const statusFamilies = [
  ['CLAIMS CHECKED', ['CONFIRMED', 'UNVERIFIED', 'REFUTED'], 'CONFIRMED', 'REFUTED'],
  ['VERIFICATION', ['PASS', 'NOT-RUN', 'FAIL'], 'PASS', 'FAIL'],
];
function reportWithStatus(section, entry, verdict = 'APPROVE') {
  return reviewReport(verdict, [
    ['FINDINGS', '- none'],
    ['CLAIMS CHECKED', section === 'CLAIMS CHECKED' ? entry : '- claim -> CONFIRMED (read src/app.js:17)'],
    ['VERIFICATION', section === 'VERIFICATION' ? entry : '- node tests/value.test.js -> PASS (exit 0)'],
    ['NITS', '- none'],
  ]);
}

// Real Claude output quoted parser inputs as evidence; these are not report statuses.
const quotedEvidenceRegression = reviewReport('APPROVE', [
  ['FINDINGS', '- none'],
  ['CLAIMS CHECKED', '- competing-status detection still works and is stricter than before -> CONFIRMED by probe\n' +
    '  An inline `d -> OK. x` after a CONFIRMED status was accepted at HEAD and is now rejected. `other -> FAILED. y` is rejected.'],
  ['VERIFICATION', '- node tests/review-report-validator.test.js -> PASS. observed exit 0'],
  ['NITS', '- none'],
]);
assert.deepStrictEqual(validateClaudeReport(quotedEvidenceRegression),
  { ok: true, verdict: 'APPROVE' }, 'real quoted-evidence report must remain valid');
checked += 1;

const quotedExamples = [
  '`d -> OK. x` and `other -> FAILED. y`',
  '`example -> FAIL. observed exit 1`',
  '``example `literal` -> REFUTED. read old source``',
  '``example -> `FAILED`. observed exit 1``',
  '`example ``literal`` -> FAIL. observed exit 1`',
];
for (const [section, , positive] of statusFamilies) {
  for (const example of quotedExamples) {
    for (const separator of [' ', '\n  ', '\n  - ']) {
      const entry = '- concrete subject -> ' + positive + '.' + separator + example;
      assert.deepStrictEqual(validateClaudeReport(reportWithStatus(section, entry)),
        { ok: true, verdict: 'APPROVE' }, 'literal code must remain original concrete evidence: ' + entry);
      checked += 1;
    }
  }
  for (const example of ['`quoted -> FAIL. example`', '``quoted -> `FAILED`. example``']) {
    const entry = '- ' + example + ' -> ' + positive + '. ';
    assert.deepStrictEqual(validateClaudeReport(reportWithStatus(section, entry + '[src/app.js:17]')),
      { ok: true, verdict: 'APPROVE' }, 'quoted subjects must preserve original offsets');
    assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry + '[TODO]')).ok, false,
      'offsets must not move subject text into placeholder evidence');
    checked += 2;
  }
  for (const competitor of ['FAIL', 'REFUTED', 'UNKNOWN', 'OK', 'FAILED', 'SKIPPED']) {
    for (const wrap of [(status) => status, (status) => '`' + status + '`']) {
      for (const separator of [' ', '\n  ', '\n  - ']) {
        const entry = '- concrete subject -> ' + positive + '. read src/app.js:17' + separator +
          '`example -> PASS. literal` other -> ' + wrap(competitor) + '. observed exit 1';
        assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
          'unquoted or standalone code status must remain a competitor: ' + entry);
        checked += 1;
      }
    }
  }
  for (const example of ['`other -> FAILED. y', '``other -> FAILED. y`',
    '`other -> FAILED. y``', '\\`other -> FAILED. y\\`']) {
    for (const separator of [' ', '\n  ']) {
      const entry = '- concrete subject -> ' + positive + '. read src/app.js:17' + separator + example;
      assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
        'unmatched or escaped delimiters cannot hide competitors: ' + entry);
      checked += 1;
    }
  }
  for (const entry of [
    '- `literal`-> ' + positive + ' read src/app.js:17',
    '- subject -> `literal` ' + positive + ' read src/app.js:17',
    '- subject -> ' + positive + '`literal` read src/app.js:17',
    '- `literal -> ' + positive + ' read src/app.js:17`',
    '- subject -> ``' + positive + '`` read src/app.js:17',
  ]) {
    assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
      'masking must not assemble an authoritative status: ' + entry);
    checked += 1;
  }
}
for (const section of ['FINDINGS', 'NITS']) {
  for (const example of quotedExamples) {
    for (const separator of [' ', '\n  ', '\n  - ']) {
      const entry = '- ' + (section === 'FINDINGS' ? '[MINOR] ' : '') +
        'Document this parser example:' + separator + example;
      const report = reviewReport('APPROVE', [
        ['FINDINGS', section === 'FINDINGS' ? entry : '- none'],
        ['CLAIMS CHECKED', '- claim -> `CONFIRMED`. read src/app.js:17'],
        ['VERIFICATION', '- node tests/value.test.js -> `PASS`. exit 0'],
        ['NITS', section === 'NITS' ? entry : '- none'],
      ]);
      assert.deepStrictEqual(validateClaudeReport(report), { ok: true, verdict: 'APPROVE' },
        'prose code examples must not become structured statuses: ' + entry);
      checked += 1;
    }
  }
}

// Sentence punctuation must delimit real statuses without supplying missing evidence.
for (const [section, statuses, positive, adverse] of statusFamilies) {
  for (const punctuation of ['.', ',', ';', ':', '!', '?']) {
    for (const status of statuses) {
      const verdict = status === adverse ? 'REVISE' : 'APPROVE';
      for (const [, arrow] of arrows) {
        for (const [, wrap] of wrappers) {
          for (const evidence of [' observed src/app.js:17', '\n  Observed src/app.js:17']) {
            const entry = '- concrete subject ' + arrow + ' ' + wrap(status) + punctuation + evidence;
            assert.deepStrictEqual(
              validateClaudeReport(reportWithStatus(section, entry, verdict)),
              { ok: true, verdict },
              section + ' punctuation and evidence: ' + entry
            );
            checked += 1;
          }
        }
      }
    }

    for (const suffix of ['', ' TODO', ' N/A', ' ...', ' placeholder']) {
      const entry = '- concrete subject -> ' + positive + punctuation + suffix;
      assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
        'punctuation must not supply concrete evidence: ' + entry);
      checked += 1;
    }
    for (const competitor of ['CONFIRMED', 'REFUTED', 'UNVERIFIED', 'PASS', 'FAIL', 'NOT-RUN', 'UNKNOWN', 'OK']) {
      for (const separator of [' ', '\n  ']) {
        const entry = '- concrete subject -> ' + positive + '. read src/app.js:17' +
          separator + 'other result -> ' + competitor + punctuation + ' observed exit 1';
        assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
          'punctuated competing status must fail closed: ' + entry);
        checked += 1;
      }
    }
    const adverseReport = reportWithStatus(section,
      '- concrete subject -> ' + adverse + punctuation + ' observed src/app.js:17');
    const adverseResult = validateClaudeReport(adverseReport);
    assert.strictEqual(adverseResult.ok, false, 'punctuated adverse status cannot approve');
    assert.match(adverseResult.error, /APPROVE contradicts/);
    checked += 1;
  }

  for (const status of [positive, 'UNKNOWN', 'OK']) {
    for (const suffix of ['.glued', ':glued', '-glued', '_glued', 'glued']) {
      const entry = '- concrete subject -> ' + status + suffix + ' read src/app.js:17';
      assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
        'unknown or glued status must fail closed: ' + entry);
      checked += 1;
    }
  }
}

// Bracket wrappers must not turn placeholder markers into concrete evidence.
for (const [section, , positive] of statusFamilies) {
  for (const punctuation of ['', '.', ',', ';', ':', '!', '?']) {
    for (const placeholder of ['N/A', 'NA', 'not applicable', 'TBD', 'TODO', 'unknown', 'not provided', 'placeholder', '...', '']) {
      for (const evidence of ['[' + placeholder + ']', '([' + placeholder + ']).']) {
        for (const separator of [' ', '\n  ']) {
          const entry = '- concrete subject -> ' + positive + punctuation + separator + evidence;
          assert.strictEqual(validateClaudeReport(reportWithStatus(section, entry)).ok, false,
            'wrapped placeholder cannot supply evidence: ' + entry);
          checked += 1;
        }
      }
    }
    for (const evidence of ['[src/app.js:17]', '[TODO.md:12]', '[src/app.js:17] confirms the exported value']) {
      const entry = '- concrete subject -> ' + positive + punctuation + ' ' + evidence;
      assert.deepStrictEqual(validateClaudeReport(reportWithStatus(section, entry)),
        { ok: true, verdict: 'APPROVE' }, 'real bracketed evidence remains valid: ' + entry);
      checked += 1;
    }
  }
}

// Status ownership also applies to punctuated constructs in prose-only sections.
for (const section of ['FINDINGS', 'NITS']) {
  for (const punctuation of ['.', ',', ';', ':', '!', '?']) {
    for (const status of ['CONFIRMED', 'REFUTED', 'UNVERIFIED', 'PASS', 'FAIL', 'NOT-RUN']) {
      for (const [, arrow] of arrows) {
        for (const [, wrap] of wrappers) {
          const construct = 'status ' + arrow + ' ' + wrap(status) + punctuation + ' observed src/app.js:17';
          for (const separator of [' ', '\n  ', '\n  - ']) {
            const entry = '- ' + (section === 'FINDINGS' ? '[MINOR] ' : '') +
              'Concrete prose entry.' + separator + construct;
            const report = reviewReport('APPROVE', [
              ['FINDINGS', section === 'FINDINGS' ? entry : '- none'],
              ['CLAIMS CHECKED', '- claim -> CONFIRMED read src/app.js:17'],
              ['VERIFICATION', '- node tests/value.test.js -> PASS exit 0'],
              ['NITS', section === 'NITS' ? entry : '- none'],
            ]);
            const result = validateClaudeReport(report);
            assert.strictEqual(result.ok, false, 'structured status outside its section: ' + entry);
            assert.match(result.error, /structured claim\/check statuses must appear only/);
            checked += 1;
          }
        }
      }
    }
  }
}

console.log('review report validator: ' + checked + ' semantic cases passed');

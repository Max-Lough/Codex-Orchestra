'use strict';

function reviewReport(verdict, sections) {
  return 'VERDICT: ' + verdict + '\n\n' + sections.map((entry) =>
    '## ' + entry[0] + '\n' + entry[1]
  ).join('\n\n');
}

function reportContractFixtures() {
  const approve = [
    ['FINDINGS', '- none'],
    ['CLAIMS CHECKED', '- author says value changed -> CONFIRMED (read app.js)'],
    ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)'],
    ['NITS', '- none'],
  ];
  const revise = [
    ['FINDINGS', '- [MAJOR] app.js:1 - exported value remains incorrect for callers'],
    ['CLAIMS CHECKED', '- author says value changed -> REFUTED (read app.js)'],
    ['VERIFICATION', '- node tests/value.test.js -> FAIL (expected 2 but received 1)'],
    ['NITS', '- none'],
  ];
  function itemOwnedFenceApprove(indent) {
    const pad = ' '.repeat(indent);
    return reviewReport('APPROVE', [
      approve[0],
      ['CLAIMS CHECKED', approve[1][1] + '\n' +
        pad + '```text\n' +
        pad + 'VERDICT: REVISE\n' +
        pad + '## NITS\n' +
        pad + '- [CRITICAL] fenced example only\n' +
        pad + '- example check -> FAIL (fenced example only)\n' +
        pad + '```'],
      approve[2],
      approve[3],
    ]);
  }
  const invalid = [
    ['bare verdict', 'VERDICT: APPROVE'],
    ['invalid verdict status', reviewReport('MAYBE', approve)],
    ['verdict and findings only', 'VERDICT: APPROVE\n\n## FINDINGS\n- none'],
    ['missing FINDINGS', reviewReport('APPROVE', approve.slice(1))],
    ['missing CLAIMS CHECKED', reviewReport('APPROVE', [approve[0], approve[2], approve[3]])],
    ['missing VERIFICATION', reviewReport('APPROVE', [approve[0], approve[1], approve[3]])],
    ['missing NITS', reviewReport('APPROVE', approve.slice(0, 3))],
    ['empty FINDINGS', reviewReport('APPROVE', [['FINDINGS', ''], approve[1], approve[2], approve[3]])],
    ['empty CLAIMS CHECKED', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', ''], approve[2], approve[3]])],
    ['empty VERIFICATION', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', ''], approve[3]])],
    ['empty NITS', reviewReport('APPROVE', [approve[0], approve[1], approve[2], ['NITS', '']])],
    ['duplicate section', reviewReport('APPROVE', approve.concat([approve[3]]))],
    ['out-of-order sections', reviewReport('APPROVE', [approve[1], approve[0], approve[2], approve[3]])],
    ['invalid claim status', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> MAYBE (read app.js)'], approve[2], approve[3]])],
    ['em dash is not an ASCII claim arrow', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed \u2014 CONFIRMED (read app.js)'], approve[2], approve[3]])],
    ['mismatched claim status wrapper', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> **CONFIRMED* (read app.js)'], approve[2], approve[3]])],
    ['claim status wrapper encloses evidence', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> **CONFIRMED (read app.js)**'], approve[2], approve[3]])],
    ['multiple inline claim statuses', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> CONFIRMED (read app.js) -> REFUTED (read old app.js)'], approve[2], approve[3]])],
    ['competing status in owned claim continuation', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> CONFIRMED (read app.js)\n  another claim \u2192 REFUTED (read old app.js)'], approve[2], approve[3]])],
    ['invalid status in owned claim continuation', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> CONFIRMED (read app.js)\n  another claim -> MAYBE (read old app.js)'], approve[2], approve[3]])],
    ['competing status in nested verification bullet', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)\n  - alternate check -> FAIL (unsafe output)'], approve[3]])],
    ['invalid status in nested verification bullet', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', '- node tests/value.test.js -> PASS (exit 0)\n  - alternate check -> OK (unsafe output)'], approve[3]])],
    ['fenced content cannot supply claim evidence', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed -> CONFIRMED\n  ```text\n  read app.js\n  ```'], approve[2], approve[3]])],
    ['APPROVE with normalized bold refuted claim', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed \u2192 **REFUTED** (read app.js)'], approve[2], approve[3]])],
    ['APPROVE with normalized code failed verification', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', '- node tests/value.test.js \u2192 `FAIL` (expected 2 but received 1)'], approve[3]])],
    ['split nested claim status is not same-line grammar', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', '- author says value changed\n  - -> CONFIRMED (read app.js)'], approve[2], approve[3]])],
    ['invalid claim hidden after a blank line', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', approve[1][1] + '\n\n- hidden claim -> MAYBE (not actually checked)'], approve[2], approve[3]])],
    ['invalid verification status', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', '- node tests/value.test.js -> OK (exit 0)'], approve[3]])],
    ['verification without evidence tail', reviewReport('APPROVE', [approve[0], approve[1], ['VERIFICATION', '- node tests/value.test.js -> PASS'], approve[3]])],
    ['placeholder prose', reviewReport('APPROVE', [approve[0], approve[1], approve[2], ['NITS', '- TODO']])],
    ['free-floating prose inside a section', reviewReport('APPROVE', [approve[0], ['CLAIMS CHECKED', approve[1][1] + '\nthis must be attached to a list entry'], approve[2], approve[3]])],
    ['APPROVE with blocking finding', reviewReport('APPROVE', [revise[0], approve[1], approve[2], approve[3]])],
    ['APPROVE with refuted claim', reviewReport('APPROVE', [approve[0], revise[1], approve[2], approve[3]])],
    ['APPROVE with failed verification', reviewReport('APPROVE', [approve[0], approve[1], revise[2], approve[3]])],
    ['APPROVE with nested blocking finding', reviewReport('APPROVE', [approve[0], approve[1], approve[2], ['NITS', '- naming could improve\n  - [CRITICAL] nested blocker is not merely a naming issue']])],
    ['APPROVE with nested failed status', reviewReport('APPROVE', [approve[0], approve[1], approve[2], ['NITS', '- naming could improve\n  - hidden reproduction -> FAIL (unsafe output observed)']])],
    ['REVISE with none and all-positive evidence', reviewReport('REVISE', approve)],
    ['REVISE with uncertainty only', reviewReport('REVISE', [
      approve[0],
      ['CLAIMS CHECKED', '- author says value changed -> UNVERIFIED (dependency source was unavailable)'],
      ['VERIFICATION', '- node tests/value.test.js -> NOT-RUN (prohibited by the review order)'],
      approve[3],
    ])],
    ['six-space pseudo-fence cannot hide a blocker', itemOwnedFenceApprove(6)],
  ];
  const fencedApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', approve[1][1] + '\n```text\nVERDICT: REVISE\n## NITS\n- [CRITICAL] fenced example only\n```'],
    approve[2],
    approve[3],
  ]);
  const naturalApprove = reviewReport('APPROVE', [
    ['FINDINGS (0)', '- none'],
    ['CLAIMS CHECKED (1 claim)', '- author says value changed -> CONFIRMED as a search, positive as evidence (one definition matched)'],
    ['VERIFICATION (2 checks)', '- repository inspection -> PASS by inspection (read app.js)\n- node tests/value.test.js -> PASS (65 passed) on Node 22'],
    ['NITS (0)', '- none'],
  ]);
  const minorOnlyApprove = reviewReport('APPROVE', [
    ['FINDINGS', '- [MINOR] app.js:1 - a small but actionable defect remains'],
    approve[1],
    approve[2],
    approve[3],
  ]);
  const limitedEvidenceApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', '- author says optional integration works -> UNVERIFIED (external service credentials were unavailable)'],
    ['VERIFICATION', '- node tests/integration.test.js -> NOT-RUN (prohibited by the review order)'],
    approve[3],
  ]);
  const reviseFromNegativeStatus = reviewReport('REVISE', [approve[0], approve[1], revise[2], approve[3]]);
  const unicodeArrowApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', '- author says value changed \u2192 CONFIRMED (read app.js)'],
    approve[2],
    approve[3],
  ]);
  const boldStatusApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', '- author says value changed -> **CONFIRMED** (read app.js)'],
    approve[2],
    approve[3],
  ]);
  const wrappedStatusesApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', '- first claim \u2192 __CONFIRMED__ (read app.js)\n- second claim -> *UNVERIFIED* (dependency was unavailable)'],
    ['VERIFICATION', '- first check -> _PASS_ (exit 0)\n- second check \u2192 `NOT RUN` (prohibited by the review order)'],
    approve[3],
  ]);
  const ownedContinuationApprove = reviewReport('APPROVE', [
    approve[0],
    ['CLAIMS CHECKED', '- author says value changed \u2192 **CONFIRMED**\n  Read app.js and found the updated export.'],
    ['VERIFICATION', '- node tests/value.test.js -> PASS\n  - exit 0 with 65 passing assertions'],
    approve[3],
  ]);
  const normalizedRefutedRevise = reviewReport('REVISE', [
    approve[0],
    ['CLAIMS CHECKED', '- author says value changed \u2192 **REFUTED**\n  Read app.js and found the old export.'],
    approve[2],
    approve[3],
  ]);
  const normalizedFailRevise = reviewReport('REVISE', [
    approve[0],
    approve[1],
    ['VERIFICATION', '- node tests/value.test.js \u2192 `FAIL`\n  - expected 2 but received 1'],
    approve[3],
  ]);
  const realisticMarkdown = reviewReport('REVISE', [
    ['FINDINGS (1 issue)', '- [MAJOR] docs/todo/guide.md:17 - a path named todo still permits the broken behavior\n  The concrete failure is not applicable only after the caller receives a safe result.\n  - nested reproduction evidence is retained with the finding\n  ```text\n  expected: safe\n  actual: unsafe\n  ```'],
    ['CLAIMS CHECKED', '- author says the todo path is safe -> REFUTED (read docs/todo/guide.md)\n  The second paragraph records the inspected condition.'],
    ['VERIFICATION', '- node tests/todo.test.js -> FAIL (the not applicable branch still returns unsafe)\n  - nested output retained for the check'],
    ['NITS', '- none'],
  ]);
  const valid = [
      ['complete APPROVE', reviewReport('APPROVE', approve), 'APPROVE'],
      ['complete REVISE', reviewReport('REVISE', revise), 'REVISE'],
      ['natural status evidence and counted headings', naturalApprove, 'APPROVE'],
      ['fenced structural and blocking tokens are inert', fencedApprove, 'APPROVE'],
      ['MINOR-only findings may APPROVE', minorOnlyApprove, 'APPROVE'],
      ['explained uncertainty and prohibited checks may APPROVE', limitedEvidenceApprove, 'APPROVE'],
      ['four-space item-owned fence is inert', itemOwnedFenceApprove(4), 'APPROVE'],
      ['five-space item-owned fence is inert', itemOwnedFenceApprove(5), 'APPROVE'],
      ['Unicode arrow claim status', unicodeArrowApprove, 'APPROVE'],
      ['bold claim status', boldStatusApprove, 'APPROVE'],
      ['all exact paired status wrappers', wrappedStatusesApprove, 'APPROVE'],
      ['owned prose and evidence-only nested bullet satisfy evidence', ownedContinuationApprove, 'APPROVE'],
      ['normalized wrapped REFUTED supports REVISE', normalizedRefutedRevise, 'REVISE'],
      ['normalized wrapped FAIL supports REVISE', normalizedFailRevise, 'REVISE'],
      ['REVISE with a negative status and no finding', reviseFromNegativeStatus, 'REVISE'],
      ['wrapped and nested Markdown evidence', realisticMarkdown, 'REVISE'],
  ];
  const byName = (items, names) => names.map((name) => {
    const item = items.find((candidate) => candidate[0] === name);
    if (!item) throw new Error('missing report fixture: ' + name);
    return item;
  });
  const integration = {
    invalid: byName(invalid, [
      'missing VERIFICATION',
      'mismatched claim status wrapper',
      'competing status in nested verification bullet',
      'APPROVE with normalized bold refuted claim',
    ]),
    valid: byName(valid, [
      'Unicode arrow claim status',
      'all exact paired status wrappers',
      'owned prose and evidence-only nested bullet satisfy evidence',
      'normalized wrapped REFUTED supports REVISE',
    ]),
  };
  return { approve, revise, invalid, valid, integration };
}

module.exports = { reportContractFixtures, reviewReport };

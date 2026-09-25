#!/usr/bin/env node
'use strict';

const fs = require('fs');
const cp = require('child_process');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.STUB_RECORD) {
    fs.writeFileSync(process.env.STUB_RECORD, JSON.stringify({
      args: process.argv.slice(2),
      prompt,
      role: process.env.ORCHESTRA_ROLE || '',
    }, null, 2));
  }
  if (process.env.STUB_ORPHAN_PID_FILE) {
    const orphan = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    orphan.unref();
    fs.writeFileSync(process.env.STUB_ORPHAN_PID_FILE, String(orphan.pid));
  }
  const mode = process.env.STUB_MODE || 'approve';
  if (mode === 'timeout') return setTimeout(() => {}, 60000);
  if (mode === 'empty') return;
  if (mode === 'duplicate') return console.log('VERDICT: APPROVE\nVERDICT: REVISE');
  if (mode === 'large-valid') {
    return process.stdout.write(
      'VERDICT: APPROVE\n\nRATIONALE\n' + 'x'.repeat(2000000)
    );
  }
  if (mode === 'revise') {
    return console.log(
      'VERDICT: REVISE\n\nCRITIQUE\n1. The sequence omits verification.\n\n' +
      'UPDATED PLAN\n1. Implement.\n2. Verify.'
    );
  }
  console.log('VERDICT: APPROVE\n\nCRITIQUE\n1. The plan is bounded and testable.');
});

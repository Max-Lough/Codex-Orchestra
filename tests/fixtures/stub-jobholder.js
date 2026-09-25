#!/usr/bin/env node
/**
 * Stub Windows job holder for tests/jobrun.test.js.
 *
 * Speaks the same line protocol as the PowerShell holder that
 * packs/codex/hooks/orchestra-jobrun.js writes and drives on Windows, but
 * holds no Job object and kills nothing. Its purpose is to exercise the
 * DRIVER — the half with the ordering, parsing and timeout bugs — on every
 * platform, so the Windows path is not code that only CI on one OS has ever
 * executed.
 *
 * Behaviour knobs (env):
 *   STUB_HOLDER_FATAL        emit `FATAL <text>` instead of READY and exit 1 —
 *                            the "PowerShell could not create the job" shape.
 *   STUB_HOLDER_ASSIGN_ERR   answer ASSIGN with ERR <text>.
 *   STUB_HOLDER_KILL_ERR     answer KILL with ERR <text> (access denied).
 *   STUB_HOLDER_TERM_ERR     answer TERMINATE with ERR <text>.
 *   STUB_HOLDER_MEMBERS      the job's process list, as comma-separated
 *                            `pid|image|started` triples.
 *   STUB_HOLDER_SILENT_ON    a command word (ASSIGN|CENSUS|KILL|TERMINATE) the
 *                            holder deliberately never answers — a wedged
 *                            holder must time the driver out, never hang it.
 *   STUB_HOLDER_LOG          append every command received to this file, so a
 *                            test can assert the driver sent BYE.
 *   STUB_HOLDER_FLAGS        the LimitFlags to report on the READY line
 *                            (default: derived from --kill-on-close, as the
 *                            real holder derives it by reading the kernel
 *                            back). 0x2000 is KILL_ON_JOB_CLOSE.
 */
'use strict';

const fs = require('fs');
const readline = require('readline');

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? '' : argv[i + 1] || '';
}

const jobName = flag('--job-name') || 'stub-job';
const silentOn = (process.env.STUB_HOLDER_SILENT_ON || '').trim().toUpperCase();
const logFile = process.env.STUB_HOLDER_LOG || '';

function say(line) {
  process.stdout.write(line + '\n');
}

function log(line) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {
    /* best effort */
  }
}

if (process.env.STUB_HOLDER_FATAL) {
  say('FATAL ' + process.env.STUB_HOLDER_FATAL);
  process.exit(1);
}

const killOnClose = flag('--kill-on-close') !== '0';
const flags = process.env.STUB_HOLDER_FLAGS || (killOnClose ? '0x2000' : '0x0');
say('READY ' + jobName + ' flags=' + flags);
log('KILL_ON_CLOSE=' + (flag('--kill-on-close') || '1'));

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = String(raw).trim();
  if (!line) return;
  log(line);
  const word = line.split(' ')[0];
  if (word === 'BYE') {
    rl.close();
    process.exit(0);
  }
  if (silentOn && word === silentOn) return; // the wedged-holder case
  let m;
  if ((m = /^ASSIGN (\d+)$/.exec(line))) {
    say(
      'ASSIGNED ' + m[1] +
        (process.env.STUB_HOLDER_ASSIGN_ERR ? ' ERR ' + process.env.STUB_HOLDER_ASSIGN_ERR : ' OK')
    );
  } else if (line === 'CENSUS') {
    for (const entry of (process.env.STUB_HOLDER_MEMBERS || '').split(',')) {
      const t = entry.trim();
      if (t) say('PROC ' + t);
    }
    say('CENSUS-END');
  } else if ((m = /^KILL (\d+)$/.exec(line))) {
    say(
      'KILLED ' + m[1] +
        (process.env.STUB_HOLDER_KILL_ERR ? ' ERR ' + process.env.STUB_HOLDER_KILL_ERR : ' OK')
    );
  } else if (line === 'TERMINATE') {
    say(
      process.env.STUB_HOLDER_TERM_ERR
        ? 'TERMINATED ERR ' + process.env.STUB_HOLDER_TERM_ERR
        : 'TERMINATED OK'
    );
  }
});
rl.on('close', () => process.exit(0));

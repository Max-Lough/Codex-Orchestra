#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;

function check(name, condition, detail = '') {
  if (!condition) {
    process.stderr.write(`not ok - ${name}${detail ? `\n${detail}` : ''}\n`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function hasFiles(directory) {
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) =>
    entry.isFile() || (entry.isDirectory() && hasFiles(path.join(directory, entry.name)))
  );
}

const protocol = read('ORCHESTRA.md');
const installer = read('install.js');
const readme = read('README.md');
const claudePlanRunner = read('packs/claude/hooks/orchestra-ultraplan.js');

check('protocol names Codex as the Director surface', /Codex.+Director|Director.+Codex/is.test(protocol));
check('protocol assigns scouting and execution to OpenAI models', /scout.+GPT-5\.6 Luna/is.test(protocol) && /executor.+GPT-5\.6 Terra/is.test(protocol));
check('OpenAI-authored campaigns route to Claude review', /OpenAI-authored.+reviewer-claude/is.test(protocol));
check('Claude unavailability is fail-loud', /CROSS-FAMILY REVIEW UNAVAILABLE.+Claude did not review/is.test(protocol));
check('campaign review cannot be skipped', /(?:Every campaign must receive|No campaign is done before) at least one\s+independent review/i.test(protocol));
check('reviewEngine opt-out is absent', !/reviewEngine/.test(protocol + readme + installer));

const core = [
  'scout.toml',
  'detective.toml',
  'executor.toml',
  'executor-heavy.toml',
  'executor-heavy-xhigh.toml',
  'reviewer.toml',
];
check('six OpenAI core profiles exist', core.every((name) => fs.existsSync(path.join(ROOT, 'agents', name))));
check('core profiles are TOML rather than Claude markdown profiles', !fs.readdirSync(path.join(ROOT, 'agents')).some((name) => name.endsWith('.md')));
check('Claude reviewer launcher is present in the optional pack', fs.existsSync(path.join(ROOT, 'packs', 'claude', 'agents', 'reviewer-claude.toml')));
check('Claude planning consultation is isolated from a co-installed Claude Director', claudePlanRunner.includes("'--restricted', '--safe-mode'") && claudePlanRunner.includes("ORCHESTRA_ROLE: 'planner-claude-external'"));

check('canonical installer targets .codex', installer.includes("const RECEIPT_REL = '.codex/orchestra-install.json'"));
check('canonical installer explicitly refuses .claude writes', /Refusing a managed path under \.claude/.test(installer));
check('legacy nested Codex source tree is retired', !hasFiles(path.join(ROOT, 'codex')));
check('inverse packs/codex surface is retired', !hasFiles(path.join(ROOT, 'packs', 'codex')));

const skillNames = ['orchestra-plan', 'orchestra-review', 'orchestra-status'];
check('three Codex-scoped orchestration skills exist', skillNames.every((name) => fs.existsSync(path.join(ROOT, 'skills', name, 'SKILL.md'))));
check('active documentation does not advertise Claude as Director', !/Claude (?:Code )?as (?:the )?Director/i.test(protocol + readme));

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} provider-contract checks passed.\n`);

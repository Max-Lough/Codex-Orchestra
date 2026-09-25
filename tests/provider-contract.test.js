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
const claudePackConfig = read('packs/claude/config.toml');
const claudeReviewTransport = read('packs/claude/hooks/orchestra-review-mcp.js');
const guard = read('hooks/orchestra-guard.js');
const claudeReviewRunner = read('packs/claude/hooks/orchestra-review.js');
const claudeVisualRunner = read('packs/claude/hooks/orchestra-visual.js');
const claudeEngineLaunch = read('packs/claude/hooks/orchestra-engine-launch.js');
const planSkill = read('skills/orchestra-plan/SKILL.md');
const reviewSkill = read('skills/orchestra-review/SKILL.md');
const statusSkill = read('skills/orchestra-status/SKILL.md');
const solXhighProfile = read('agents/executor-sol-xhigh.toml');
const workflow = read('.github/workflows/test.yml');

check('protocol names Codex as the Director surface', /Codex.+Director|Director.+Codex/is.test(protocol));
check('protocol defines the Luna/Sol/Astra execution ladder', /Mechanical executor.+GPT-6 Luna.+xhigh/is.test(protocol) && /Standard executor.+GPT-6 Sol.+high/is.test(protocol) && /Heavy executor.+GPT-6 Astra.+high/is.test(protocol) && /Exceptional principal.+GPT-6 Astra.+max/is.test(protocol));
check('Director activation follows the latest model and unknown evidence fails open', /latest primary-session[\s\S]+gpt-6-astra/i.test(protocol) && /later non-Astra model[\s\S]+deactivates/i.test(protocol) && /unknown latest evidence fails open/i.test(protocol) && /classifyTurnContext/.test(guard) && /TRANSCRIPT_CHUNK_BYTES/.test(guard));
check('GPT-authored campaigns route to Claude review', /GPT-authored.+mcp__orchestra_claude_review__orchestra_review/is.test(protocol));
check('Claude unavailability is fail-loud', /CROSS-FAMILY REVIEW UNAVAILABLE.+Claude did not review/is.test(protocol));
check('campaign review cannot be skipped', /(?:Every campaign must receive|No campaign is done before) at least one\s+independent review/i.test(protocol));
check('reviewEngine opt-out is absent', !/reviewEngine/.test(protocol + readme + installer));

const core = [
  'scout.toml',
  'detective.toml',
  'executor-mechanical.toml',
  'executor.toml',
  'executor-sol-xhigh.toml',
  'executor-heavy.toml',
  'executor-heavy-xhigh.toml',
  'executor-principal-max.toml',
  'reviewer.toml',
];
check('nine GPT core profiles exist', core.every((name) => fs.existsSync(path.join(ROOT, 'agents', name))));
check('higher Sol effort has an explicit supported profile', /model = "gpt-6-sol"/.test(solXhighProfile) && /model_reasoning_effort = "xhigh"/.test(solXhighProfile));
check('core profiles are TOML rather than Claude markdown profiles', !fs.readdirSync(path.join(ROOT, 'agents')).some((name) => name.endsWith('.md')));
check('Claude review avoids the broken custom-agent MCP boundary', !fs.existsSync(path.join(ROOT, 'packs', 'claude', 'agents', 'reviewer-claude.toml')) && /project-level MCP block/.test(protocol));
check('Claude reviewer uses one required project-scoped blocking MCP transport', /mcp__orchestra_claude_review__orchestra_review/.test(protocol) && /\[mcp_servers\.orchestra_claude_review\]/.test(claudePackConfig) && /required = true/.test(claudePackConfig));
check('Claude review policy is Opus 5.5 high with typed MCP xhigh selection', /Opus 5\.5 \/ high \(xhigh selectable\)/.test(protocol) && /model: 'opus'/.test(claudeReviewRunner) && /effort: 'high'/.test(claudeReviewRunner) && /enum: \['high', 'xhigh'\]/.test(claudeReviewTransport) && /args\.push\('--effort'/.test(claudeReviewTransport));
check('Claude visual executor is launchable and user-routable', fs.existsSync(path.join(ROOT, 'packs', 'claude', 'agents', 'modeler-claude.toml')) && /Opus 5\.5/.test(claudeVisualRunner) && /executor-claude-visual-external/.test(claudeVisualRunner) && /\['high', 'xhigh'\]/.test(claudeVisualRunner));
check('Claude lanes share safe Windows engine launch construction', [claudeReviewRunner, claudePlanRunner, claudeVisualRunner].every((source) => source.includes("require('./orchestra-engine-launch')")) && claudeEngineLaunch.includes('windowsVerbatimArguments: true') && claudeEngineLaunch.includes('percent characters are not supported'));
check('write-capable visual lane uses process-tree supervision and survivor cleanup', /jobrun\.superviseSync/.test(claudeVisualRunner) && /killSurvivors: cfg\.killSurvivors/.test(claudeVisualRunner));
check('Claude review transport makes empty output fail loud', /!out\.trim\(\)/.test(claudeReviewTransport) && /VERDICT: REVIEW_UNAVAILABLE/.test(claudeReviewTransport));
check('Claude planning consultation is isolated from a co-installed Claude Director', claudePlanRunner.includes("'--restricted', '--safe-mode'") && claudePlanRunner.includes("ORCHESTRA_ROLE: 'planner-claude-external'"));

check('canonical installer targets .codex', installer.includes("const RECEIPT_REL = '.codex/orchestra-install.json'"));
check('canonical installer explicitly refuses .claude writes', /Refusing a managed path under \.claude/.test(installer));
check('legacy nested Codex source tree is retired', !hasFiles(path.join(ROOT, 'codex')));
check('inverse packs/codex surface is retired', !hasFiles(path.join(ROOT, 'packs', 'codex')));

const skillNames = ['orchestra-plan', 'orchestra-review', 'orchestra-status'];
check('three Codex-scoped orchestration skills exist', skillNames.every((name) => fs.existsSync(path.join(ROOT, 'skills', name, 'SKILL.md'))));
check('planning skill exposes the full Luna/Sol/Astra executor ladder', ['executor-mechanical', 'executor', 'executor-sol-xhigh', 'executor-heavy', 'executor-heavy-xhigh', 'executor-principal-max'].every((name) => planSkill.includes(name)));
check('status skill health-checks the full executor ladder and visual pack lane', ['executor-mechanical.toml', 'executor-sol-xhigh.toml', 'executor-principal-max.toml', 'orchestra-engine-launch.js', 'orchestra-visual.js', 'modeler-claude.toml'].every((name) => statusSkill.includes(name)));
check('active skills use GPT authorship and no retired GPT-5.6/Terra ladder labels', !/GPT-5\.6|gpt-5\.6|Terra|OpenAI-authored/.test(planSkill + reviewSkill + statusSkill));
check('Windows CI gates the visual executor regression suite', /node tests\/visual-executor\.test\.js/.test(workflow));
check('active documentation does not advertise Claude as Director', !/Claude (?:Code )?as (?:the )?Director/i.test(protocol + readme));

if (process.exitCode) process.exit(process.exitCode);
process.stdout.write(`\n${passed} provider-contract checks passed.\n`);

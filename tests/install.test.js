#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SOURCE_INSTALLER = path.join(REPO, 'install.js');
const SOURCE_COMPAT = path.join(REPO, 'install-codex.js');
const cleanups = [];
let passed = 0;
let failed = 0;

function temp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function run(master, args, options) {
  return spawnSync(process.execPath, [path.join(master, 'install.js'), ...args], {
    cwd: (options && options.cwd) || master,
    encoding: 'utf8',
  });
}

function runCompat(master, args) {
  return spawnSync(process.execPath, [path.join(master, 'install-codex.js'), ...args], {
    cwd: master,
    encoding: 'utf8',
  });
}

function output(result) {
  return String(result.stdout || '') + String(result.stderr || '');
}

function census(root) {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  };
  walk(root);
  return out.sort();
}

function section(name) {
  console.log('\n' + name);
}

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name);
    if (detail) console.log(String(detail).split('\n').map((line) => '        ' + line).join('\n'));
  }
}

function hookEntry(command, statusMessage) {
  return {
    matcher: '.*',
    hooks: [{ type: 'command', command, commandWindows: command, timeout: 30, statusMessage }],
  };
}

function makeMaster() {
  const root = temp('codex-orchestra-master-');
  fs.copyFileSync(SOURCE_INSTALLER, path.join(root, 'install.js'));
  fs.copyFileSync(SOURCE_COMPAT, path.join(root, 'install-codex.js'));
  write(path.join(root, 'VERSION'), '3.0.0\n');
  write(path.join(root, 'config.toml'), 'model = "gpt-5.6-sol"\n[features]\nhooks = true\n');
  write(path.join(root, 'ORCHESTRA.md'), '# Orchestra\n\n<!-- Installed by the Orchestra harness. -->\n\nCodex directs.\n');
  writeJson(path.join(root, 'hooks.json'), {
    description: 'Codex-Orchestra fixture hooks.',
    hooks: { PreToolUse: [hookEntry('node .codex/hooks/orchestra-guard.js', 'Orchestra guard')] },
  });
  write(path.join(root, 'agents', 'scout.toml'), 'name = "scout"\nmodel = "gpt-5.6-luna"\n');
  write(path.join(root, 'agents', 'executor.toml'), 'name = "executor"\nmodel = "gpt-5.6-terra"\n');
  write(path.join(root, 'agents', 'specialists', 'modeler.toml'), 'name = "modeler"\nmodel = "gpt-5.6-terra"\n');
  write(
    path.join(root, 'hooks', 'orchestra-guard.js'),
    "'use strict'; const fs = require('fs'); console.log(fs.existsSync(__filename) ? 'COMMONJS_OK' : 'NO');\n"
  );
  write(path.join(root, 'skills', 'orchestra-plan', 'SKILL.md'), '# Plan skill\n');
  write(path.join(root, 'skills', 'orchestra-plan', 'references', 'guide.md'), '# Nested guide\n');
  writeJson(path.join(root, 'packs', 'claude', 'pack.json'), {
    name: 'claude',
    title: 'Anthropic review pack',
  });
  write(path.join(root, 'packs', 'claude', 'agents', 'reviewer-claude.toml'), 'name = "reviewer-claude"\nmodel = "claude-opus-4-1"\n');
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-review.js'), "'use strict';\n");
  write(path.join(root, 'packs', 'claude', 'skills', 'cross-compare-plan', 'SKILL.md'), '# Pack skill\n');
  write(path.join(root, 'packs', 'claude', 'skills', 'cross-compare-plan', 'references', 'protocol.md'), '# Protocol\n');
  write(path.join(root, 'packs', '_TEMPLATE', 'pack.json'), '{not selected}\n');
  return root;
}

function ownHookCount(config) {
  let count = 0;
  for (const entries of Object.values(config.hooks || {})) {
    for (const entry of entries) {
      if ((entry.hooks || []).some((hook) => String(hook.command || '').includes('orchestra-guard.js'))) count++;
    }
  }
  return count;
}

function case1_roundTripAndEsm() {
  section('1. Fresh Codex-first install: layout, foreign content, recursive skills, and ESM-safe hooks');
  const master = makeMaster();
  const target = temp('codex-orchestra-target-');
  writeJson(path.join(target, 'package.json'), { type: 'module' });
  write(path.join(target, 'AGENTS.md'), '# User instructions\n\nKeep this.\n');
  const foreign = hookEntry('node tools/foreign.js', 'Foreign hook');
  writeJson(path.join(target, '.codex', 'hooks.json'), { custom: true, hooks: { PostToolUse: [foreign] } });

  const result = run(master, [target, '--no-packs', '--no-specialists']);
  check('fresh install exits zero', result.status === 0, output(result));
  const files = census(target);
  for (const rel of [
    '.codex/agents/scout.toml',
    '.codex/agents/executor.toml',
    '.codex/hooks/orchestra-guard.js',
    '.codex/hooks/package.json',
    '.codex/ORCHESTRA.md',
    '.codex/config.toml',
    '.codex/orchestra-install.json',
    '.agents/skills/orchestra-plan/SKILL.md',
    '.agents/skills/orchestra-plan/references/guide.md',
  ]) check('installed ' + rel, files.includes(rel), files.join('\n'));
  check('installer never creates .claude', !files.some((file) => file === '.claude' || file.startsWith('.claude/')), files.join('\n'));

  const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  check('AGENTS.md preserves foreign text', agents.includes('Keep this.'), agents);
  check('AGENTS.md embeds one managed protocol block', (agents.match(/ORCHESTRA:BEGIN/g) || []).length === 1 && agents.includes('Codex directs.'), agents);
  const hooks = readJson(path.join(target, '.codex', 'hooks.json'));
  check('foreign hooks and top-level keys survive merge', hooks.custom === true && hooks.hooks.PostToolUse.some((entry) => JSON.stringify(entry) === JSON.stringify(foreign)), JSON.stringify(hooks));
  check('source hook is merged once', ownHookCount(hooks) === 1, JSON.stringify(hooks));
  const receipt = readJson(path.join(target, '.codex', 'orchestra-install.json'));
  check('receipt records managed files, hashes, and hook entries', receipt.schemaVersion === 2 && receipt.managedFiles.includes('.codex/agents/scout.toml') && /^[0-9a-f]{64}$/.test(receipt.managedHashes['.codex/agents/scout.toml']) && receipt.managedHooks.length === 1, JSON.stringify(receipt));

  const hookRun = spawnSync(process.execPath, [path.join(target, '.codex', 'hooks', 'orchestra-guard.js')], { cwd: target, encoding: 'utf8' });
  check('CommonJS hook runs beneath a type=module root', hookRun.status === 0 && /COMMONJS_OK/.test(hookRun.stdout), output(hookRun));
  check('generated hook package declares commonjs', readJson(path.join(target, '.codex', 'hooks', 'package.json')).type === 'commonjs', '');
}

function case2_idempotenceAndFirstWriteConfig() {
  section('2. Re-run is idempotent, inherits selections, and never rewrites project config');
  const master = makeMaster();
  const target = temp('codex-orchestra-target-');
  const first = run(master, [target, '--packs', 'claude', '--specialists', 'modeler']);
  check('initial selected install succeeds', first.status === 0, output(first));
  write(path.join(target, '.codex', 'config.toml'), '# user-owned now\ncustom = true\n');
  write(path.join(target, 'AGENTS.md'), fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8') + '\nUser tail.\n');
  const hooks = readJson(path.join(target, '.codex', 'hooks.json'));
  hooks.hooks.UserPromptSubmit = [hookEntry('node tools/user.js', 'User hook')];
  writeJson(path.join(target, '.codex', 'hooks.json'), hooks);

  const second = run(master, [target]);
  check('plain re-run succeeds', second.status === 0, output(second));
  const receipt = readJson(path.join(target, '.codex', 'orchestra-install.json'));
  check('plain re-run inherits pack and specialist selections', JSON.stringify(receipt.packs) === '["claude"]' && JSON.stringify(receipt.specialists) === '["modeler"]', JSON.stringify(receipt));
  check('first-write-only config is byte-preserved', fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8') === '# user-owned now\ncustom = true\n', '');
  const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  check('managed block is not duplicated and user tail survives', (agents.match(/ORCHESTRA:BEGIN/g) || []).length === 1 && agents.includes('User tail.'), agents);
  const hooksAfter = readJson(path.join(target, '.codex', 'hooks.json'));
  check('managed hook is not duplicated and foreign hook survives', ownHookCount(hooksAfter) === 1 && hooksAfter.hooks.UserPromptSubmit.length === 1, JSON.stringify(hooksAfter));

  const compatTarget = temp('codex-orchestra-target-');
  const compat = runCompat(master, [compatTarget, '--no-packs']);
  check('install-codex.js delegates to the canonical installer', compat.status === 0 && fs.existsSync(path.join(compatTarget, '.codex', 'agents', 'scout.toml')), output(compat));
}

function case3DeselectRetireAndUninstall() {
  section('3. Receipt ownership prunes deselected/retired files and uninstall preserves unknown files');
  const master = makeMaster();
  const target = temp('codex-orchestra-target-');
  write(path.join(target, 'AGENTS.md'), '# Foreign AGENTS\n');
  const foreignHook = hookEntry('node foreign.js', 'Foreign');
  writeJson(path.join(target, '.codex', 'hooks.json'), { hooks: { PreToolUse: [foreignHook] } });
  const installed = run(master, [target, '--packs', 'claude', '--specialists', 'modeler']);
  check('selected install succeeds', installed.status === 0, output(installed));
  const retiredTarget = path.join(target, '.codex', 'agents', 'reviewer-claude.toml');
  check('pack agent and nested pack skill installed', fs.existsSync(retiredTarget) && fs.existsSync(path.join(target, '.agents', 'skills', 'cross-compare-plan', 'references', 'protocol.md')), census(target).join('\n'));
  write(path.join(target, '.codex', 'agents', 'user-owned.toml'), 'name = "user-owned"\n');

  fs.unlinkSync(path.join(master, 'packs', 'claude', 'agents', 'reviewer-claude.toml'));
  const update = run(master, [target]);
  check('update after source retirement succeeds', update.status === 0, output(update));
  check('receipt prunes a retired managed file', !fs.existsSync(retiredTarget) && /pruned retired\/deselected managed file/.test(output(update)), output(update));

  const deselect = run(master, [target, '--no-packs', '--no-specialists']);
  check('explicit deselection succeeds', deselect.status === 0, output(deselect));
  check('pack hook, skill, and specialist are removed', !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-review.js')) && !fs.existsSync(path.join(target, '.agents', 'skills', 'cross-compare-plan')) && !fs.existsSync(path.join(target, '.codex', 'agents', 'modeler.toml')), census(target).join('\n'));
  check('unknown adjacent file survives pruning', fs.existsSync(path.join(target, '.codex', 'agents', 'user-owned.toml')), '');

  const uninstall = run(master, [target, '--uninstall']);
  check('uninstall succeeds', uninstall.status === 0, output(uninstall));
  check('all receipt-managed files and receipt are removed', !fs.existsSync(path.join(target, '.codex', 'agents', 'scout.toml')) && !fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')) && !fs.existsSync(path.join(target, '.agents', 'skills', 'orchestra-plan')), census(target).join('\n'));
  check('uninstall preserves unknown agent and config.toml', fs.existsSync(path.join(target, '.codex', 'agents', 'user-owned.toml')) && fs.existsSync(path.join(target, '.codex', 'config.toml')), census(target).join('\n'));
  const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  check('uninstall removes only AGENTS managed block', agents.includes('Foreign AGENTS') && !agents.includes('ORCHESTRA:BEGIN'), agents);
  const hooks = readJson(path.join(target, '.codex', 'hooks.json'));
  check('uninstall removes only its hook entry', hooks.hooks.PreToolUse.length === 1 && JSON.stringify(hooks.hooks.PreToolUse[0]) === JSON.stringify(foreignHook), JSON.stringify(hooks));
  check('uninstall never touches .claude', !fs.existsSync(path.join(target, '.claude')), '');

  const cleanTarget = temp('codex-orchestra-target-');
  run(master, [cleanTarget, '--no-packs']);
  run(master, [cleanTarget, '--uninstall']);
  check('installer-created hooks.json is removed on clean uninstall', !fs.existsSync(path.join(cleanTarget, '.codex', 'hooks.json')), census(cleanTarget).join('\n'));
}

function case4MalformedAtomicityAndCollisions() {
  section('4. Malformed state, receipt tampering, aliases, and unowned collisions refuse safely');
  const master = makeMaster();

  const malformedTarget = temp('codex-orchestra-target-');
  write(path.join(malformedTarget, '.codex', 'hooks.json'), '{broken');
  write(path.join(malformedTarget, 'sentinel.txt'), 'keep');
  const before = census(malformedTarget);
  const malformed = run(master, [malformedTarget]);
  check('malformed target JSON refuses', malformed.status !== 0 && /not valid JSON/.test(output(malformed)), output(malformed));
  check('malformed target refusal is atomic', JSON.stringify(census(malformedTarget)) === JSON.stringify(before), 'before=' + before + ' after=' + census(malformedTarget));

  const badSource = makeMaster();
  write(path.join(badSource, 'packs', 'claude', 'pack.json'), '{broken');
  const untouched = temp('codex-orchestra-target-');
  const sourceFail = run(badSource, [untouched, '--packs', 'claude']);
  check('malformed source pack JSON refuses', sourceFail.status !== 0 && /not valid JSON/.test(output(sourceFail)), output(sourceFail));
  check('malformed source refusal writes nothing', census(untouched).length === 0, census(untouched).join('\n'));

  const markerTarget = temp('codex-orchestra-target-');
  write(path.join(markerTarget, 'AGENTS.md'), '# User\n<!-- ORCHESTRA:BEGIN broken -->\n');
  const markerFail = run(master, [markerTarget]);
  check('unbalanced AGENTS marker refuses before writes', markerFail.status !== 0 && /unbalanced or duplicate/.test(output(markerFail)) && census(markerTarget).length === 1, output(markerFail));

  const collisionTarget = temp('codex-orchestra-target-');
  write(path.join(collisionTarget, '.codex', 'agents', 'scout.toml'), 'name = "mine"\n');
  const collision = run(master, [collisionTarget]);
  check('unowned target collision refuses instead of clobbering', collision.status !== 0 && /unowned target path/.test(output(collision)) && fs.readFileSync(path.join(collisionTarget, '.codex', 'agents', 'scout.toml'), 'utf8') === 'name = "mine"\n', output(collision));

  const tamperedTarget = temp('codex-orchestra-target-');
  write(path.join(tamperedTarget, 'README.md'), '# Do not delete\n');
  writeJson(path.join(tamperedTarget, '.codex', 'orchestra-install.json'), {
    schemaVersion: 1,
    packs: [],
    specialists: [],
    managedFiles: ['README.md'],
    managedHooks: [],
    createdHooksFile: false,
  });
  const tampered = run(master, [tamperedTarget, '--uninstall']);
  check('tampered receipt cannot claim an arbitrary project file', tampered.status !== 0 && /outside Orchestra-managed namespaces/.test(output(tampered)) && fs.readFileSync(path.join(tamperedTarget, 'README.md'), 'utf8') === '# Do not delete\n', output(tampered));

  const traversedTarget = temp('codex-orchestra-target-');
  const traversedContent = '{"keep":true}\n';
  write(path.join(traversedTarget, 'README.json'), traversedContent);
  writeJson(path.join(traversedTarget, '.codex', 'orchestra-install.json'), {
    schemaVersion: 2,
    packs: [],
    specialists: [],
    managedFiles: ['.codex/hooks/../../README.json'],
    managedHashes: { '.codex/hooks/../../README.json': hash(traversedContent) },
    managedHooks: [],
    createdHooksFile: false,
  });
  const traversed = run(master, [traversedTarget, '--uninstall']);
  check('receipt namespaces reject dot-segment traversal before deletion', traversed.status !== 0 && /invalid managed path/.test(output(traversed)) && fs.existsSync(path.join(traversedTarget, 'README.json')), output(traversed));

  const linkedTarget = temp('codex-orchestra-target-');
  const linkedOutside = path.join(linkedTarget, 'outside-agents.md');
  write(linkedOutside, '# outside\n');
  fs.linkSync(linkedOutside, path.join(linkedTarget, 'AGENTS.md'));
  const hardlinkFail = run(master, [linkedTarget]);
  check('hardlinked managed files are refused before mutation', hardlinkFail.status !== 0 && /hardlinked/.test(output(hardlinkFail)) && fs.readFileSync(linkedOutside, 'utf8') === '# outside\n', output(hardlinkFail));

  const configLinkTarget = temp('codex-orchestra-target-');
  const externalConfig = path.join(configLinkTarget, 'project-config.toml');
  write(externalConfig, '# shared project config\ncustom = true\n');
  fs.mkdirSync(path.join(configLinkTarget, '.codex'), { recursive: true });
  fs.linkSync(externalConfig, path.join(configLinkTarget, '.codex', 'config.toml'));
  const configLinkInstall = run(master, [configLinkTarget, '--no-packs']);
  check('existing hardlinked first-write-only config does not cause a partial install', configLinkInstall.status === 0 && fs.existsSync(path.join(configLinkTarget, '.codex', 'agents', 'scout.toml')) && fs.readFileSync(externalConfig, 'utf8') === '# shared project config\ncustom = true\n', output(configLinkInstall));

  const modifiedTarget = temp('codex-orchestra-target-');
  const modifiedInstall = run(master, [modifiedTarget, '--no-packs']);
  const modifiedScout = path.join(modifiedTarget, '.codex', 'agents', 'scout.toml');
  write(modifiedScout, 'name = "locally-modified"\n');
  const modifiedUninstall = run(master, [modifiedTarget, '--uninstall']);
  check('uninstall preserves a managed file changed since installation', modifiedInstall.status === 0 && modifiedUninstall.status === 0 && fs.existsSync(modifiedScout) && /preserved modified or unverifiable managed file/.test(output(modifiedUninstall)), output(modifiedUninstall));

  const aliasTarget = temp('codex-orchestra-target-');
  const aliasOutside = temp('codex-orchestra-outside-');
  let symlinkSupported = true;
  try {
    fs.symlinkSync(aliasOutside, path.join(aliasTarget, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') symlinkSupported = false;
    else throw error;
  }
  if (symlinkSupported) {
    const aliasFail = run(master, [aliasTarget]);
    check('symlink or junction target escapes are refused', aliasFail.status !== 0 && /symlink or junction/.test(output(aliasFail)) && census(aliasOutside).length === 0, output(aliasFail));
  } else {
    check('symlink or junction target escapes are refused (platform skip)', true, '');
  }

  const self = run(master, [master]);
  check('installer refuses its own master as a target', self.status !== 0 && /own master folder/.test(output(self)), output(self));
}

function case6ClaimsPreexistingHookEntries() {
  section('6. Hook entries already on disk are claimed, so uninstall cannot leave a dangling guard');
  // FIELD REPORT: PiratePartyPals carried a hand-placed .codex/hooks.json, so
  // the first install found the Orchestra entries already present, inserted
  // nothing, and recorded managedHooks: []. Every later run found them present
  // too, so the receipt never self-corrected. Uninstall then deleted
  // orchestra-guard.js and left four references to it behind — a SessionStart
  // and a PreToolUse ".*" hook invoking a file that no longer existed.
  const master = makeMaster();
  const target = temp('codex-orchestra-target-');
  const sourceHooks = readJson(path.join(master, 'hooks.json'));
  const preexisting = JSON.parse(JSON.stringify(sourceHooks));
  const foreign = hookEntry('node tools/mine.js', 'My own hook');
  preexisting.hooks.PreToolUse.push(foreign);
  writeJson(path.join(target, '.codex', 'hooks.json'), preexisting);

  const result = run(master, [target, '--no-packs', '--no-specialists']);
  check('install onto pre-existing Orchestra entries exits zero', result.status === 0, output(result));
  const receipt = readJson(path.join(target, '.codex', 'orchestra-install.json'));
  check(
    'the receipt claims the entries it guarantees, not only the ones it inserted',
    receipt.managedHooks.length === 1,
    JSON.stringify(receipt.managedHooks)
  );
  check(
    'claiming does not duplicate the entry',
    ownHookCount(readJson(path.join(target, '.codex', 'hooks.json'))) === 1,
    JSON.stringify(readJson(path.join(target, '.codex', 'hooks.json')))
  );
  check('createdHooksFile stays false — the installer did not create it', receipt.createdHooksFile === false, JSON.stringify(receipt));

  const removed = run(master, [target, '--uninstall']);
  check('uninstall exits zero', removed.status === 0, output(removed));
  check(
    'the guard file is gone',
    !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-guard.js')),
    census(target).join('\n')
  );
  const after = readJson(path.join(target, '.codex', 'hooks.json'));
  check('no hook still points at the deleted guard', ownHookCount(after) === 0, JSON.stringify(after));
  check(
    'the foreign hook is preserved',
    (after.hooks.PreToolUse || []).some((entry) => JSON.stringify(entry) === JSON.stringify(foreign)),
    JSON.stringify(after)
  );
}

function case5LintAndScanUpdate() {
  section('5. Source lint and receipt-based scan/update');
  const master = makeMaster();
  const lint = run(master, ['--lint']);
  check('--lint validates the complete fixture master', lint.status === 0 && /sources are valid/.test(output(lint)), output(lint));

  const scanRoot = temp('codex-orchestra-scan-');
  const project = path.join(scanRoot, 'nested', 'project');
  fs.mkdirSync(project, { recursive: true });
  const initial = run(master, [project, '--packs', 'claude']);
  check('scan fixture install succeeds', initial.status === 0, output(initial));
  write(path.join(master, 'VERSION'), '3.1.0\n');
  const scan = run(master, ['--scan', scanRoot]);
  check('scan reports a behind install and exits one', scan.status === 1 && /BEHIND\s+3\.0\.0/.test(output(scan)), output(scan));
  const update = run(master, ['--scan', scanRoot, '--update']);
  check('scan --update succeeds', update.status === 0, output(update));
  check('scan update retains selection and advances receipt version', readJson(path.join(project, '.codex', 'orchestra-install.json')).version === '3.1.0' && readJson(path.join(project, '.codex', 'orchestra-install.json')).packs.includes('claude'), JSON.stringify(readJson(path.join(project, '.codex', 'orchestra-install.json'))));

  write(path.join(master, 'hooks.json'), '{broken');
  const badLint = run(master, ['--lint']);
  check('--lint fails malformed source JSON', badLint.status !== 0 && /not valid JSON/.test(output(badLint)), output(badLint));
}

try {
  case1_roundTripAndEsm();
  case2_idempotenceAndFirstWriteConfig();
  case3DeselectRetireAndUninstall();
  case4MalformedAtomicityAndCollisions();
  case5LintAndScanUpdate();
  case6ClaimsPreexistingHookEntries();
} catch (error) {
  check('suite completed without an uncaught exception', false, error && error.stack ? error.stack : error);
}

for (const dir of cleanups.reverse()) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ' - ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

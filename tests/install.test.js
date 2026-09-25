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
  write(path.join(root, 'config.toml'), 'model = "gpt-6-astra"\n[features]\nhooks = true\n');
  write(path.join(root, 'ORCHESTRA.md'), '# Orchestra\n\n<!-- Installed by the Orchestra harness. -->\n\nCodex directs.\n');
  writeJson(path.join(root, 'hooks.json'), {
    description: 'Codex-Orchestra fixture hooks.',
    hooks: { PreToolUse: [hookEntry('node .codex/hooks/orchestra-guard.js', 'Orchestra guard')] },
  });
  write(path.join(root, 'agents', 'scout.toml'), 'name = "scout"\nmodel = "gpt-6-luna"\n');
  write(path.join(root, 'agents', 'executor.toml'), 'name = "executor"\nmodel = "gpt-6-sol"\n');
  write(path.join(root, 'agents', 'specialists', 'modeler.toml'), 'name = "modeler"\nmodel = "gpt-6-astra"\n');
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
  write(
    path.join(root, 'packs', 'claude', 'config.toml'),
    '[mcp_servers.orchestra_claude_review]\ncommand = "node"\nargs = [".codex/hooks/orchestra-review-mcp.js"]\n'
  );
  write(path.join(root, 'packs', 'claude', 'agents', 'modeler-claude.toml'), 'name = "modeler-claude"\nmodel = "gpt-6-luna"\n');
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-jobrun.js'), "'use strict';\n");
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-review.js'), "'use strict';\n");
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-review-mcp.js'), "'use strict';\n");
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-ultraplan.js'), "'use strict';\n");
  write(path.join(root, 'packs', 'claude', 'hooks', 'orchestra-visual.js'), "'use strict';\n");
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

function case2_idempotenceAndManagedPackConfig() {
  section('2. Re-run is idempotent, inherits selections, and manages only marked pack config');
  const master = makeMaster();
  const target = temp('codex-orchestra-target-');
  const first = run(master, [target, '--packs', 'claude', '--specialists', 'modeler']);
  check('initial selected install succeeds', first.status === 0, output(first));
  write(
    path.join(target, '.codex', 'config.toml'),
    '# user-owned now\ncustom = true\n\n' +
      '# ORCHESTRA:PACK:claude:BEGIN (managed by Codex-Orchestra)\n' +
      '[mcp_servers.orchestra_claude_review]\ncommand = "stale"\n' +
      '# ORCHESTRA:PACK:claude:END\n'
  );
  write(path.join(target, 'AGENTS.md'), fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8') + '\nUser tail.\n');
  const hooks = readJson(path.join(target, '.codex', 'hooks.json'));
  hooks.hooks.UserPromptSubmit = [hookEntry('node tools/user.js', 'User hook')];
  writeJson(path.join(target, '.codex', 'hooks.json'), hooks);

  const second = run(master, [target]);
  check('plain re-run succeeds', second.status === 0, output(second));
  const receipt = readJson(path.join(target, '.codex', 'orchestra-install.json'));
  check('plain re-run inherits pack and specialist selections', JSON.stringify(receipt.packs) === '["claude"]' && JSON.stringify(receipt.specialists) === '["modeler"]', JSON.stringify(receipt));
  const config = fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8');
  check('user config outside the managed block is preserved', config.includes('# user-owned now\ncustom = true'), config);
  check('managed pack config is refreshed exactly once', (config.match(/ORCHESTRA:PACK:claude:BEGIN/g) || []).length === 1 && config.includes('command = "node"') && !config.includes('command = "stale"'), config);
  const agents = fs.readFileSync(path.join(target, 'AGENTS.md'), 'utf8');
  check('managed block is not duplicated and user tail survives', (agents.match(/ORCHESTRA:BEGIN/g) || []).length === 1 && agents.includes('User tail.'), agents);
  const hooksAfter = readJson(path.join(target, '.codex', 'hooks.json'));
  check('managed hook is not duplicated and foreign hook survives', ownHookCount(hooksAfter) === 1 && hooksAfter.hooks.UserPromptSubmit.length === 1, JSON.stringify(hooksAfter));

  const third = run(master, [target]);
  const thirdConfig = fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8');
  check('second re-run keeps one stable MCP block', third.status === 0 && thirdConfig === config, output(third) + thirdConfig);

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
  check('selected pack installs its project-scoped MCP block', /ORCHESTRA:PACK:claude:BEGIN/.test(fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8')), fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8'));
  const retiredTarget = path.join(target, '.codex', 'agents', 'modeler-claude.toml');
  check('pack agent, supervised review/planning/visual hooks, blocking transport, and nested pack skill installed', fs.existsSync(retiredTarget) && fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-jobrun.js')) && fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-review-mcp.js')) && fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-ultraplan.js')) && fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-visual.js')) && fs.existsSync(path.join(target, '.agents', 'skills', 'cross-compare-plan', 'references', 'protocol.md')), census(target).join('\n'));
  write(path.join(target, '.codex', 'agents', 'user-owned.toml'), 'name = "user-owned"\n');

  fs.unlinkSync(path.join(master, 'packs', 'claude', 'agents', 'modeler-claude.toml'));
  const update = run(master, [target]);
  check('update after source retirement succeeds', update.status === 0, output(update));
  check('receipt prunes a retired managed file', !fs.existsSync(retiredTarget) && /pruned retired\/deselected managed file/.test(output(update)), output(update));

  const deselect = run(master, [target, '--no-packs', '--no-specialists']);
  check('explicit deselection succeeds', deselect.status === 0, output(deselect));
  check('pack hooks, skill, and specialist are removed', !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-jobrun.js')) && !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-review.js')) && !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-review-mcp.js')) && !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-ultraplan.js')) && !fs.existsSync(path.join(target, '.codex', 'hooks', 'orchestra-visual.js')) && !fs.existsSync(path.join(target, '.agents', 'skills', 'cross-compare-plan')) && !fs.existsSync(path.join(target, '.codex', 'agents', 'modeler.toml')), census(target).join('\n'));
  check('pack deselection removes only its managed config block', !/ORCHESTRA:PACK:claude/.test(fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8')) && /gpt-6-astra/.test(fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8')), fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8'));
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

  const malformedConfigTarget = temp('codex-orchestra-target-');
  write(path.join(malformedConfigTarget, '.codex', 'config.toml'), '# ORCHESTRA:PACK:claude:BEGIN (managed by Codex-Orchestra)\n[mcp_servers.orchestra_claude_review]\n');
  write(path.join(malformedConfigTarget, 'sentinel.txt'), 'keep');
  const malformedConfigBefore = census(malformedConfigTarget);
  const malformedConfig = run(master, [malformedConfigTarget, '--packs', 'claude']);
  check('unclosed managed config block refuses before writes', malformedConfig.status !== 0 && /unclosed Orchestra pack config block/.test(output(malformedConfig)), output(malformedConfig));
  check('managed config refusal is atomic', JSON.stringify(census(malformedConfigTarget)) === JSON.stringify(malformedConfigBefore), census(malformedConfigTarget).join('\n'));

  const duplicateConfigTarget = temp('codex-orchestra-target-');
  write(path.join(duplicateConfigTarget, '.codex', 'config.toml'), '[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n');
  const duplicateConfig = run(master, [duplicateConfigTarget, '--packs', 'claude']);
  check('foreign duplicate MCP table refuses before writes', duplicateConfig.status !== 0 && /duplicate TOML table/.test(output(duplicateConfig)), output(duplicateConfig));
  check('foreign duplicate refusal does not create a receipt', !fs.existsSync(path.join(duplicateConfigTarget, '.codex', 'orchestra-install.json')), census(duplicateConfigTarget).join('\n'));

  const tomlCollisionFixtures = [
    ['quoted table keys', '[mcp_servers."orchestra_claude_review"]\ncommand = "mine"\n'],
    ['literal quoted table key', "[mcp_servers.'orchestra_claude_review']\ncommand = \"mine\"\n"],
    ['escaped basic table key', '[mcp_servers."orchestra\\u005fclaude_review"]\ncommand = "mine"\n'],
    ['quoted parent key', '["mcp_servers".orchestra_claude_review]\ncommand = "mine"\n'],
    ['whitespace table keys', '[ mcp_servers . orchestra_claude_review ] # mine\ncommand = "mine"\n'],
    ['array table', '[[mcp_servers.orchestra_claude_review]]\ncommand = "mine"\n'],
    ['root dotted assignment', 'mcp_servers.orchestra_claude_review.command = "mine"\n'],
    ['table-scoped inline value', '[mcp_servers]\norchestra_claude_review = { command = "mine" }\n'],
  ];
  for (const [name, config] of tomlCollisionFixtures) {
    const target = temp('codex-orchestra-target-');
    const configFile = path.join(target, '.codex', 'config.toml');
    write(configFile, config);
    write(path.join(target, 'sentinel.txt'), 'keep\n');
    const before = census(target);
    const result = run(master, [target, '--packs', 'claude']);
    check(
      'TOML collision (' + name + ') refuses before writes',
      result.status !== 0 && /already defines the Orchestra Claude review transport/.test(output(result)),
      output(result)
    );
    check(
      'TOML collision (' + name + ') preserves config and target tree',
      fs.readFileSync(configFile, 'utf8') === config && JSON.stringify(census(target)) === JSON.stringify(before) && !fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')),
      census(target).join('\n')
    );
  }

  const multilineDelimiterCollisionFixtures = [
    ['four double quotes', 'notes = """he said """"\n[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n'],
    ['five double quotes', 'notes = """he said """""\n[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n'],
    ['four single quotes', "notes = '''he said ''''\n[mcp_servers.orchestra_claude_review]\ncommand = \"mine\"\n"],
    ['five single quotes', "notes = '''he said '''''\n[mcp_servers.orchestra_claude_review]\ncommand = \"mine\"\n"],
  ];
  for (const [name, config] of multilineDelimiterCollisionFixtures) {
    const target = temp('codex-orchestra-target-');
    const configFile = path.join(target, '.codex', 'config.toml');
    write(configFile, config);
    write(path.join(target, 'sentinel.txt'), 'keep\n');
    const before = census(target);
    const result = run(master, [target, '--packs', 'claude']);
    check(
      'TOML collision after legal multiline delimiter (' + name + ') refuses before writes',
      result.status !== 0 && /already defines the Orchestra Claude review transport/.test(output(result)),
      output(result)
    );
    check(
      'multiline delimiter collision (' + name + ') preserves config and target tree',
      fs.readFileSync(configFile, 'utf8') === config && JSON.stringify(census(target)) === JSON.stringify(before) && !fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')),
      census(target).join('\n')
    );
  }

  const genericPackTarget = temp('codex-orchestra-target-');
  const genericPackConfig = path.join(genericPackTarget, '.codex', 'config.toml');
  const genericMaster = makeMaster();
  writeJson(path.join(genericMaster, 'packs', 'synthetic', 'pack.json'), { name: 'synthetic', title: 'Synthetic config pack' });
  write(path.join(genericMaster, 'packs', 'synthetic', 'config.toml'), '[mcp_servers.foo]\ncommand = "pack"\n');
  const genericCollision = '[mcp_servers."foo"]\ncommand = "user"\n';
  write(genericPackConfig, genericCollision);
  write(path.join(genericPackTarget, 'sentinel.txt'), 'keep\n');
  const genericBefore = census(genericPackTarget);
  const genericRefusal = run(genericMaster, [genericPackTarget, '--packs', 'synthetic']);
  check('generic pack duplicate table refuses before writes', genericRefusal.status !== 0 && /already defines \[mcp_servers.foo\]/.test(output(genericRefusal)), output(genericRefusal));
  check('generic pack duplicate table keeps config byte-identical and creates no receipt', fs.readFileSync(genericPackConfig, 'utf8') === genericCollision && JSON.stringify(census(genericPackTarget)) === JSON.stringify(genericBefore) && !fs.existsSync(path.join(genericPackTarget, '.codex', 'orchestra-install.json')), census(genericPackTarget).join('\n'));

  const genericControlTarget = temp('codex-orchestra-target-');
  write(path.join(genericControlTarget, '.codex', 'config.toml'), '[mcp_servers.bar]\ncommand = "user"\n');
  const genericControl = run(genericMaster, [genericControlTarget, '--packs', 'synthetic']);
  check('generic pack non-conflicting sibling table installs normally', genericControl.status === 0 && fs.readFileSync(path.join(genericControlTarget, '.codex', 'config.toml'), 'utf8').includes('[mcp_servers.foo]') && fs.existsSync(path.join(genericControlTarget, '.codex', 'orchestra-install.json')), output(genericControl));

  const parentTableTarget = temp('codex-orchestra-target-');
  write(path.join(parentTableTarget, '.codex', 'config.toml'), '[mcp_servers]\nother = 1\n');
  const parentTableInstall = run(master, [parentTableTarget, '--packs', 'claude']);
  check(
    'an existing explicit parent table with another value accepts the pack child table',
    parentTableInstall.status === 0 && /\[mcp_servers\.orchestra_claude_review\]/.test(fs.readFileSync(path.join(parentTableTarget, '.codex', 'config.toml'), 'utf8')),
    output(parentTableInstall)
  );

  const hierarchyMaster = makeMaster();
  writeJson(path.join(hierarchyMaster, 'packs', 'alpha-child', 'pack.json'), { name: 'alpha-child', title: 'Child table pack' });
  write(path.join(hierarchyMaster, 'packs', 'alpha-child', 'config.toml'), '[services.child]\ncommand = "child"\n');
  writeJson(path.join(hierarchyMaster, 'packs', 'zeta-parent', 'pack.json'), { name: 'zeta-parent', title: 'Parent table pack' });
  write(path.join(hierarchyMaster, 'packs', 'zeta-parent', 'config.toml'), '[services]\nother = 1\n');
  const hierarchyTarget = temp('codex-orchestra-target-');
  const hierarchyInstall = run(hierarchyMaster, [hierarchyTarget, '--packs', 'alpha-child,zeta-parent']);
  check(
    'a pack child table followed by an explicit parent table remains legal',
    hierarchyInstall.status === 0 && /\[services\.child\]/.test(fs.readFileSync(path.join(hierarchyTarget, '.codex', 'config.toml'), 'utf8')) && /\[services\]/.test(fs.readFileSync(path.join(hierarchyTarget, '.codex', 'config.toml'), 'utf8')),
    output(hierarchyInstall)
  );
  const childBeforeParentTarget = temp('codex-orchestra-target-');
  write(path.join(childBeforeParentTarget, '.codex', 'config.toml'), '[services.child]\ncommand = "user"\n');
  const childBeforeParent = run(hierarchyMaster, [childBeforeParentTarget, '--packs', 'zeta-parent']);
  check('an existing child table followed by a pack parent table remains legal', childBeforeParent.status === 0, output(childBeforeParent));

  const valuePrefixFixtures = [
    ['root inline table', 'mcp_servers = { other = { command = "mine" } }\n'],
    ['root scalar value', 'mcp_servers = "mine"\n'],
    ['descendant dotted value', 'mcp_servers.orchestra_claude_review.command = "mine"\n'],
    ['root descendant transport value', 'mcp_servers.orchestra_claude_review.transport = "mine"\n'],
    ['table-scoped inline value', '[mcp_servers]\norchestra_claude_review = { command = "mine" }\n'],
    ['table-scoped descendant environment value', '[mcp_servers]\norchestra_claude_review.env.TOKEN = "mine"\n'],
  ];
  for (const [name, config] of valuePrefixFixtures) {
    const target = temp('codex-orchestra-target-');
    const configFile = path.join(target, '.codex', 'config.toml');
    write(configFile, config);
    write(path.join(target, 'sentinel.txt'), 'keep\n');
    const before = census(target);
    const result = run(master, [target, '--packs', 'claude']);
    check('value-prefix TOML collision (' + name + ') refuses atomically',
      result.status !== 0 && JSON.stringify(census(target)) === JSON.stringify(before) &&
        fs.readFileSync(configFile, 'utf8') === config && !fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')),
      output(result));
  }

  const collectionControlTarget = temp('codex-orchestra-target-');
  const collectionControlConfig = 'allow = [\n  ["mcp_servers"]\n]\norchestra_claude_review.command = "mine"\n';
  write(path.join(collectionControlTarget, '.codex', 'config.toml'), collectionControlConfig);
  const collectionControl = run(master, [collectionControlTarget, '--packs', 'claude']);
  check(
    'a nested one-element array is not mistaken for a table header',
    collectionControl.status === 0 && fs.readFileSync(path.join(collectionControlTarget, '.codex', 'config.toml'), 'utf8').startsWith(collectionControlConfig),
    output(collectionControl)
  );

  const collectionResumptionFixtures = [
    ['nested array closes before a real declaration', 'allow = [\n  ["mcp_servers"]\n]\n[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n'],
    ['brackets in a comment do not open a collection', '# [ {\n[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n'],
    ['brackets in a multiline string do not open a collection', 'notes = """\n[ {\n"""\n[mcp_servers.orchestra_claude_review]\ncommand = "mine"\n'],
  ];
  for (const [name, config] of collectionResumptionFixtures) {
    const target = temp('codex-orchestra-target-');
    const configFile = path.join(target, '.codex', 'config.toml');
    write(configFile, config);
    write(path.join(target, 'sentinel.txt'), 'keep\n');
    const before = census(target);
    const result = run(master, [target, '--packs', 'claude']);
    check(
      'TOML scanner resumes after ' + name,
      result.status !== 0 && /already defines the Orchestra Claude review transport/.test(output(result)) &&
        fs.readFileSync(configFile, 'utf8') === config && JSON.stringify(census(target)) === JSON.stringify(before) &&
        !fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')),
      output(result)
    );
  }

  const crossPackMaster = makeMaster();
  for (const name of ['alpha', 'beta']) {
    writeJson(path.join(crossPackMaster, 'packs', name, 'pack.json'), { name, title: name + ' pack' });
    write(path.join(crossPackMaster, 'packs', name, 'config.toml'), '[services.shared]\n' + name + ' = true\n');
  }
  const crossPackTarget = temp('codex-orchestra-target-');
  write(path.join(crossPackTarget, 'sentinel.txt'), 'keep\n');
  const crossPackBefore = census(crossPackTarget);
  const crossPackCollision = run(crossPackMaster, [crossPackTarget, '--packs', 'alpha,beta']);
  check(
    'selected packs with duplicate semantic declarations fail atomically before any target write',
    crossPackCollision.status !== 0 && /pack alpha.+pack beta/.test(output(crossPackCollision)) && JSON.stringify(census(crossPackTarget)) === JSON.stringify(crossPackBefore),
    output(crossPackCollision) + census(crossPackTarget).join('\n')
  );

  const tomlNonCollisionFixtures = [
    ['comment and multiline string literals', '# [mcp_servers.orchestra_claude_review]\nnotes = """\n[mcp_servers.orchestra_claude_review]\n"""\n'],
    ['escaped quotes inside multiline basic string', 'notes = """\n\\""" is inert string content\n[mcp_servers.orchestra_claude_review]\n"""\n'],
    ['quoted literal dots', '["mcp_servers.orchestra_claude_review"]\ncommand = "mine"\n'],
    ['other MCP server', '[mcp_servers.other]\ncommand = "mine"\n'],
  ];
  for (const [name, config] of tomlNonCollisionFixtures) {
    const target = temp('codex-orchestra-target-');
    write(path.join(target, '.codex', 'config.toml'), config);
    const result = run(master, [target, '--packs', 'claude']);
    const installed = fs.readFileSync(path.join(target, '.codex', 'config.toml'), 'utf8');
    check(
      'non-conflicting TOML (' + name + ') installs normally',
      result.status === 0 && installed.includes('[mcp_servers.orchestra_claude_review]') && fs.existsSync(path.join(target, '.codex', 'orchestra-install.json')),
      output(result) + installed
    );
  }

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
  check('existing hardlinked config is untouched when no pack block changes', configLinkInstall.status === 0 && fs.existsSync(path.join(configLinkTarget, '.codex', 'agents', 'scout.toml')) && fs.readFileSync(externalConfig, 'utf8') === '# shared project config\ncustom = true\n', output(configLinkInstall));

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

function case7CanonicalLineEndingsAndLegacyHashes() {
  section('7. Managed text is canonical LF and legacy CRLF receipts remain removable');
  const master = makeMaster();
  const sourceAgent = path.join(master, 'agents', 'scout.toml');
  const lf = 'name = "scout"\nmodel = "gpt-6-luna"\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  fs.writeFileSync(sourceAgent, crlf, 'utf8');
  const target = temp('codex-orchestra-target-');
  const installed = run(master, [target, '--no-packs', '--no-specialists']);
  check('CRLF source install succeeds', installed.status === 0, output(installed));
  const targetAgent = path.join(target, '.codex', 'agents', 'scout.toml');
  const installedBytes = fs.readFileSync(targetAgent);
  const receiptFile = path.join(target, '.codex', 'orchestra-install.json');
  const receipt = readJson(receiptFile);
  check('managed TOML is written as LF', installedBytes.toString('utf8') === lf && !installedBytes.includes(13), JSON.stringify(installedBytes.toString('utf8')));
  check('receipt hashes the exact canonical LF bytes', receipt.managedHashes['.codex/agents/scout.toml'] === hash(installedBytes), JSON.stringify(receipt.managedHashes));

  receipt.managedHashes['.codex/agents/scout.toml'] = hash(Buffer.from(crlf, 'utf8'));
  writeJson(receiptFile, receipt);
  fs.unlinkSync(sourceAgent);
  const updated = run(master, [target]);
  check('legacy CRLF receipt recognizes an LF-equivalent managed file', updated.status === 0 && !fs.existsSync(targetAgent) && /pruned retired\/deselected managed file/.test(output(updated)), output(updated));
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
  case2_idempotenceAndManagedPackConfig();
  case3DeselectRetireAndUninstall();
  case4MalformedAtomicityAndCollisions();
  case5LintAndScanUpdate();
  case6ClaimsPreexistingHookEntries();
  case7CanonicalLineEndingsAndLegacyHashes();
} catch (error) {
  check('suite completed without an uncaught exception', false, error && error.stack ? error.stack : error);
}

for (const dir of cleanups.reverse()) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}
console.log('\n' + (failed ? 'FAILED' : 'OK') + ' - ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

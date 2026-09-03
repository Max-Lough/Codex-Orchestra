#!/usr/bin/env node
/**
 * Codex-Orchestra installer.
 *
 *   node install.js [target] [--packs a,b|--no-packs]
 *                  [--specialists a,b|--no-specialists]
 *   node install.js [target] --uninstall
 *   node install.js --scan <root> [--depth n] [--update]
 *   node install.js --lint [source-root]
 *
 * The master copy is the repository root. Installs are deliberately confined
 * to .codex/, .agents/skills/, and one managed block in root AGENTS.md. The
 * receipt is the ownership boundary: update/uninstall remove only paths that a
 * previous successful install recorded as managed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const RECEIPT_REL = '.codex/orchestra-install.json';
const HOOKS_REL = '.codex/hooks.json';
const CONFIG_REL = '.codex/config.toml';
const PROTOCOL_REL = '.codex/ORCHESTRA.md';
const AGENTS_REL = 'AGENTS.md';
const BEGIN = '<!-- ORCHESTRA:BEGIN (managed by Codex-Orchestra; edit the master and reinstall) -->';
const END = '<!-- ORCHESTRA:END -->';
const HOOK_PACKAGE = Buffer.from('{"type":"commonjs"}\n', 'utf8');
const SKIP_DIRS = new Set(['.git', '.codex', '.agents', 'node_modules', 'vendor', 'dist', 'build']);

function fatal(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function note(message) {
  console.log('  * ' + message);
}

function posix(value) {
  return value.replace(/\\/g, '/');
}

function isContained(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function assertUnaliasedTarget(target, out, rel) {
  const base = path.resolve(target);
  const baseReal = fs.realpathSync(base);
  let existing = out;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fatal('Cannot resolve managed path parent: ' + rel);
    existing = parent;
  }
  const existingReal = fs.realpathSync(existing);
  if (!isContained(baseReal, existingReal)) {
    fatal('Managed path escapes the target through a symlink or junction: ' + rel);
  }

  const relativeExisting = path.relative(base, existing);
  let cursor = base;
  for (const part of relativeExisting.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      fatal('Managed path traverses a symlink or junction: ' + rel);
    }
  }

  if (fs.existsSync(out)) {
    const stat = fs.lstatSync(out);
    if (stat.isSymbolicLink()) fatal('Managed path is a symbolic link: ' + rel);
    if (stat.isFile() && fs.statSync(out).nlink > 1) {
      fatal('Managed path is hardlinked and cannot be changed safely: ' + rel);
    }
  }
}

function relativeInside(root, file) {
  const rel = posix(path.relative(root, file));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    fatal('Path escapes its expected root: ' + file);
  }
  return rel;
}

function targetPath(target, rel, checkAliases = true) {
  const normalized = posix(String(rel || '')).replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized || segments.some((segment) => !segment || segment === '.' || segment === '..') || path.isAbsolute(normalized)) {
    fatal('Invalid managed path in install receipt: ' + JSON.stringify(rel));
  }
  if (normalized === '.claude' || normalized.startsWith('.claude/')) {
    fatal('Refusing a managed path under .claude/: ' + normalized);
  }
  const out = path.resolve(target, ...normalized.split('/'));
  const base = path.resolve(target);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (out !== base && !out.startsWith(prefix)) {
    fatal('Managed path resolves outside the target: ' + normalized);
  }
  if (checkAliases) assertUnaliasedTarget(base, out, normalized);
  return out;
}

function managedNamespace(rel) {
  const normalized = posix(String(rel || '')).replace(/^\.\//, '');
  if (normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fatal('Install receipt contains an invalid managed path: ' + JSON.stringify(rel));
  }
  if (normalized === PROTOCOL_REL) return normalized;
  if (/^\.codex\/agents\/[A-Za-z0-9._-]+\.toml$/.test(normalized)) return normalized;
  if (/^\.codex\/hooks\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:c?js|mjs|json)$/.test(normalized)) return normalized;
  if (/^\.agents\/skills\/[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(normalized)) return normalized;
  fatal('Install receipt claims a path outside Orchestra-managed namespaces: ' + JSON.stringify(rel));
}

function fileHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJsonStrict(file, optional, label) {
  if (!fs.existsSync(file)) {
    if (optional) return null;
    fatal((label || file) + ' is missing.');
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fatal((label || file) + ' is unreadable (' + error.message + ').');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fatal((label || file) + ' is not valid JSON (' + error.message + '). Refusing before writing anything.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fatal((label || file) + ' must contain a JSON object. Refusing before writing anything.');
  }
  return value;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readFileStrict(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    fatal((label || file) + ' is unreadable (' + error.message + ').');
  }
}

function dirsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

function filesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
      else fatal('Installer sources may not be symlinks or special files: ' + full);
    }
  };
  walk(dir);
  return out;
}

function directFiles(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension) && !entry.name.startsWith('_'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function stringList(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    fatal(field + ' must be an array of non-empty strings. Refusing before writing anything.');
  }
  return value.map((item) => item.trim());
}

function parseList(value) {
  return Array.from(new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean))).sort();
}

function validateHooksObject(value, label) {
  if (value.hooks != null && (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks))) {
    fatal(label + '.hooks must be a JSON object. Refusing before writing anything.');
  }
  for (const [event, entries] of Object.entries(value.hooks || {})) {
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
      fatal(label + '.hooks.' + event + ' must be an array of JSON objects. Refusing before writing anything.');
    }
  }
}

function validateReceipt(value, label) {
  if (!value) return null;
  stringList(value.packs, label + '.packs');
  stringList(value.specialists, label + '.specialists');
  const managed = stringList(value.managedFiles, label + '.managedFiles');
  for (const rel of managed) managedNamespace(rel);
  if (value.managedHashes != null && (!value.managedHashes || typeof value.managedHashes !== 'object' || Array.isArray(value.managedHashes))) {
    fatal(label + '.managedHashes must be a JSON object. Refusing before writing anything.');
  }
  const hashes = value.managedHashes || {};
  for (const [rel, digest] of Object.entries(hashes)) {
    managedNamespace(rel);
    if (!managed.includes(rel) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      fatal(label + '.managedHashes contains an invalid or unowned digest. Refusing before writing anything.');
    }
  }
  if (value.schemaVersion === 2 && managed.some((rel) => typeof hashes[rel] !== 'string')) {
    fatal(label + '.managedHashes must cover every managed file. Refusing before writing anything.');
  }
  if (value.managedHooks != null) {
    if (!Array.isArray(value.managedHooks)) fatal(label + '.managedHooks must be an array.');
    for (const item of value.managedHooks) {
      if (!item || typeof item !== 'object' || typeof item.event !== 'string' || !item.entry || typeof item.entry !== 'object' || Array.isArray(item.entry)) {
        fatal(label + '.managedHooks contains an invalid entry. Refusing before writing anything.');
      }
      const commands = Array.isArray(item.entry.hooks)
        ? item.entry.hooks.map((hook) => hook && (hook.command || hook.commandWindows)).filter((command) => typeof command === 'string')
        : [];
      if (!['SessionStart', 'PreToolUse'].includes(item.event) || commands.length === 0 || commands.some((command) => !command.includes('orchestra-guard.js'))) {
        fatal(label + '.managedHooks may claim only Orchestra guard entries. Refusing before writing anything.');
      }
    }
  }
  if (value.createdHooksFile != null && typeof value.createdHooksFile !== 'boolean') {
    fatal(label + '.createdHooksFile must be a boolean. Refusing before writing anything.');
  }
  return value;
}

function validateTomlAgent(file) {
  const text = readFileStrict(file, 'agent ' + file).toString('utf8');
  if (!/^\s*name\s*=\s*["'][^"']+["']/m.test(text)) {
    fatal('Agent TOML has no quoted name field: ' + file);
  }
}

function sourceContext(root) {
  const required = ['config.toml', 'hooks.json', 'ORCHESTRA.md'];
  for (const rel of required) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fatal('Installer source is missing ' + rel + ': ' + file);
  }
  const hooksJson = readJsonStrict(path.join(root, 'hooks.json'), false, 'source hooks.json');
  validateHooksObject(hooksJson, 'source hooks.json');
  const coreAgents = directFiles(path.join(root, 'agents'), '.toml');
  if (coreAgents.length === 0) fatal('Installer source has no core agents/*.toml files.');
  coreAgents.forEach(validateTomlAgent);

  const specialistsDir = path.join(root, 'agents', 'specialists');
  const specialistFiles = directFiles(specialistsDir, '.toml');
  const specialists = specialistFiles.map((file) => path.basename(file, '.toml'));
  specialistFiles.forEach(validateTomlAgent);

  const packsDir = path.join(root, 'packs');
  const packNames = dirsIn(packsDir).filter((name) => fs.existsSync(path.join(packsDir, name, 'pack.json')));
  const packManifests = new Map();
  for (const name of packNames) {
    const manifest = readJsonStrict(path.join(packsDir, name, 'pack.json'), false, 'pack "' + name + '" pack.json');
    if (manifest.name !== name) fatal('Pack "' + name + '" must declare the matching name in pack.json.');
    packManifests.set(name, manifest);
    directFiles(path.join(packsDir, name, 'agents'), '.toml').forEach(validateTomlAgent);
  }

  for (const skill of dirsIn(path.join(root, 'skills'))) {
    if (!fs.existsSync(path.join(root, 'skills', skill, 'SKILL.md'))) {
      fatal('Core skill directory is missing SKILL.md: skills/' + skill);
    }
  }
  for (const name of packNames) {
    for (const skill of dirsIn(path.join(packsDir, name, 'skills'))) {
      if (!fs.existsSync(path.join(packsDir, name, 'skills', skill, 'SKILL.md'))) {
        fatal('Pack skill directory is missing SKILL.md: packs/' + name + '/skills/' + skill);
      }
    }
  }

  const versionFile = path.join(root, 'VERSION');
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  if (version && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fatal('VERSION must be a semantic version or empty: ' + version);
  }
  return { root, hooksJson, coreAgents, specialists, packsDir, packNames, packManifests, version };
}

function flattenHookEntries(config) {
  const out = [];
  for (const event of Object.keys(config.hooks || {}).sort()) {
    for (const entry of config.hooks[event]) out.push({ event, entry });
  }
  return out;
}

function stampedProtocol(context) {
  let text = readFileStrict(path.join(context.root, 'ORCHESTRA.md'), 'source ORCHESTRA.md').toString('utf8');
  if (context.version) {
    text = text.replace(
      'Installed by the Orchestra harness.',
      'Installed by the Orchestra harness (v' + context.version + ').'
    );
  }
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
}

function addDesired(map, rel, source, content) {
  const normalized = posix(rel);
  const collisionKey = normalized.toLowerCase();
  if (map.keys.has(collisionKey)) {
    fatal('Installer sources collide at target path ' + normalized + ' (' + map.keys.get(collisionKey) + ' and ' + source + ').');
  }
  map.keys.set(collisionKey, source);
  map.files.push({ rel: normalized, source, content: content == null ? readFileStrict(source) : content });
}

function addTree(map, sourceDir, targetPrefix) {
  for (const file of filesRecursive(sourceDir)) {
    addDesired(map, targetPrefix + '/' + relativeInside(sourceDir, file), file);
  }
}

function addAgents(map, sourceDir) {
  for (const file of directFiles(sourceDir, '.toml')) {
    addDesired(map, '.codex/agents/' + path.basename(file), file);
  }
}

function addSkills(map, skillsDir) {
  for (const name of dirsIn(skillsDir)) {
    addTree(map, path.join(skillsDir, name), '.agents/skills/' + name);
  }
}

function desiredFiles(context, packs, specialists) {
  const map = { files: [], keys: new Map() };
  for (const file of context.coreAgents) addDesired(map, '.codex/agents/' + path.basename(file), file);
  for (const name of specialists) {
    const file = path.join(context.root, 'agents', 'specialists', name + '.toml');
    addDesired(map, '.codex/agents/' + path.basename(file), file);
  }
  addTree(map, path.join(context.root, 'hooks'), '.codex/hooks');
  addSkills(map, path.join(context.root, 'skills'));

  for (const name of packs) {
    const packRoot = path.join(context.packsDir, name);
    addAgents(map, path.join(packRoot, 'agents'));
    addTree(map, path.join(packRoot, 'hooks'), '.codex/hooks');
    addSkills(map, path.join(packRoot, 'skills'));
  }
  addDesired(map, PROTOCOL_REL, path.join(context.root, 'ORCHESTRA.md'), stampedProtocol(context));
  addDesired(map, '.codex/hooks/package.json', '(generated CommonJS boundary)', HOOK_PACKAGE);
  return map.files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function markerParts(text, label) {
  const begins = [];
  const beginRe = /<!--\s*ORCHESTRA:BEGIN[^>]*-->/g;
  let match;
  while ((match = beginRe.exec(text)) !== null) begins.push({ index: match.index, length: match[0].length });
  const ends = [];
  const endRe = /<!--\s*ORCHESTRA:END\s*-->/g;
  while ((match = endRe.exec(text)) !== null) ends.push({ index: match.index, length: match[0].length });
  if (begins.length !== ends.length || begins.length > 1 || (begins[0] && ends[0].index < begins[0].index)) {
    fatal(label + ' has an unbalanced or duplicate Orchestra managed block. Refusing before writing anything.');
  }
  if (!begins.length) return { before: text, after: '', found: false };
  return { before: text.slice(0, begins[0].index), after: text.slice(ends[0].index + ends[0].length), found: true };
}

function withoutManagedBlock(text, label) {
  const parts = markerParts(text, label);
  if (!parts.found) return text;
  const before = parts.before.replace(/[ \t]*\r?\n+$/, '');
  const after = parts.after.replace(/^\r?\n+/, '');
  if (!before) return after;
  if (!after) return before + '\n';
  return before + '\n\n' + after;
}

function withManagedBlock(text, protocol, label) {
  const clean = withoutManagedBlock(text, label).replace(/\s+$/, '');
  const block = BEGIN + '\n' + protocol.replace(/\s+$/, '') + '\n' + END;
  return (clean ? clean + '\n\n' : '') + block + '\n';
}

function preflightTarget(target, desired, uninstall) {
  const receiptFile = targetPath(target, RECEIPT_REL);
  const receipt = validateReceipt(readJsonStrict(receiptFile, true, 'target ' + RECEIPT_REL), 'target ' + RECEIPT_REL);
  const hooksFile = targetPath(target, HOOKS_REL);
  const hooks = readJsonStrict(hooksFile, true, 'target ' + HOOKS_REL);
  if (hooks) validateHooksObject(hooks, 'target ' + HOOKS_REL);
  const hookPackageFile = targetPath(target, '.codex/hooks/package.json');
  if (fs.existsSync(hookPackageFile)) readJsonStrict(hookPackageFile, false, 'target .codex/hooks/package.json');
  const agentsFile = targetPath(target, AGENTS_REL);
  const agentsText = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : '';
  markerParts(agentsText, 'target AGENTS.md');
  const configFile = targetPath(target, CONFIG_REL, false);
  if (!fs.existsSync(configFile)) assertUnaliasedTarget(target, configFile, CONFIG_REL);

  const priorFiles = new Set(receipt ? stringList(receipt.managedFiles, 'receipt.managedFiles').map(posix) : []);
  const legacyReceipt = !!receipt && !Array.isArray(receipt.managedFiles);
  for (const item of desired) {
    if (!item.rel.toLowerCase().endsWith('.json')) continue;
    try { JSON.parse(item.content.toString('utf8')); }
    catch (error) { fatal('source ' + item.source + ' is not valid JSON (' + error.message + '). Refusing before writing anything.'); }
  }
  for (const rel of priorFiles) {
    const file = targetPath(target, rel);
    if (rel.toLowerCase().endsWith('.json') && fs.existsSync(file) && fs.statSync(file).isFile()) {
      readJsonStrict(file, false, 'managed target ' + rel);
    }
  }
  if (!uninstall) {
    for (const item of desired) {
      managedNamespace(item.rel);
      const file = targetPath(target, item.rel);
      if (!fs.existsSync(file) || priorFiles.has(item.rel) || legacyReceipt) continue;
      const existing = fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
      if (item.rel === '.codex/hooks/package.json' && existing && existing.equals(item.content)) continue;
      fatal('Refusing to overwrite an unowned target path: ' + item.rel + '. Move it or uninstall its owner first.');
    }
  }
  return { receipt, hooks, hooksFile, agentsFile, agentsText, configFile, priorFiles, legacyReceipt };
}

function receiptOwnsCurrent(receipt, rel, file) {
  if (!receipt || !receipt.managedHashes || typeof receipt.managedHashes[rel] !== 'string') return false;
  return fileHash(fs.readFileSync(file)) === receipt.managedHashes[rel];
}

function removeOne(entries, wanted) {
  const index = entries.findIndex((entry) => sameJson(entry, wanted));
  if (index === -1) return false;
  entries.splice(index, 1);
  return true;
}

function mergeHooks(context, targetState) {
  const created = !targetState.hooks;
  const config = targetState.hooks ? JSON.parse(JSON.stringify(targetState.hooks)) : {};
  if (!config.hooks) config.hooks = {};
  const priorManaged = targetState.receipt && Array.isArray(targetState.receipt.managedHooks) ? targetState.receipt.managedHooks : [];
  for (const item of priorManaged) {
    const entries = Array.isArray(config.hooks[item.event]) ? config.hooks[item.event] : [];
    removeOne(entries, item.entry);
    if (entries.length) config.hooks[item.event] = entries;
    else delete config.hooks[item.event];
  }

  if (targetState.legacyReceipt) {
    for (const event of Object.keys(config.hooks)) {
      config.hooks[event] = config.hooks[event].filter((entry) => {
        const nested = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
        return !nested.some((hook) => hook && typeof hook.command === 'string' && hook.command.includes('orchestra-guard.js'));
      });
      if (!config.hooks[event].length) delete config.hooks[event];
    }
  }

  if (created) {
    for (const [key, value] of Object.entries(context.hooksJson)) {
      if (key !== 'hooks') config[key] = JSON.parse(JSON.stringify(value));
    }
  }

  const managedHooks = [];
  for (const item of flattenHookEntries(context.hooksJson)) {
    if (!Array.isArray(config.hooks[item.event])) config.hooks[item.event] = [];
    if (!config.hooks[item.event].some((entry) => sameJson(entry, item.entry))) {
      config.hooks[item.event].push(JSON.parse(JSON.stringify(item.entry)));
      managedHooks.push(JSON.parse(JSON.stringify(item)));
    }
  }
  return { config, managedHooks, created: created || !!(targetState.receipt && targetState.receipt.createdHooksFile) };
}

function removeManagedHooks(config, managed) {
  if (!config || !config.hooks) return config;
  for (const item of managed || []) {
    const entries = Array.isArray(config.hooks[item.event]) ? config.hooks[item.event] : [];
    removeOne(entries, item.entry);
    if (entries.length) config.hooks[item.event] = entries;
    else delete config.hooks[item.event];
  }
  if (Object.keys(config.hooks).length === 0) delete config.hooks;
  return config;
}

function removeEmptyParents(file, target) {
  const stops = new Set([path.resolve(target), path.join(path.resolve(target), '.codex'), path.join(path.resolve(target), '.agents')]);
  let dir = path.dirname(file);
  while (!stops.has(dir) && dir.startsWith(path.resolve(target) + path.sep)) {
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length) break;
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

function install(context, target, packs, specialists) {
  const desired = desiredFiles(context, packs, specialists);
  const state = preflightTarget(target, desired, false);
  const configSource = readFileStrict(path.join(context.root, 'config.toml'), 'source config.toml');
  const protocolText = stampedProtocol(context).toString('utf8');
  const hooksMerged = mergeHooks(context, state);

  console.log('Installing Codex-Orchestra' + (context.version ? ' v' + context.version : '') + ' into: ' + target);
  const managedFiles = [];
  const managedHashes = {};
  for (const item of desired) {
    const out = targetPath(target, item.rel);
    const foreignIdenticalPackage = item.rel === '.codex/hooks/package.json' && fs.existsSync(out) && !state.priorFiles.has(item.rel) && !state.legacyReceipt;
    if (foreignIdenticalPackage) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, item.content);
    managedFiles.push(item.rel);
    managedHashes[item.rel] = fileHash(item.content);
  }

  for (const rel of state.priorFiles) {
    if (managedFiles.includes(rel)) continue;
    const file = targetPath(target, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      if (!receiptOwnsCurrent(state.receipt, rel, file)) {
        note('preserved modified or unverifiable retired file ' + rel);
        continue;
      }
      fs.unlinkSync(file);
      removeEmptyParents(file, target);
      note('pruned retired/deselected managed file ' + rel);
    }
  }

  const configFile = state.configFile;
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, configSource);
    note(CONFIG_REL + ' created (first-write-only; future installs leave it untouched)');
  } else note(CONFIG_REL + ' already exists; left untouched');

  writeJson(state.hooksFile, hooksMerged.config);
  note('merged Orchestra entries into ' + HOOKS_REL + ' without replacing foreign hooks');
  fs.writeFileSync(state.agentsFile, withManagedBlock(state.agentsText, protocolText, 'target AGENTS.md'), 'utf8');
  note('ensured the managed Orchestra block in AGENTS.md');

  writeJson(targetPath(target, RECEIPT_REL), {
    schemaVersion: 2,
    version: context.version || null,
    packs,
    specialists,
    managedFiles: managedFiles.sort(),
    managedHashes,
    managedHooks: hooksMerged.managedHooks,
    createdHooksFile: hooksMerged.created,
  });
  note('recorded ownership and selections in ' + RECEIPT_REL);
  console.log('Done. Re-run without selection flags to update the same packs and specialists.');
}

function uninstall(context, target) {
  const state = preflightTarget(target, [], true);
  console.log('Uninstalling Codex-Orchestra from: ' + target);
  if (!state.receipt) {
    console.log('  (no install receipt; no managed files will be guessed or deleted)');
  } else {
    for (const rel of stringList(state.receipt.managedFiles, 'receipt.managedFiles')) {
      const file = targetPath(target, rel);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        if (!receiptOwnsCurrent(state.receipt, rel, file)) {
          note('preserved modified or unverifiable managed file ' + rel);
          continue;
        }
        fs.unlinkSync(file);
        removeEmptyParents(file, target);
        note('removed ' + rel);
      }
    }
    if (state.hooks) {
      const cleaned = removeManagedHooks(JSON.parse(JSON.stringify(state.hooks)), Array.isArray(state.receipt.managedHooks) ? state.receipt.managedHooks : []);
      const hasHookEntries = cleaned && cleaned.hooks && Object.values(cleaned.hooks).some((entries) => Array.isArray(entries) && entries.length);
      const sourceBase = {};
      for (const [key, value] of Object.entries(context.hooksJson)) if (key !== 'hooks') sourceBase[key] = value;
      const remainingBase = { ...cleaned };
      delete remainingBase.hooks;
      if (state.receipt.createdHooksFile && !hasHookEntries && sameJson(remainingBase, sourceBase)) {
        fs.unlinkSync(state.hooksFile);
        note('removed installer-created ' + HOOKS_REL);
      } else {
        writeJson(state.hooksFile, cleaned);
        note('removed managed hook entries and preserved foreign hooks');
      }
    }
  }

  if (fs.existsSync(state.agentsFile)) {
    const cleaned = withoutManagedBlock(state.agentsText, 'target AGENTS.md');
    if (cleaned.trim()) fs.writeFileSync(state.agentsFile, cleaned, 'utf8');
    else fs.unlinkSync(state.agentsFile);
    note('removed the managed Orchestra block from AGENTS.md');
  }
  const receiptFile = targetPath(target, RECEIPT_REL);
  if (fs.existsSync(receiptFile)) fs.unlinkSync(receiptFile);
  console.log('Done. ' + CONFIG_REL + ' is intentionally retained as project-owned configuration.');
}

function semverParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ''));
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const aa = semverParts(a);
  const bb = semverParts(b);
  if (!aa && !bb) return 0;
  if (!aa) return -1;
  if (!bb) return 1;
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
}

function findInstalls(root, maxDepth) {
  const found = [];
  const seen = new Set();
  const master = fs.realpathSync(SRC);
  const walk = (dir, depth) => {
    let real;
    try { real = fs.realpathSync(dir); } catch (_) { return; }
    if (seen.has(real)) return;
    seen.add(real);
    if (real === master) return;
    const receipt = path.join(dir, ...RECEIPT_REL.split('/'));
    if (fs.existsSync(receipt)) { found.push(dir); return; }
    if (depth >= maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

function scan(context, root, depth, update) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fatal('Scan root does not exist: ' + root);
  const installs = findInstalls(root, depth);
  let behind = 0;
  for (const dir of installs) {
    const receiptFile = targetPath(dir, RECEIPT_REL);
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
    catch (error) { console.log('INVALID\t' + dir + '\t' + error.message); behind++; continue; }
    const version = typeof receipt.version === 'string' ? receipt.version : '';
    const cmp = compareVersions(version, context.version);
    const status = cmp < 0 ? 'BEHIND' : cmp > 0 ? 'AHEAD' : 'CURRENT';
    console.log(status + '\t' + (version || 'unversioned') + '\t' + dir);
    if (cmp < 0) {
      behind++;
      if (update) {
        const result = spawnSync(process.execPath, [__filename, dir], { stdio: 'inherit' });
        if (result.status !== 0) fatal('Update failed for ' + dir + ' (exit ' + result.status + ').');
      }
    }
  }
  console.log('Found ' + installs.length + ' install(s); ' + behind + ' behind/invalid.');
  process.exit(update ? 0 : behind ? 1 : 0);
}

function parseArgs(argv) {
  const options = { uninstall: false, packsArg: null, specialistsArg: null, scan: null, update: false, depth: 6, lint: false, dir: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--uninstall') options.uninstall = true;
    else if (arg === '--packs') { if (argv[i + 1] == null) fatal('--packs requires a value.'); options.packsArg = argv[++i]; }
    else if (arg.startsWith('--packs=')) options.packsArg = arg.slice(8);
    else if (arg === '--no-packs') options.packsArg = '';
    else if (arg === '--specialists') { if (argv[i + 1] == null) fatal('--specialists requires a value.'); options.specialistsArg = argv[++i]; }
    else if (arg.startsWith('--specialists=')) options.specialistsArg = arg.slice(14);
    else if (arg === '--no-specialists') options.specialistsArg = '';
    else if (arg === '--scan') { if (argv[i + 1] == null) fatal('--scan requires a directory.'); options.scan = argv[++i]; }
    else if (arg.startsWith('--scan=')) options.scan = arg.slice(7);
    else if (arg === '--update') options.update = true;
    else if (arg === '--depth') options.depth = Number(argv[++i]);
    else if (arg.startsWith('--depth=')) options.depth = Number(arg.slice(8));
    else if (arg === '--lint') options.lint = true;
    else if (arg.startsWith('--')) fatal('Unknown flag: ' + arg);
    else if (!options.dir) options.dir = arg;
    else fatal('Unexpected extra argument: ' + arg);
  }
  if (!Number.isInteger(options.depth) || options.depth < 1) fatal('--depth must be a positive integer.');
  return options;
}

const options = parseArgs(process.argv.slice(2));
if (options.lint) {
  if (options.uninstall || options.scan || options.update || options.packsArg !== null || options.specialistsArg !== null) fatal('--lint cannot be combined with install, scan, or selection flags.');
  const lintRoot = path.resolve(options.dir || SRC);
  const context = sourceContext(lintRoot);
  console.log('OK - Codex-Orchestra sources are valid: ' + context.coreAgents.length + ' core agent(s), ' + context.specialists.length + ' specialist(s), ' + context.packNames.length + ' pack(s).');
  process.exit(0);
}

const context = sourceContext(SRC);
if (options.scan !== null) {
  if (options.dir || options.uninstall || options.packsArg !== null || options.specialistsArg !== null) fatal('--scan cannot be combined with a target, --uninstall, --packs, or --specialists.');
  scan(context, path.resolve(options.scan), options.depth, options.update);
}
if (options.update) fatal('--update only means something with --scan.');

const target = path.resolve(options.dir || process.cwd());
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) fatal('Target directory does not exist: ' + target);
if (fs.realpathSync(target) === fs.realpathSync(SRC)) fatal('Refusing to install Codex-Orchestra into its own master folder.');

const receipt = validateReceipt(readJsonStrict(targetPath(target, RECEIPT_REL), true, 'target ' + RECEIPT_REL), 'target ' + RECEIPT_REL);
const priorPacks = receipt ? stringList(receipt.packs, 'receipt.packs') : [];
const priorSpecialists = receipt ? stringList(receipt.specialists, 'receipt.specialists') : [];
const packs = options.packsArg === null ? priorPacks : parseList(options.packsArg);
const specialists = options.specialistsArg === null ? priorSpecialists : parseList(options.specialistsArg);
for (const name of packs) if (!context.packNames.includes(name)) fatal('Unknown pack "' + name + '". Available: ' + (context.packNames.join(', ') || '(none)'));
for (const name of specialists) if (!context.specialists.includes(name)) fatal('Unknown specialist "' + name + '". Available: ' + (context.specialists.join(', ') || '(none)'));

if (options.uninstall) {
  if (options.packsArg !== null || options.specialistsArg !== null) fatal('--uninstall cannot be combined with selection flags.');
  uninstall(context, target);
} else install(context, target, packs, specialists);

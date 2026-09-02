/**
 * Enregistrement local des skills PieceMaker pour la CLI Codex.
 *
 * Les dossiers sont liés dans ~/.codex/skills afin que les modifications du
 * dépôt soient immédiatement visibles. Une copie est utilisée lorsque les
 * liens symboliques sont indisponibles. Un skill personnel homonyme n'est
 * jamais remplacé.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN_DIRECTORY = 'piecemaker-plugin';
const PLUGIN_SKILL_PATH = /(^|[\\/])piecemaker-plugin[\\/]skills[\\/][^\\/]+$/;

function pluginRoot(repoRoot) {
  return path.join(repoRoot, PLUGIN_DIRECTORY);
}

function codexSkillsDirectory(userHome) {
  return path.join(userHome, '.codex', 'skills');
}

function receiptFile(userHome) {
  return path.join(userHome, '.codex', '.piecemaker-skills.json');
}

export function codexHooksFile(userHome = os.homedir()) {
  return path.join(userHome, '.codex', 'hooks.json');
}

function codexProxyGuardScript(repoRoot) {
  return path.join(pluginRoot(repoRoot), 'scripts', 'proxy-guard.mjs');
}

function isPieceMakerProxyGuard(handler) {
  const command = typeof handler?.command === 'string' ? handler.command : '';
  const commandWindows = typeof handler?.commandWindows === 'string' ? handler.commandWindows : '';
  return (command.includes('proxy-guard.mjs') || commandWindows.includes('proxy-guard.mjs'))
    && (command.includes('PIECEMAKER_HOOK_CLIENT=codex')
      || commandWindows.includes('PIECEMAKER_HOOK_CLIENT=codex')
      || /piecemaker-plugin[\\/]scripts[\\/]proxy-guard\.mjs/.test(command + commandWindows));
}

function codexProxyGuardGroup(repoRoot) {
  const script = codexProxyGuardScript(repoRoot);
  return {
    matcher: 'startup|resume|clear',
    hooks: [{
      type: 'command',
      command: `PIECEMAKER_HOOK_CLIENT=codex node ${JSON.stringify(script)}`,
      commandWindows: `set "PIECEMAKER_HOOK_CLIENT=codex" && node ${JSON.stringify(script)}`,
      timeout: 45,
      statusMessage: 'Vérification de l’anonymisation PieceMaker',
    }],
  };
}

function readCodexHooks(userHome) {
  const file = codexHooksFile(userHome);
  if (!fs.existsSync(file)) return { file, document: { hooks: {} } };
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      return { file, error: 'hooks-invalides' };
    }
    if (document.hooks === undefined) document.hooks = {};
    if (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks)
      || (document.hooks.SessionStart !== undefined && !Array.isArray(document.hooks.SessionStart))) {
      return { file, error: 'hooks-invalides' };
    }
    return { file, document };
  } catch {
    return { file, error: 'hooks-json-invalide' };
  }
}

export function codexSessionHookStatus(repoRoot, userHome = os.homedir()) {
  const loaded = readCodexHooks(userHome);
  if (loaded.error) return { ok: false, changed: false, file: loaded.file, reason: loaded.error };
  const expected = codexProxyGuardGroup(repoRoot);
  const groups = Array.isArray(loaded.document.hooks.SessionStart)
    ? loaded.document.hooks.SessionStart
    : [];
  const managed = groups.flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .filter(isPieceMakerProxyGuard);
  const exact = groups.some((group) => group?.matcher === expected.matcher
    && Array.isArray(group.hooks)
    && group.hooks.some((handler) => JSON.stringify(handler) === JSON.stringify(expected.hooks[0])));
  return {
    ok: exact && managed.length === 1,
    changed: false,
    file: loaded.file,
    reason: exact && managed.length === 1 ? null : 'hook-absent-ou-perime',
  };
}

/** Fusionne uniquement la sentinelle SessionStart ; tous les hooks personnels sont conservés. */
export function installCodexSessionHook(repoRoot, userHome = os.homedir()) {
  const loaded = readCodexHooks(userHome);
  if (loaded.error) return { ok: false, changed: false, file: loaded.file, reason: loaded.error };
  const document = loaded.document;
  const groups = Array.isArray(document.hooks.SessionStart)
    ? document.hooks.SessionStart
    : [];
  const preserved = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      preserved.push(group);
      continue;
    }
    const hooks = Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isPieceMakerProxyGuard(handler)) : [];
    if (hooks.length || !Array.isArray(group.hooks)) preserved.push({ ...group, hooks });
  }
  document.description ||= 'Hooks locaux Codex, dont la sentinelle d’anonymisation PieceMaker.';
  document.hooks.SessionStart = [...preserved, codexProxyGuardGroup(repoRoot)];
  const output = `${JSON.stringify(document, null, 2)}\n`;
  let current = null;
  try { current = fs.readFileSync(loaded.file, 'utf8'); } catch { /* fichier absent */ }
  if (current === output) return { ok: true, changed: false, file: loaded.file, registered: 1 };
  try {
    fs.mkdirSync(path.dirname(loaded.file), { recursive: true });
    const temporary = `${loaded.file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, output, 'utf8');
    fs.renameSync(temporary, loaded.file);
    return { ok: true, changed: true, file: loaded.file, registered: 1 };
  } catch (error) {
    return { ok: false, changed: false, file: loaded.file, reason: error?.message || 'ecriture-impossible' };
  }
}

function readReceipt(userHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptFile(userHome), 'utf8'));
    return parsed && typeof parsed.copies === 'object' && parsed.copies ? parsed.copies : {};
  } catch {
    return {};
  }
}

function rememberCopy(userHome, skill) {
  const copies = readReceipt(userHome);
  copies[skill.slug] = skill.source;
  try {
    fs.writeFileSync(receiptFile(userHome), `${JSON.stringify({ version: 1, copies }, null, 2)}\n`);
  } catch {
    // Le reçu facilite les mises à jour mais n'est pas requis pour charger le skill.
  }
}

function linkTarget(entry) {
  try {
    if (!fs.lstatSync(entry).isSymbolicLink()) return null;
    return path.resolve(path.dirname(entry), fs.readlinkSync(entry));
  } catch {
    return null;
  }
}

function samePath(left, right) {
  const resolve = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return resolve(left) === resolve(right);
}

function codexSkillOf(repoRoot, userHome, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const match = normalized.match(/^piecemaker-plugin\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/);
  if (!match) return null;
  return {
    slug: match[1],
    source: path.join(pluginRoot(repoRoot), 'skills', match[1]),
    target: path.join(codexSkillsDirectory(userHome), match[1]),
  };
}

export function repositoryCodexSkills(repoRoot) {
  const directory = path.join(pluginRoot(repoRoot), 'skills');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((slug) => fs.existsSync(path.join(directory, slug, 'SKILL.md')))
    .sort()
    .map((slug) => `${PLUGIN_DIRECTORY}/skills/${slug}/SKILL.md`);
}

export function codexSkillStatus(repoRoot, userHome, relativePath) {
  const skill = codexSkillOf(repoRoot, userHome, relativePath);
  if (!skill) return null;
  const base = { slug: skill.slug, target: skill.target };
  if (!fs.existsSync(skill.source)) return { ...base, state: 'missing' };

  const link = linkTarget(skill.target);
  if (link) {
    if (samePath(link, skill.source)) return { ...base, state: 'linked' };
    return PLUGIN_SKILL_PATH.test(link)
      ? { ...base, state: 'stale', origin: link }
      : { ...base, state: 'conflict' };
  }
  if (!fs.existsSync(skill.target)) return { ...base, state: 'missing' };

  const sourceManifest = path.join(skill.source, 'SKILL.md');
  const targetManifest = path.join(skill.target, 'SKILL.md');
  if (fs.existsSync(targetManifest)
    && fs.readFileSync(sourceManifest, 'utf8') === fs.readFileSync(targetManifest, 'utf8')) {
    return { ...base, state: 'copied' };
  }
  return Object.hasOwn(readReceipt(userHome), skill.slug)
    ? { ...base, state: 'stale' }
    : { ...base, state: 'conflict' };
}

export function registerCodexSkill(repoRoot, userHome, relativePath) {
  const skill = codexSkillOf(repoRoot, userHome, relativePath);
  if (!skill) return null;
  const current = codexSkillStatus(repoRoot, userHome, relativePath);
  if (current.state === 'linked') return current;
  if (current.state === 'conflict') {
    return {
      ...current,
      note: `Un skill personnel « ${skill.slug} » existe déjà dans ~/.codex/skills.`,
    };
  }

  fs.mkdirSync(path.dirname(skill.target), { recursive: true });
  const existingLink = linkTarget(skill.target);
  if (existingLink) fs.unlinkSync(skill.target);

  if (!existingLink && fs.existsSync(skill.target)) {
    fs.rmSync(skill.target, { recursive: true, force: true });
    fs.cpSync(skill.source, skill.target, { recursive: true, dereference: true });
    rememberCopy(userHome, skill);
    return { slug: skill.slug, target: skill.target, state: 'copied' };
  }

  try {
    fs.symlinkSync(skill.source, skill.target, 'dir');
    return { slug: skill.slug, target: skill.target, state: 'linked' };
  } catch {
    fs.cpSync(skill.source, skill.target, { recursive: true, dereference: true });
    rememberCopy(userHome, skill);
    return { slug: skill.slug, target: skill.target, state: 'copied' };
  }
}

export function syncCodexSkills(repoRoot, userHome = os.homedir()) {
  const skills = repositoryCodexSkills(repoRoot).map((relativePath) => ({
    path: relativePath,
    ...registerCodexSkill(repoRoot, userHome, relativePath),
  }));
  return {
    skills,
    registered: skills.filter((skill) => skill.state === 'linked' || skill.state === 'copied').length,
    conflicts: skills.filter((skill) => skill.state === 'conflict'),
  };
}

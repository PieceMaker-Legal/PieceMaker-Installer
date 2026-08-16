/**
 * Installation du hook central global dans `~/.claude`.
 *
 * Le hook central (`global-hooks/piecemaker-central-anonymize.mjs`) n'est pas un
 * hook du plugin : il vit dans `~/.claude/hooks/` et est câblé dans
 * `~/.claude/settings.json`, pour s'appliquer à toute session Claude, où qu'elle
 * tourne. Ce module l'y copie et l'y câble, de façon idempotente, sans écraser
 * les autres hooks déjà présents.
 *
 * Il installe aussi le moteur de substitution à un emplacement stable et
 * reconstruit le mapping central, via `central-mapping.cjs`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CENTRAL_FILE,
  installSubstitutionLib,
  syncCentralMapping,
} = require('../piecemaker-plugin/scripts/lib/central-mapping.cjs');

/** Liste noire éditable lue par le garde-secrets global (~/.claude/hooks/piecemaker-guard-secrets.mjs). */
const SECRET_PATHS_FILE = path.join(os.homedir(), '.claude', 'piecemaker-secret-paths.json');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_SOURCE = path.join(__dirname, 'global-hooks', 'piecemaker-central-anonymize.mjs');
const HOOK_BASENAME = 'piecemaker-central-anonymize.mjs';
const HOOK_TARGET = path.join(CLAUDE_HOOKS_DIR, HOOK_BASENAME);
/** Commande câblée dans settings.json (repérée par sous-chaîne, idempotence). */
const HOOK_COMMAND = `node ~/.claude/hooks/${HOOK_BASENAME}`;

const READ_MATCHER = 'Read|Grep|Glob|Bash';
const WRITE_MATCHER = 'Write|Edit|mcp__.*telegram.*__(reply|edit_message)';

/**
 * Ajoute le fichier central à la liste noire du garde-secrets global, pour que
 * l'IA ne puisse jamais le lire (il fait correspondre chaque code au vrai nom,
 * tous dossiers confondus). Le hook central, lui, le lit directement via fs —
 * ce n'est pas un appel d'outil, il n'est donc pas concerné. Idempotent.
 */
function registerCentralAsSecret() {
  try {
    let list = [];
    if (fs.existsSync(SECRET_PATHS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECRET_PATHS_FILE, 'utf8'));
      if (Array.isArray(parsed)) list = parsed.filter((entry) => typeof entry === 'string');
    }
    if (list.includes(CENTRAL_FILE)) return { changed: false };
    list.push(CENTRAL_FILE);
    fs.mkdirSync(path.dirname(SECRET_PATHS_FILE), { recursive: true });
    fs.writeFileSync(SECRET_PATHS_FILE, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
    return { changed: true };
  } catch {
    return { changed: false, error: true };
  }
}

/** Copie le fichier du hook dans ~/.claude/hooks, exécutable. Best-effort. */
function installHookFile() {
  try {
    fs.mkdirSync(CLAUDE_HOOKS_DIR, { recursive: true });
    fs.copyFileSync(HOOK_SOURCE, HOOK_TARGET);
    fs.chmodSync(HOOK_TARGET, 0o755);
    return HOOK_TARGET;
  } catch {
    return null;
  }
}

/** Un groupe de hooks contient-il déjà notre commande ? */
function groupHasCommand(group) {
  const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
  return hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(HOOK_BASENAME));
}

/** Ajoute notre hook à un événement (matcher donné) s'il n'y est pas déjà. */
function ensureEvent(hooks, eventName, matcher) {
  if (!Array.isArray(hooks[eventName])) hooks[eventName] = [];
  const groups = hooks[eventName];
  if (groups.some(groupHasCommand)) return false; // déjà câblé, quelque matcher que ce soit
  groups.push({ matcher, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return true;
}

/**
 * Câble le hook dans ~/.claude/settings.json (PostToolUse lecture, PreToolUse
 * écriture). Idempotent : n'ajoute rien s'il est déjà présent. Préserve tout le
 * reste du fichier.
 */
function wireSettings() {
  let settings = {};
  try {
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      const parsed = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
      if (parsed && typeof parsed === 'object') settings = parsed;
    }
  } catch {
    // settings.json illisible : on n'y touche pas plutôt que de l'écraser.
    return { wired: false, reason: 'unreadable-settings' };
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const addedRead = ensureEvent(settings.hooks, 'PostToolUse', READ_MATCHER);
  const addedWrite = ensureEvent(settings.hooks, 'PreToolUse', WRITE_MATCHER);

  if (!addedRead && !addedWrite) return { wired: true, changed: false };

  try {
    fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return { wired: true, changed: true, addedRead, addedWrite };
  } catch {
    return { wired: false, reason: 'write-failed' };
  }
}

/**
 * Installe tout : moteur stable, fichier de hook, câblage settings, et
 * reconstruction du mapping central. Ne jette jamais.
 */
function installCentralHook(config) {
  const result = { lib: null, hook: null, settings: null, secret: null, central: null };
  try { result.lib = installSubstitutionLib(); } catch { /* best-effort */ }
  try { result.hook = installHookFile(); } catch { /* best-effort */ }
  try { result.settings = wireSettings(); } catch { result.settings = { wired: false, reason: 'exception' }; }
  try { result.secret = registerCentralAsSecret(); } catch { /* best-effort */ }
  try { result.central = syncCentralMapping(config); } catch { /* best-effort */ }
  return result;
}

module.exports = {
  CLAUDE_HOOKS_DIR,
  CLAUDE_SETTINGS,
  HOOK_TARGET,
  HOOK_COMMAND,
  SECRET_PATHS_FILE,
  installCentralHook,
  installHookFile,
  registerCentralAsSecret,
  wireSettings,
};

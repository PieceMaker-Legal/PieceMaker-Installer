/**
 * Drift detection between the plugin checked into `piecemaker-plugin/` and
 * what Claude Code actually has cached under `~/.claude/plugins/`.
 *
 * `claude plugin update <spec>` is keyed by the version string in
 * `.claude-plugin/plugin.json`: the cache directory Claude Code writes to is
 * literally named `<marketplace>/<plugin>/<version>/`. Editing hook/script
 * content without bumping that version leaves the installed cache holding
 * the previous bytes even after a successful `plugin marketplace update` +
 * `plugin update` — both commands exit 0, so nothing in the installer
 * previously noticed. That silent staleness is what broke anonymisation
 * (the hook ran on pre-fix code) — see the auto-memory "Hooks inertes si
 * plugin cache périmé".
 *
 * This module gives the installer a way to *verify* convergence instead of
 * trusting a command's exit code: compare a content fingerprint of the repo's
 * `piecemaker-plugin/` against the fingerprint of whatever Claude Code has
 * cached, independently of whether the version string moved. Two installer
 * call sites share it — `installer/steps/09-claude-assets.mjs` (interactive
 * install/repair) and `installer/lib/service.mjs`'s `refreshClaudePlugin()`
 * (`piecemaker update`) — so "up to date" means the same thing in both
 * places.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKETPLACE_NAME = 'piecemaker';
export const PLUGIN_NAME = 'piecemaker';

// What Claude Code actually loads out of a plugin directory (skills, agents,
// hooks, commands, MCP servers) plus the scripts those hooks/skills shell
// out to. Deliberately excludes bookkeeping Claude Code itself writes inside
// the cache directory (`.in_use`, `.orphaned_at`) — those must never affect
// whether two directories are considered "the same content".
const FINGERPRINT_ENTRIES = ['hooks', 'scripts', 'skills', 'agents', 'commands', 'mcp', '.mcp.json', 'README.md'];

export function claudeHome(userHome = os.homedir()) {
  return path.join(userHome, '.claude');
}

export function pluginJsonPath(pluginDir) {
  return path.join(pluginDir, '.claude-plugin', 'plugin.json');
}

/** Version string declared by the repo's plugin.json, or null if unreadable. */
export function readPluginVersion(pluginDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(pluginJsonPath(pluginDir), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function walkFiles(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Deterministic content fingerprint of the files Claude Code loads from a
 * plugin directory (see FINGERPRINT_ENTRIES). Sorted, content-only — no
 * mtimes or inode order — so a version-keyed cache directory Claude Code
 * populated from a git clone hashes identically to the source checkout when
 * the bytes match, and differently the moment a single hook script changes.
 */
export function pluginContentFingerprint(pluginDir) {
  const hash = crypto.createHash('sha256');
  const relativeFiles = FINGERPRINT_ENTRIES.flatMap((entry) => {
    const full = path.join(pluginDir, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return [];
    }
    return stat.isDirectory() ? walkFiles(full, full, []).map((rel) => path.join(entry, rel)) : [entry];
  }).sort();

  for (const relative of relativeFiles) {
    hash.update(relative);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(pluginDir, relative)));
    } catch {
      hash.update('MISSING');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The `scope: "user"` entry Claude Code recorded for `<plugin>@<marketplace>`
 * in `~/.claude/plugins/installed_plugins.json` — the entry that governs what
 * a fresh session picks up outside any single project (project-scoped
 * entries share the same installPath once both are on the same version, see
 * `installed_plugins.json`). Returns null when the plugin was never
 * installed for this user, or the file/entry is missing or malformed.
 */
export function installedPluginEntry(userHome = os.homedir(), marketplace = MARKETPLACE_NAME, plugin = PLUGIN_NAME) {
  const file = path.join(claudeHome(userHome), 'plugins', 'installed_plugins.json');
  const entries = readJson(file)?.plugins?.[`${plugin}@${marketplace}`];
  if (!Array.isArray(entries) || !entries.length) return null;
  return entries.find((entry) => entry.scope === 'user') || entries[0];
}

/**
 * Compare the repo's plugin sources against what Claude Code has cached.
 * `reason` says exactly why a refresh is (or isn't) needed:
 *   - 'not-installed'    no installed_plugins.json entry at all
 *   - 'missing-cache'    entry exists but its installPath is gone from disk
 *   - 'version-mismatch' installed version string differs from the repo's
 *   - 'content-drift'    same version string, but file contents differ — the
 *                        no-version-bump case that silently shipped stale hooks
 *   - 'up-to-date'       nothing to do
 */
export function pluginRefreshStatus({
  pluginDir,
  userHome = os.homedir(),
  marketplace = MARKETPLACE_NAME,
  plugin = PLUGIN_NAME,
} = {}) {
  const repoVersion = readPluginVersion(pluginDir);
  const repoFingerprint = pluginContentFingerprint(pluginDir);
  const entry = installedPluginEntry(userHome, marketplace, plugin);
  const base = { repoVersion, repoFingerprint };

  if (!entry) {
    return { ...base, installedVersion: null, installPath: null, installedFingerprint: null, reason: 'not-installed', upToDate: false };
  }
  const installPath = entry.installPath || null;
  const cacheDirExists = Boolean(installPath) && fs.existsSync(installPath);
  if (!cacheDirExists) {
    return { ...base, installedVersion: entry.version || null, installPath, installedFingerprint: null, reason: 'missing-cache', upToDate: false };
  }
  if (entry.version !== repoVersion) {
    return { ...base, installedVersion: entry.version || null, installPath, installedFingerprint: null, reason: 'version-mismatch', upToDate: false };
  }
  const installedFingerprint = pluginContentFingerprint(installPath);
  if (installedFingerprint !== repoFingerprint) {
    return { ...base, installedVersion: entry.version, installPath, installedFingerprint, reason: 'content-drift', upToDate: false };
  }
  return { ...base, installedVersion: entry.version, installPath, installedFingerprint, reason: 'up-to-date', upToDate: true };
}

export const REFRESH_REASON_LABEL = {
  'not-installed': 'plugin non installé',
  'missing-cache': 'répertoire du cache Claude Code absent',
  'version-mismatch': 'version installée différente de la version du dépôt',
  'content-drift': 'même version mais contenu différent (version non incrémentée)',
  'up-to-date': 'déjà à jour',
};

/**
 * Global Claude Code secret-file guard — installer-managed assets and merge
 * logic for a hook that is deliberately NOT part of the piecemaker plugin
 * (see `installer/assets/claude-hooks/piecemaker-guard-secrets.mjs`'s own
 * docstring): it must keep denying reads even when the plugin cache is
 * stale, the plugin is disabled, or the current directory isn't a
 * registered legal case — because what it protects is the general server
 * `.env`, which holds Légifrance credentials, not case data.
 *
 * Until this module existed, the hook, its blocklist and its
 * ~/.claude/settings.json wiring were installed by hand and would vanish on
 * a fresh machine or a wiped ~/.claude. Three moving pieces, each
 * independently idempotent so re-running the installer step never
 * duplicates anything:
 *
 *   1. installHookScript — copies the versioned hook into ~/.claude/hooks/,
 *      only rewriting bytes that actually changed.
 *   2. seedBlocklist      — creates ~/.claude/piecemaker-secret-paths.json
 *      from the versioned template if absent, then makes sure every path
 *      the caller cares about is listed — merging into whatever a user may
 *      already have hand-edited there, never overwriting it.
 *   3. mergeSettings      — merges the PreToolUse hook entry and the
 *      permissions.deny Read rules into ~/.claude/settings.json, leaving
 *      every other key (model, other hooks, enabledPlugins,
 *      extraKnownMarketplaces, unrelated deny rules…) untouched.
 *
 * Every function takes its paths explicitly (repoRoot / userHome) rather
 * than reaching for os.homedir()/REPO_ROOT internally, so tests run
 * hermetically against a temp HOME — see test/secrets-guard.test.mjs. The
 * installer step (installer/steps/13-garde-secrets.mjs) is the only caller
 * that wires the real paths.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOOK_ASSET_RELATIVE = path.join('installer', 'assets', 'claude-hooks', 'piecemaker-guard-secrets.mjs');
export const BLOCKLIST_TEMPLATE_RELATIVE = path.join('installer', 'assets', 'claude-hooks', 'piecemaker-secret-paths.default.json');
export const HOOK_SCRIPT_BASENAME = 'piecemaker-guard-secrets.mjs';
const HOOK_MATCHER = 'Read|Grep|Glob|Edit|Write|Bash';

export function hookAssetPath(repoRoot) {
  return path.join(repoRoot, HOOK_ASSET_RELATIVE);
}

export function blocklistTemplatePath(repoRoot) {
  return path.join(repoRoot, BLOCKLIST_TEMPLATE_RELATIVE);
}

export function hookTargetPath(userHome = os.homedir()) {
  return path.join(userHome, '.claude', 'hooks', HOOK_SCRIPT_BASENAME);
}

export function blocklistTargetPath(userHome = os.homedir()) {
  return path.join(userHome, '.claude', 'piecemaker-secret-paths.json');
}

export function settingsPath(userHome = os.homedir()) {
  return path.join(userHome, '.claude', 'settings.json');
}

/**
 * The literal '~' form is what a human hand-editing settings.json already
 * wrote (Claude Code expands it itself) — keep producing the same string so
 * an installer-managed entry and a hand-written one are byte-identical.
 */
export function hookCommand() {
  return `node ~/.claude/hooks/${HOOK_SCRIPT_BASENAME}`;
}

/** `Read(//abs/path)` — the deny-rule spelling Claude Code uses for an absolute path. */
export function denyRuleFor(envPath) {
  const posix = String(envPath).split(path.sep).join('/');
  return `Read(/${posix})`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function normalize(value) {
  return path.resolve(String(value));
}

/**
 * Copy the versioned hook script into ~/.claude/hooks/. Rewrites only when
 * the bytes actually differ, so re-running the step is a silent no-op once
 * converged (and never perturbs mtime for nothing).
 */
export function installHookScript({ repoRoot, userHome = os.homedir() }) {
  const source = hookAssetPath(repoRoot);
  const target = hookTargetPath(userHome);
  const content = fs.readFileSync(source, 'utf8');
  const existed = fs.existsSync(target);
  const existing = existed ? fs.readFileSync(target, 'utf8') : null;
  if (existing === content) return { changed: false, created: false, path: target };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return { changed: true, created: !existed, path: target };
}

/**
 * Create ~/.claude/piecemaker-secret-paths.json from the versioned template
 * if it doesn't exist yet, then make sure every path in `envPaths` is
 * listed. An existing file — hand-edited or from a previous run — is always
 * merged into, never replaced: entries already present (compared by
 * resolved absolute path, so a trailing slash or a relative spelling still
 * dedupes) are left exactly as the user wrote them.
 */
export function seedBlocklist({ repoRoot, userHome = os.homedir(), envPaths = [] }) {
  const target = blocklistTargetPath(userHome);
  const existed = fs.existsSync(target);
  const starting = existed ? readJson(target, []) : readJson(blocklistTemplatePath(repoRoot), []);
  const list = Array.isArray(starting) ? [...starting] : [];
  const known = new Set(
    list.filter((entry) => typeof entry === 'string' && entry.trim()).map(normalize)
  );

  const added = [];
  for (const envPath of envPaths) {
    if (!envPath) continue;
    const key = normalize(envPath);
    if (known.has(key)) continue;
    list.push(envPath);
    known.add(key);
    added.push(envPath);
  }

  if (!existed || added.length) writeJson(target, list);
  return { created: !existed, added, path: target, entries: list };
}

/**
 * Merge the guard's PreToolUse hook entry and its permissions.deny Read
 * rules into ~/.claude/settings.json. Every other key passes through
 * untouched. Presence is detected by the hook SCRIPT'S BASENAME appearing
 * in a hook command, not by matcher string or exact command spelling, so a
 * hand-edited entry (different quoting, absolute path instead of `~`,
 * different matcher) is still recognised and never duplicated.
 */
export function mergeSettings({ userHome = os.homedir(), envPaths = [] }) {
  const target = settingsPath(userHome);
  const existed = fs.existsSync(target);
  const settings = existed ? (readJson(target, null) ?? {}) : {};

  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const preToolUse = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  settings.hooks.PreToolUse = preToolUse;

  const hasGuard = preToolUse.some(
    (group) =>
      Array.isArray(group?.hooks) &&
      group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT_BASENAME))
  );
  let hookAdded = false;
  if (!hasGuard) {
    preToolUse.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command: hookCommand() }],
    });
    hookAdded = true;
  }

  settings.permissions =
    settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
      ? settings.permissions
      : {};
  const deny = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
  settings.permissions.deny = deny;

  const denyAdded = [];
  for (const envPath of envPaths) {
    if (!envPath) continue;
    const rule = denyRuleFor(envPath);
    if (!deny.includes(rule)) {
      deny.push(rule);
      denyAdded.push(rule);
    }
  }

  if (!existed || hookAdded || denyAdded.length) writeJson(target, settings);
  return { created: !existed, hookAdded, denyAdded, path: target };
}

#!/usr/bin/env node
/**
 * PreToolUse hook — global secret-file guard (NOT part of the piecemaker
 * plugin; installed standalone in ~/.claude/hooks and wired directly in
 * ~/.claude/settings.json). It denies the *agent* any read of a configured
 * blocklist of sensitive files (typically a general .env holding API keys),
 * wherever the command is run from — unlike the piecemaker plugin's own
 * hooks, this one is not scoped to a legal-case directory.
 *
 * It must never block the PieceMaker node server itself: the server reads
 * its own .env directly on disk (dotenv, fs), never through this CLI, so it
 * is unaffected — this hook only intercepts Claude Code tool calls.
 *
 * `permissions.deny` alone stops the Read tool but not a Bash workaround
 * (`cat`, `grep`, `head`, `less`, `python -c "open(...)"`, …). This hook
 * closes that gap by parsing the Bash command the same defensive way the
 * piecemaker plugin's protect-originals.mjs parses shell commands (see
 * piecemaker-plugin/scripts/protect-originals.mjs), then resolving every
 * candidate path — and every blocklist entry — through `fs.realpathSync` so
 * a symlink or a /var vs /private/var alias (macOS) cannot slip past it.
 *
 * Blocklist sources (merged, deduplicated):
 *   1. Hard defaults below.
 *   2. ~/.claude/piecemaker-secret-paths.json — a JSON array of absolute
 *      paths, user-editable, no script change required.
 *   3. env var PIECEMAKER_SECRET_PATHS — colon-separated absolute paths,
 *      additive (used by tests to stay hermetic).
 *
 * Contract: one JSON payload on stdin (PreToolUse: tool_name, tool_input,
 * cwd). Exit 2 + stderr reason => blocked. Exit 0 with no stdout => allowed.
 * Never mixes the two signalling styles. Fails open on any internal error —
 * a bug in this guard must not be able to hang or crash a session, only to
 * (at worst) fail to protect a file it was never told about.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_FILE = path.join(os.homedir(), '.claude', 'piecemaker-secret-paths.json');

/** Never empty: at minimum, the general PieceMaker runtime .env. */
const DEFAULT_BLOCKLIST = [
  path.join(os.homedir(), 'PieceMaker', '.env'),
  path.join(os.homedir(), 'Sites', 'PieceMaker-Installer', '.env'),
];

const PATH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const MAX_COMMAND_LENGTH = 20_000;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { clearTimeout(timer); finish(); });
      process.stdin.on('error', () => { clearTimeout(timer); finish(); });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/** realpath if it exists, otherwise a normalized (but unresolved) absolute path. */
function bestEffortRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function loadBlocklist() {
  const entries = new Set(DEFAULT_BLOCKLIST);

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'string' && entry.trim()) entries.add(entry.trim());
        }
      }
    }
  } catch {
    // Malformed config must not disable the defaults.
  }

  const envList = process.env.PIECEMAKER_SECRET_PATHS;
  if (envList) {
    for (const entry of envList.split(':')) {
      if (entry.trim()) entries.add(entry.trim());
    }
  }

  // Resolve once, deduplicate by realpath so a symlink alias in the config
  // doesn't produce a second, redundant entry.
  const resolved = new Map();
  for (const entry of entries) {
    const expanded = entry.startsWith('~') ? path.join(os.homedir(), entry.slice(1)) : entry;
    const real = bestEffortRealpath(expanded);
    resolved.set(real, entry);
  }
  return resolved; // Map<realpath, originalConfiguredPath>
}

function absolutePath(value, cwd) {
  if (!value) return null;
  const raw = String(value);
  if (!raw) return null;
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

/**
 * Path-like candidates cited by a shell command. Two passes:
 *  1. Quote-aware top-level tokenizing (mirrors protect-originals.mjs).
 *  2. Within every token, a secondary scan for embedded path-like
 *     substrings — this is what catches `python3 -c "open('/a/b/.env')"`,
 *     where the outer double quotes become one token but the real path sits
 *     behind a *nested* single quote the first pass does not strip.
 */
function commandPathCandidates(command, cwd) {
  const text = String(command || '');
  if (!text || text.length > MAX_COMMAND_LENGTH) return [];

  const rawTokens = text.match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) || [];
  const candidates = new Set();

  for (const token of rawTokens) {
    const bare = token.replace(/^["']|["']$/g, '');
    if (!bare) continue;
    candidates.add(bare);

    const equals = bare.indexOf('=');
    if (equals > 0 && equals < bare.length - 1) candidates.add(bare.slice(equals + 1));

    // Embedded path-like runs inside the token (handles nested quoting).
    const embedded = bare.match(/[~/][^\s"'`;|&<>(){}[\],]*/g) || [];
    for (const piece of embedded) candidates.add(piece);
  }

  return [...candidates]
    .map((candidate) => absolutePath(candidate, cwd))
    .filter(Boolean);
}

function pathHitsBlocklist(candidate, blocklist) {
  if (!candidate) return null;
  if (!statSafe(candidate)) return null; // must resolve to a real, existing file
  const real = bestEffortRealpath(candidate);
  return blocklist.has(real) ? real : null;
}

function deny(reasonPath) {
  const message = `[PieceMaker] Accès refusé : « ${reasonPath} » figure sur la liste des fichiers sensibles bloqués pour l’agent (voir ~/.claude/piecemaker-secret-paths.json). Le contenu n’est jamais lisible par Claude Code, sous quelque forme d’outil que ce soit.`;
  process.stderr.write(message);
  process.exitCode = 2;
}

async function main() {
  const raw = await readStdin(2000);
  if (!raw || !raw.trim()) return; // nothing piped in (e.g. manual TTY run) -> allow
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return; // malformed payload -> fail open
  }

  const toolName = payload.tool_name;
  const cwd = payload.cwd || process.cwd();
  const blocklist = loadBlocklist();
  if (blocklist.size === 0) return;

  if (toolName === 'Bash') {
    for (const candidate of commandPathCandidates(payload.tool_input?.command, cwd)) {
      const hit = pathHitsBlocklist(candidate, blocklist);
      if (hit) return deny(hit);
    }
    // Belt-and-suspenders: a literal blocklisted path string anywhere in the
    // command text, even where extraction above missed the exact token
    // boundaries (unbalanced quoting, unusual shell constructs, …).
    const text = String(payload.tool_input?.command || '');
    for (const [real, configured] of blocklist) {
      if (text.includes(real) || (configured && text.includes(configured))) return deny(real);
    }
    return;
  }

  if (!PATH_TOOLS.has(toolName)) return;

  const targets = [
    payload.tool_input?.file_path,
    payload.tool_input?.path,
    payload.tool_input?.notebook_path,
  ].filter(Boolean);

  for (const raw_ of targets) {
    const candidate = absolutePath(raw_, cwd);
    const hit = pathHitsBlocklist(candidate, blocklist);
    if (hit) return deny(hit);
  }
}

main().catch(() => {
  // Any unexpected internal error fails open — this guard must never be
  // able to hang or crash a session.
});

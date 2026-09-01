#!/usr/bin/env node
/**
 * PostToolUse hook (Write|Bash) — classe en « espace de travail » tout document
 * que l'IA vient de créer dans un dossier juridique enregistré.
 *
 * La protection est une propriété du fichier et le coffre-fort est le défaut :
 * `.piecemaker/protection.json` n'enregistre que les exceptions. Sans ce hook,
 * un document produit par l'IA elle-même — `.docx` de `docx-cli`, export
 * pandoc/LibreOffice, fichier écrit par `Write` — naît protégé, et le
 * `PreToolUse` `protect-originals.mjs` lui en refuse ensuite la relecture. Il
 * n'y a pourtant rien à protéger de l'IA dans un fichier qu'elle a écrit.
 *
 * Le classement reste une *exception ajoutée* : rien de ce que l'IA n'a pas
 * nommé n'est déclassé, et une pièce marquée « ressource » n'est jamais
 * rétrogradée (voir `classifyAsWorkspace` dans lib/protection.cjs).
 *
 * Fail-open comme tous les hooks du plugin : hors dossier enregistré ou sur la
 * moindre erreur → exit 0, stdout vide.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadPieceMakerConfig,
  noop,
  readHookPayload,
  runHook,
} from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { classifyAsWorkspace } = require('./lib/protection.cjs');
const { locateConfiguredCase } = require('./lib/case-folders.cjs');

/**
 * Une commande Bash ne dit pas quel fichier elle a créé. On ne retient donc
 * qu'un chemin *nommé dans la commande* et écrit à l'instant : une pièce du
 * cabinet simplement citée (un `ls`, un chemin passé en lecture) garde sa date
 * d'origine et reste au coffre-fort.
 */
const FRESH_WINDOW_MS = 10 * 60 * 1000;

/** Jetons shell inexploitables tels quels : variables, globs, substitutions. */
const SHELL_METACHARACTERS = /[$*?`|<>(){}\[\]!]/;

/** Découpe grossière d'une commande : segments entre guillemets + jetons nus. */
function commandTokens(command) {
  const text = String(command || '');
  const tokens = [];
  const quoted = /'([^']*)'|"([^"]*)"/g;
  let match;
  while ((match = quoted.exec(text)) !== null) tokens.push(match[1] ?? match[2]);
  for (const token of text.replace(quoted, ' ').split(/\s+/)) tokens.push(token);
  return tokens
    .map((token) => String(token || '').replace(/^[<>=]+/, '').replace(/[;,)&]+$/, '').trim())
    .filter(Boolean);
}

/** Vrai pour un jeton qui ressemble à un chemin de fichier utilisable. */
function looksLikePath(token) {
  if (SHELL_METACHARACTERS.test(token)) return false;
  return token.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** Fichier régulier existant, écrit dans la fenêtre récente. */
function isFreshFile(absolute) {
  try {
    const stats = fs.statSync(absolute);
    if (!stats.isFile()) return false;
    const written = Math.max(stats.mtimeMs, stats.birthtimeMs || 0);
    return Date.now() - written <= FRESH_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Chemins candidats au classement, selon l'outil qui vient de s'exécuter. */
function candidatePaths(payload, cwd) {
  const absolute = (value) => (path.isAbsolute(value) ? value : path.resolve(cwd, value));

  if (payload.tool_name === 'Write') {
    const written = payload.tool_input?.file_path;
    return written ? [absolute(String(written))] : [];
  }

  if (payload.tool_name === 'Bash') {
    const seen = new Set();
    for (const token of commandTokens(payload.tool_input?.command)) {
      if (!looksLikePath(token)) continue;
      const resolved = absolute(token);
      if (seen.has(resolved)) continue;
      if (!isFreshFile(resolved)) continue;
      seen.add(resolved);
    }
    return [...seen];
  }

  return [];
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || !['Write', 'Bash'].includes(payload.tool_name)) return null;
  if (payload.tool_response?.success === false) return null;

  const config = loadPieceMakerConfig();
  if (config.classification?.enabled === false) return null;

  const cwd = payload.cwd || process.cwd();
  for (const absolute of candidatePaths(payload, cwd)) {
    let located;
    try {
      located = locateConfiguredCase(config, absolute);
    } catch {
      continue;
    }
    if (!located) continue;
    classifyAsWorkspace(absolute, located.caseRoot);
  }
  return null;
}

runHook(main, { timeoutMs: 5000 }).catch(() => noop());

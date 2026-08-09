#!/usr/bin/env node
/**
 * PreToolUse hook — frontière dure autour des pièces protégées d'un dossier.
 *
 * La protection est une propriété du fichier, décidée dans l'administration et
 * stockée dans `<dossier>/.piecemaker/protection.json` (voir `lib/protection.cjs`).
 * Elle ne dépend plus d'un sous-dossier « Pièces originales » : un cabinet range
 * ses pièces à plat, à côté du Markdown qu'il en tire, et cette organisation-là
 * ne protégeait rien.
 *
 * Un refus renvoie systématiquement vers le Markdown converti, qui est la
 * surface que l'IA a le droit de lire — anonymisée à la volée par
 * `anonymize-read.mjs`.
 *
 * Bash est traité comme les outils de lecture. C'est indispensable depuis que
 * le skill `docx` est disponible : il travaille par `pandoc`, `unzip` et
 * `python ooxml/scripts/unpack.py`, qui contournaient entièrement un garde-fou
 * limité à Read/Grep/Glob.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPieceMakerConfig, readHookPayload, runHook, noop } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { locateConfiguredCase } = require('./lib/case-folders.cjs');
const { isMappingFile, isProtectedFile, markdownCounterpart, readProtection } = require('./lib/protection.cjs');

/** Au-delà, on ne cherche pas de chemin : une commande pareille n'en cite pas un. */
const MAX_COMMAND_LENGTH = 20_000;

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  };
}

/**
 * Message de refus. Il doit rester actionnable : sans indication du Markdown à
 * lire, l'agent réessaie le même chemin sous une autre forme.
 */
function protectionReason(absolute, caseRoot) {
  const counterpart = markdownCounterpart(absolute, caseRoot);
  const head = `[PieceMaker] « ${path.basename(absolute)} » est une pièce protégée : son contenu original n’est pas accessible à l’IA.`;
  return counterpart.exists
    ? `${head} Lisez le Markdown anonymisé à la place : ${counterpart.path}`
    : `${head} Aucun Markdown n’a encore été produit pour cette pièce — lancez « Convertir en Markdown » dans l’administration PieceMaker, ou retirez sa protection si elle n’en a pas besoin.`;
}

/**
 * Le mapping et les scans PII sont hors d'atteinte, sans exception possible : le
 * mapping donne le nom réel derrière chaque code, un scan porte les entités en
 * clair. Une seule lecture annulerait toute la frontière — et ce refus-ci ne
 * renvoie vers rien, il n'existe pas de version anonymisée de ces fichiers.
 * L'administration y accède par ses propres routes, qui ne passent pas par les hooks.
 */
function mappingReason(absolute) {
  return `[PieceMaker] « ${path.basename(absolute)} » est le mapping d’anonymisation du dossier (ou un scan PII) : il n’est jamais accessible à l’IA. Consultez-le depuis l’administration PieceMaker si besoin.`;
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function absolutePath(value, cwd) {
  if (!value) return null;
  const raw = String(value);
  if (!raw) return null;
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

/**
 * Chemins cités par une commande shell. On ne cherche pas à parser le shell :
 * chaque mot (guillemets respectés) est un candidat, et seuls ceux qui tombent
 * sur un fichier protégé d'un dossier juridique comptent. Un faux positif est
 * impossible — il faudrait que le mot désigne réellement une pièce protégée.
 */
function commandPaths(command, cwd) {
  const text = String(command || '');
  if (!text || text.length > MAX_COMMAND_LENGTH) return [];
  const candidates = new Set();
  const tokens = text.match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) || [];
  for (const token of tokens) {
    const bare = token.replace(/^["']|["']$/g, '');
    if (!bare || bare.startsWith('-')) continue;
    candidates.add(bare);
    // `--input=/chemin/piece.pdf`, `of=piece.docx` : la valeur est le chemin.
    const equals = bare.indexOf('=');
    if (equals > 0 && equals < bare.length - 1) candidates.add(bare.slice(equals + 1));
  }
  // Seuls les mots qui désignent un fichier réellement présent comptent :
  // sans ce filtre, `pandoc` lui-même se résout en `<dossier>/pandoc`, un
  // chemin sans extension donc « protégé », et toute commande était refusée.
  return [...candidates]
    .map((candidate) => absolutePath(candidate, cwd))
    .filter((candidate) => candidate && statSafe(candidate)?.isFile());
}

/**
 * Un `Grep`/`Glob` lancé à la racine d'un dossier juridique parcourt les pièces
 * protégées et en ramène des extraits. On refuse à la première pièce protégée
 * rencontrée plutôt que de filtrer les résultats un à un.
 */
function isBroadCaseSearch(located) {
  if (!located) return false;
  // `located.absolute` est déjà passé par realpath, `caseRoot` aussi : comparer
  // un `path.resolve(target)` brut ne recouvrait jamais la racine sur macOS
  // (`/var/…` contre `/private/var/…`), et la recherche large passait toujours.
  if (located.absolute !== located.caseRoot) return false;
  const protection = readProtection(located.caseRoot);
  try {
    return fs.readdirSync(located.caseRoot, { withFileTypes: true })
      .some((entry) => entry.isFile()
        && isProtectedFile(path.join(located.caseRoot, entry.name), located.caseRoot, protection));
  } catch {
    // Dossier illisible : on refuse, faute de pouvoir prouver qu'il est sûr.
    return true;
  }
}

/** Le répertoire visé est la racine du dossier et un mapping y est posé. */
function caseRootHasMapping(located) {
  if (!located) return false;
  if (located.absolute !== located.caseRoot) return false;
  try {
    return fs.readdirSync(located.caseRoot).some((name) => isMappingFile(name));
  } catch {
    return true;
  }
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;
  const config = loadPieceMakerConfig();

  const toolName = payload.tool_name;
  const cwd = payload.cwd || process.cwd();

  if (toolName === 'Bash') {
    for (const candidate of commandPaths(payload.tool_input?.command, cwd)) {
      const located = locateConfiguredCase(config, candidate);
      if (!located) continue;
      if (isMappingFile(candidate)) return deny(mappingReason(candidate));
      if (isProtectedFile(candidate, located.caseRoot)) {
        return deny(protectionReason(candidate, located.caseRoot));
      }
    }
    return null;
  }

  if (!['Read', 'Grep', 'Glob'].includes(toolName)) return null;

  const target = absolutePath(payload.tool_input?.file_path || payload.tool_input?.path, cwd);
  if (!target) return null;
  const located = locateConfiguredCase(config, target);
  if (!located) return null;

  // Un répertoire n'est pas une pièce : `Grep`/`Glob` en visent un couramment,
  // et c'est `isBroadCaseSearch` qui décide s'il est sûr de le parcourir.
  if (isMappingFile(target)) return deny(mappingReason(target));

  const stat = statSafe(target);
  if (!stat?.isDirectory() && isProtectedFile(target, located.caseRoot)) {
    return deny(protectionReason(target, located.caseRoot));
  }

  // Un `Grep` récursif ramène le *contenu* du mapping ; un `Glob` n'en ramène
  // que le nom, qui ne trahit rien — d'où la restriction à Grep ici.
  if (toolName === 'Grep' && caseRootHasMapping(located)) {
    return deny(`[PieceMaker] Une recherche récursive à la racine de « ${located.caseName} » lirait le mapping d’anonymisation. Ciblez un fichier Markdown précis, ou un sous-dossier qui n’en contient pas.`);
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && isBroadCaseSearch(located)) {
    return deny(`[PieceMaker] Une recherche récursive à la racine de « ${located.caseName} » parcourrait des pièces protégées. Ciblez un fichier Markdown précis, ou un sous-dossier qui n’en contient pas.`);
  }
  return null;
}

runHook(main, { timeoutMs: 3000 }).catch(() => noop());

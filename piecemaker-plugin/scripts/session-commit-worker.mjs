#!/usr/bin/env node
/**
 * Worker détaché de l'auto-commit par tour.
 *
 * Lancé par `session-commit.mjs` (hook `Stop`) avec un unique argument : le
 * chemin du fichier de spool. Tout le travail Git — potentiellement lent —
 * vit ici, hors du tour de conversation :
 *
 *  - Le PÉRIMÈTRE du tour est l'union des dossiers de cas marqués pendant le
 *    tour (`~/.piecemaker/pending/<session_id>.json`, écrit par
 *    `commit-track.mjs` à chaque Write/Edit) et du dossier de cas contenant
 *    `cwd` — ce second terme rattrape ce qui a changé sans passer par
 *    Write/Edit (script, modification manuelle).
 *  - Le MESSAGE de chaque commit est la conclusion de l'IA
 *    (`last_assistant_message`), ré-identifiée via le mapping central puis
 *    complétée d'un pied déterministe (fichiers modifiés, durée de session,
 *    horodatage).
 *  - `createCommit` ne crée jamais de commit vide : aucun pré-test de
 *    propreté n'est fait ici.
 *
 * Le worker survit à la session qui l'a lancé : c'est voulu (`detached` +
 * `unref()` côté hook). La concurrence entre workers d'un même dossier est
 * déjà gérée par `withCaseLock` dans `createCommit`.
 *
 * Journal : ~/.piecemaker/auto-commit.log — seul témoin en cas d'échec, ce
 * process n'a plus personne à qui remonter une erreur.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HOME_DIR, loadPieceMakerConfig } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { createCommit, worktreeDetails } = require('./lib/commits.cjs');
const { locateConfiguredCase } = require('./lib/case-folders.cjs');
const { revertMapping } = require('./lib/mapping.cjs');
const { readCentralMapping } = require('./lib/central-mapping.cjs');
const { sessionElapsedMs, formatDurationFr } = require('./lib/session-timing.cjs');

const LOG_FILE = path.join(HOME_DIR, 'auto-commit.log');
// Une ligne par commit de tour ou presque : 512 Ko couvrent des mois. Au-delà,
// on bascule vers `.1` (une seule génération : le journal est un outil de
// diagnostic, pas une archive) — même politique que session-autocommit.mjs.
const MAX_LOG_BYTES = 512 * 1024;
const PENDING_DIR = path.join(HOME_DIR, 'pending');
const FALLBACK_LABEL = 'Modifications du tour';

let logContext = '';

/** Journalise sans jamais échouer : un worker muet ne doit pas mourir de son log. */
function log(level, message, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* pas de journal existant, ou rotation impossible */ }
    const details = extra ? ` ${JSON.stringify(extra)}` : '';
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${process.pid}] ${level} ${logContext}${message}${details}\n`,
    );
  } catch { /* fail-open : un journal indisponible n'empêche pas le commit */ }
}

/** Détail exploitable d'une erreur (le stderr git est porté sur `.stderr`). */
function describeError(error) {
  const stderr = (error?.stderr || '').toString().trim();
  const base = error?.message || String(error);
  return stderr ? `${base} | stderr: ${stderr}` : base;
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readSpool(spoolFile) {
  return JSON.parse(fs.readFileSync(spoolFile, 'utf8'));
}

/**
 * Consomme le fichier pending de la session : les dossiers marqués pendant le
 * tour par `commit-track.mjs`. Renommage avant lecture pour ne pas se
 * disputer le fichier avec une écriture concurrente improbable ; le fichier
 * renommé est supprimé après lecture (best-effort).
 */
function drainPendingCases(sessionId) {
  const file = path.join(PENDING_DIR, `${sanitizeSessionId(sessionId)}.json`);
  const staging = `${file}.${process.pid}.consuming`;
  try {
    fs.renameSync(file, staging);
  } catch (error) {
    if (error.code !== 'ENOENT') log('WARN', 'lecture du pending impossible', { file, error: describeError(error) });
    return [];
  }
  let cases = [];
  try {
    const raw = fs.readFileSync(staging, 'utf8');
    cases = raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((entry) => entry?.casesRoot && entry?.caseName);
  } catch (error) {
    log('WARN', 'pending illisible', { file: staging, error: describeError(error) });
  } finally {
    try { fs.unlinkSync(staging); } catch { /* best-effort */ }
  }
  return cases;
}

/** Retire les marqueurs Markdown de tête (titres, listes, citations, gras…). */
function cleanMarkdownHeading(line) {
  let text = String(line || '');
  let previous;
  do {
    previous = text;
    text = text.replace(/^\s*(?:#{1,6}|>{1,3}|[-*+•]{1,3}|`{1,3}|\*{1,3}|_{1,3})\s*/u, '');
  } while (text !== previous && text.length);
  return text.trim();
}

/** Première ligne (label) / reste (description) d'une conclusion d'IA. */
function splitConclusion(text) {
  if (!text || typeof text !== 'string') return { label: '', description: '' };
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return { label: '', description: '' };
  const lines = normalized.split('\n');
  return { label: lines[0] || '', description: lines.slice(1).join('\n').trim() };
}

/** Pied déterministe, une ligne : fichiers modifiés, durée de session, horodatage. */
function buildFooter({ fileCount, durationMs, timestamp }) {
  const bits = [];
  if (Number.isFinite(fileCount)) {
    bits.push(`${fileCount} fichier${fileCount > 1 ? 's' : ''} modifié${fileCount > 1 ? 's' : ''}`);
  }
  if (Number.isFinite(durationMs)) {
    const human = formatDurationFr(durationMs);
    if (human) bits.push(`durée de session ${human}`);
  }
  bits.push(timestamp);
  return `— ${bits.join(' · ')}`;
}

async function commitScopeCase({ casesRoot, caseName }, { label, descriptionBody, sessionId, durationMs }) {
  // Aperçu du nombre de fichiers modifiés pour le pied du message — avant le
  // commit lui-même, qui a besoin du message complet. `createCommit` reste
  // l'unique source de vérité sur ce qui est réellement commité : cet aperçu
  // ne sert qu'à documenter le message, jamais à décider s'il faut committer.
  let fileCount = null;
  try {
    const preview = await worktreeDetails(casesRoot, HOME_DIR, caseName);
    fileCount = preview.filesCount;
  } catch (error) {
    log('WARN', 'aperçu des modifications indisponible', { caseName, error: describeError(error) });
  }

  const footer = buildFooter({ fileCount, durationMs, timestamp: new Date().toISOString() });
  const description = descriptionBody ? `${descriptionBody}\n\n${footer}` : footer;

  try {
    const result = await createCommit({
      casesRoot,
      caseName,
      homeDir: HOME_DIR,
      label,
      description,
      paths: null, // arbre complet du dossier : tout ce qui a changé pendant le tour
      sessionId,
      durationMs,
      event: 'Stop',
      waitForLockMs: 10_000,
    });
    if (result?.skipped === 'busy') {
      log('SKIP', 'verrou occupé, commit de tour abandonné', { caseName });
    } else if (result?.created) {
      log('OK', 'commit de tour créé', {
        caseName,
        commit: result.commit ? result.commit.slice(0, 12) : null,
        files: result.files?.length ?? fileCount,
      });
    } else {
      log('SKIP', 'rien à committer', { caseName });
    }
  } catch (error) {
    log('ERROR', 'commit de tour échoué', { caseName, error: describeError(error) });
  }
}

async function main() {
  const spoolFile = process.argv[2];
  if (!spoolFile) {
    log('ERROR', 'aucun fichier de spool fourni');
    return;
  }

  let spoolData;
  try {
    spoolData = readSpool(spoolFile);
  } catch (error) {
    log('ERROR', 'lecture du spool échouée', { spoolFile, error: describeError(error) });
    return;
  } finally {
    // Le spool est un instantané transitoire : il a fait son office une fois lu.
    try { fs.unlinkSync(spoolFile); } catch { /* best-effort */ }
  }

  logContext = spoolData.session_id ? `session=${spoolData.session_id} ` : '';
  log('INFO', 'début du commit de tour', { cwd: spoolData.cwd });

  const config = loadPieceMakerConfig();
  if (config.commits?.enabled === false) {
    log('SKIP', 'commits désactivés par la configuration');
    return;
  }

  // Périmètre : dossiers marqués pendant le tour ∪ dossier de cas de cwd.
  const scope = new Map();
  for (const entry of drainPendingCases(spoolData.session_id)) {
    scope.set(`${entry.casesRoot} ${entry.caseName}`, { casesRoot: entry.casesRoot, caseName: entry.caseName });
  }
  if (spoolData.cwd) {
    try {
      const cwdCase = locateConfiguredCase(config, spoolData.cwd);
      if (cwdCase) {
        scope.set(`${cwdCase.casesRoot} ${cwdCase.caseName}`, { casesRoot: cwdCase.casesRoot, caseName: cwdCase.caseName });
      }
    } catch (error) {
      log('WARN', 'résolution du dossier courant impossible', { cwd: spoolData.cwd, error: describeError(error) });
    }
  }

  if (!scope.size) {
    log('SKIP', 'aucun dossier de cas dans le périmètre du tour');
    return;
  }

  // Message de commit = la conclusion de l'IA, ré-identifiée avec le mapping
  // central (le modèle n'a vu que des codes ; le cabinet ne voit que des noms).
  const central = readCentralMapping();
  const reverseMapping = central.reverse_mapping || {};
  const { label: rawLabel, description: rawDescription } = splitConclusion(spoolData.last_assistant_message);
  const revertedLabel = revertMapping(cleanMarkdownHeading(rawLabel), reverseMapping).trim();
  const label = (revertedLabel || FALLBACK_LABEL).slice(0, 140);
  const descriptionBody = revertMapping(rawDescription, reverseMapping).trim();
  const durationMs = sessionElapsedMs(spoolData.transcript_path);

  log('INFO', 'périmètre du tour établi', { cases: scope.size, label });

  for (const entry of scope.values()) {
    await commitScopeCase(entry, { label, descriptionBody, sessionId: spoolData.session_id, durationMs });
  }
}

main().catch((error) => {
  log('ERROR', 'échec inattendu du worker', { error: describeError(error) });
});

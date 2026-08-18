'use strict';

/**
 * Traçage déterministe des lectures dans un dossier de résultats Legifrance.
 *
 * L'outil MCP `Download_Query_Results` dépose un marqueur `.legifrance-results.json`
 * à la racine du dossier qu'il crée. Le hook `track-legifrance-reads.mjs` appelle
 * ces helpers à chaque `Read` : si le fichier lu est sous un tel dossier, la
 * lecture est enregistrée dans `.read-log.json` à la racine du dossier — un
 * journal purement mécanique de ce que l'agent de tri (Haiku) a réellement
 * ouvert. Aucun LLM, aucune analyse : juste un compteur.
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER_NAME = '.legifrance-results.json';
const READ_LOG_NAME = '.read-log.json';
// Fichiers internes au dossier que l'on ne trace pas (bruit).
const IGNORED = new Set([MARKER_NAME, READ_LOG_NAME]);

/**
 * Remonte depuis le fichier lu jusqu'à trouver la racine d'un dossier de
 * résultats (celle qui porte le marqueur). Borné pour ne jamais balayer tout
 * le disque. Renvoie le chemin absolu de la racine, ou null.
 */
function findResultsRoot(absoluteFilePath, { maxDepth = 8 } = {}) {
  if (!absoluteFilePath) return null;
  let dir = path.dirname(path.resolve(absoluteFilePath));
  for (let i = 0; i < maxDepth; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, MARKER_NAME))) return dir;
    } catch {
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // racine du système
    dir = parent;
  }
  return null;
}

function loadReadLog(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, READ_LOG_NAME), 'utf8'));
  } catch {
    return { kind: 'legifrance-read-log', reads: [], counts: {}, distinct: 0 };
  }
}

/**
 * Enregistre une lecture. `relFile` est le chemin du fichier lu, relatif à la
 * racine du dossier. Renvoie le journal mis à jour (aussi écrit sur disque).
 * Ne trace pas le marqueur ni le journal lui-même.
 */
function recordRead(root, relFile, meta = {}) {
  const normalized = relFile.split(path.sep).join('/');
  if (IGNORED.has(normalized)) return null;

  const log = loadReadLog(root);
  if (!log.counts) log.counts = {};
  if (!Array.isArray(log.reads)) log.reads = [];

  const firstTime = !(normalized in log.counts);
  log.counts[normalized] = (log.counts[normalized] || 0) + 1;
  log.reads.push({
    file: normalized,
    at: meta.at || new Date().toISOString(),
    ...(meta.sessionId ? { session: meta.sessionId } : {}),
    ...(meta.toolUseId ? { tool_use_id: meta.toolUseId } : {}),
  });
  log.distinct = Object.keys(log.counts).length;
  log.updated = meta.at || new Date().toISOString();

  fs.writeFileSync(path.join(root, READ_LOG_NAME), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  return { log, firstTime };
}

module.exports = {
  MARKER_NAME,
  READ_LOG_NAME,
  findResultsRoot,
  loadReadLog,
  recordRead,
};

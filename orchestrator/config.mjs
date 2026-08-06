/**
 * Registre de la session pilotée par le daemon de surveillance PieceMaker.
 *
 * Porté depuis « Lord of the bots », où la liste des projets et leurs chemins
 * étaient codés en dur. Ici tout vient de ~/.piecemaker/orchestrator/projects.json,
 * écrit par l'installateur et l'interface locale. L'Assistant général pointe
 * vers la racine des dossiers ; chaque sous-dossier peut ensuite recevoir son
 * propre Assistant. Le daemon reste un processus déterministe sans LLM.
 *
 * Format :
 * {
 *   "assistantName": "Assistant PieceMaker",
 *   "daemonName": "PieceMaker Monitor",
 *   "projects": [
 *     { "name": "piecemaker", "workdir": "/chemin/vers/le/projet",
 *       "aliases": ["pm", "cli"], "permissionMode": "auto" }
 *   ]
 * }
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ORCHESTRATOR_DIR = join(homedir(), '.piecemaker', 'orchestrator');
export const PROJECTS_FILE = join(ORCHESTRATOR_DIR, 'projects.json');

/** State dir du daemon lui-même — distinct de celui de l'Assistant Bot. */
export const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-piecemaker-lord');

function readConfig() {
  if (!existsSync(PROJECTS_FILE)) return { projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(parsed)) return { projects: parsed };
    return parsed && typeof parsed === 'object' ? parsed : { projects: [] };
  } catch (error) {
    console.error(`[piecemaker] projects.json illisible : ${error.message}`);
    return { projects: [] };
  }
}

const CONFIG = readConfig();
const ENTRIES = Array.isArray(CONFIG.projects)
  ? CONFIG.projects.filter((p) => p && typeof p.name === 'string' && typeof p.workdir === 'string')
  : [];

/** Nom d'affichage du daemon, modifiable en relançant l'étape Telegram. */
export const DAEMON_NAME = String(CONFIG.daemonName || 'PieceMaker Monitor').trim().slice(0, 64)
  || 'PieceMaker Monitor';

/** Noms canoniques, dans l'ordre de déclaration. */
export const PROJECTS = ENTRIES.map((p) => p.name);

/** Alias -> nom canonique. Le nom lui-même est toujours un alias valide. */
export const ALIAS = (() => {
  const map = { all: 'all' };
  for (const entry of ENTRIES) {
    map[entry.name.toLowerCase()] = entry.name;
    for (const alias of entry.aliases || []) map[String(alias).toLowerCase()] = entry.name;
  }
  return map;
})();

export function resolveTarget(raw) {
  return ALIAS[String(raw || '').replace(/^@/, '').toLowerCase()] || null;
}

export function workdirFor(name) {
  return ENTRIES.find((p) => p.name === name)?.workdir || '';
}

/** bypassPermissions reste possible mais n'est jamais le défaut. */
export function permModeFor(name) {
  return ENTRIES.find((p) => p.name === name)?.permissionMode || 'auto';
}

export function isConfigured() {
  return ENTRIES.length > 0;
}

/**
 * nom -> dossier de travail. Sert à rattacher un transcript à un projet par son
 * champ `cwd`, jamais par déduction sur le chemin.
 */
export const WORKDIRS = Object.fromEntries(ENTRIES.map((p) => [p.name, p.workdir]));

/** Cibles affichées dans l'aide, ex. « `@pm` `@app` ». */
export function targetList() {
  return PROJECTS.map((p) => `\`@${p}\``).join(' ') || '_(aucun projet déclaré)_';
}

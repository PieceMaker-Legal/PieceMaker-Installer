/**
 * Registre des projets pilotés par le superviseur PieceMaker.
 *
 * Porté depuis « Lord of the bots », où la liste des projets et leurs chemins
 * étaient codés en dur. Ici tout vient de ~/.piecemaker/orchestrator/projects.json,
 * écrit par l'installateur : le superviseur est livré vide et prêt à recevoir
 * les bots que l'utilisateur déclare.
 *
 * Format :
 * {
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

/** State dir du superviseur lui-même — distinct des state dirs par projet. */
export const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram-piecemaker-lord');

function readProjects() {
  if (!existsSync(PROJECTS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.projects;
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && typeof p.name === 'string' && typeof p.workdir === 'string');
  } catch (error) {
    console.error(`[piecemaker] projects.json illisible : ${error.message}`);
    return [];
  }
}

const ENTRIES = readProjects();

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

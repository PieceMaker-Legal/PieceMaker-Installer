#!/usr/bin/env node
// Hook SessionEnd : à la fin de CHAQUE session Claude Code dans ce dépôt,
// capture l'état du working tree dans un commit automatique sur une branche
// dédiée (défaut : sessions/auto), avec une synthèse DÉTERMINISTE de la
// session — durée, demandes de l'utilisateur, fichiers touchés, nombre de
// tours — tirée du transcript JSONL. AUCUN LLM, aucun réseau.
//
// Propriétés voulues :
//   - Les fichiers sur disque ne sont jamais réécrits ni déplacés. On fabrique
//     un commit en plumbing (add -A → write-tree → commit-tree → update-ref)
//     sur la branche dédiée, puis `git reset` remet l'index sur HEAD. main
//     (HEAD) reste intact, le working tree reste exactement tel quel : rien
//     n'est perdu, on continue de travailler sur main sans staged surprise.
//   - Le bruit des commits de session reste HORS de main, sur sa branche.
//   - Ne bloque JAMAIS la session : toute erreur => exit 0 silencieux.
//   - Aucune sortie de contenu de pièce : le message ne porte que des chemins
//     et les demandes de l'utilisateur (jamais le contenu des documents).
//
// Variables :
//   PIECEMAKER_AUTOCOMMIT_BRANCH  branche cible (défaut : sessions/auto)

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const BRANCH = process.env.PIECEMAKER_AUTOCOMMIT_BRANCH || 'sessions/auto';
const MAX_REQUESTS = 6;
const MAX_FILES = 25;

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// Extrait les demandes utilisateur « réelles » (pas les tool_result, pas les
// blocs de commande <command-...>, pas les slash-commands de contrôle).
function collectRequests(parsed) {
  const out = [];
  for (const e of parsed) {
    if (!e || e.type !== 'user') continue;
    const c = e.message?.content;
    let text = '';
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      if (c.every((p) => p?.type === 'tool_result')) continue; // tour outil
      text = c.filter((p) => p?.type === 'text').map((p) => p.text || '').join(' ');
    }
    text = (text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.startsWith('<')) continue;                 // <command-name> etc.
    if (text.toLowerCase().includes('local-command')) continue;
    if (/^\/(clear|compact|resume|cost|help)\b/.test(text)) continue;
    out.push(text.length > 120 ? `${text.slice(0, 117)}…` : text);
  }
  return [...new Set(out)].slice(0, MAX_REQUESTS);
}

function buildSummary(payload, root) {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');

  // Fichiers touchés (statut porcelain, chemins non échappés).
  let porcelain = '';
  try { porcelain = git(['-c', 'core.quotepath=false', 'status', '--porcelain'], root); } catch {}
  const fileLines = porcelain.split('\n').filter(Boolean);
  const nFiles = fileLines.length;

  // Transcript : durée, demandes, tours assistant.
  let durationMin = null;
  let requests = [];
  let assistantTurns = 0;
  const tp = payload.transcript_path;
  if (tp) {
    try {
      const parsed = readFileSync(tp, 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      const ts = parsed
        .map((e) => Date.parse(e.timestamp))
        .filter((n) => !Number.isNaN(n));
      if (ts.length >= 2) durationMin = Math.round((Math.max(...ts) - Math.min(...ts)) / 60000);
      assistantTurns = parsed.filter((e) => e.type === 'assistant').length;
      requests = collectRequests(parsed);
    } catch {}
  }

  const bits = [`${nFiles} fichier${nFiles > 1 ? 's' : ''}`];
  if (durationMin != null) bits.unshift(`${durationMin} min`);
  if (assistantTurns) bits.push(`${assistantTurns} tour${assistantTurns > 1 ? 's' : ''}`);
  const subject = `session auto — ${stamp} · ${bits.join(' · ')}`;

  const parts = [subject, ''];
  if (requests.length) {
    parts.push('Demandes :');
    for (const r of requests) parts.push(`- ${r}`);
    parts.push('');
  }
  parts.push('Fichiers :');
  for (const line of fileLines.slice(0, MAX_FILES)) parts.push(` ${line}`);
  if (nFiles > MAX_FILES) parts.push(` …(+${nFiles - MAX_FILES})`);
  parts.push('');
  parts.push('[commit auto de fin de session — hook SessionEnd]');
  return parts.join('\n');
}

function main() {
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch {}
  const startCwd = payload.cwd || process.cwd();

  // Racine du dépôt (robuste à un cwd en sous-dossier).
  let root;
  try { root = git(['rev-parse', '--show-toplevel'], startCwd); } catch { process.exit(0); }
  if (!root) process.exit(0);

  // Rien de modifié → aucun commit (jamais de commit vide).
  let dirty;
  try { dirty = git(['status', '--porcelain'], root); } catch { process.exit(0); }
  if (!dirty) process.exit(0);

  const message = buildSummary(payload, root);

  try {
    git(['add', '-A'], root);
    const tree = git(['write-tree'], root);

    let parent = '';
    try { parent = git(['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], root); } catch { parent = ''; }
    if (!parent) {
      try { parent = git(['rev-parse', 'HEAD'], root); } catch { process.exit(0); }
    }

    const commit = git(['commit-tree', tree, '-p', parent, '-m', message], root);
    git(['update-ref', `refs/heads/${BRANCH}`, commit], root);
  } catch {
    // fail-open
  } finally {
    // Toujours restaurer l'index sur HEAD : working tree préservé, main sans
    // fichiers staged. Rien n'est perdu même si le commit a échoué.
    try { git(['reset', '-q'], root); } catch {}
  }
  process.exit(0);
}

main();

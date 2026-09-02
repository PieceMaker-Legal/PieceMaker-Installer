#!/usr/bin/env node
// Hook Stop : à chaque tour de CHAQUE session Claude Code dans ce dépôt,
// capture l'état du working tree dans un commit automatique sur une branche
// dédiée (défaut : sessions/auto), avec une synthèse DÉTERMINISTE — durée,
// demandes de l'utilisateur ou dernier message assistant, fichiers touchés,
// nombre de tours — tirée du payload et du transcript JSONL. AUCUN LLM,
// aucun réseau.
//
// Propriétés voulues :
//   - Les fichiers sur disque ne sont jamais réécrits ni déplacés. On fabrique
//     un commit en plumbing (add -A → write-tree → commit-tree → update-ref)
//     sur la branche dédiée, en travaillant sur une COPIE TEMPORAIRE de
//     l'index git (GIT_INDEX_FILE) : l'index réel — et donc tout `git add -p`
//     en cours de l'utilisateur — n'est jamais touché. main (HEAD) reste
//     intact, le working tree reste exactement tel quel : rien n'est perdu,
//     et `git status` de l'utilisateur (staging compris) est strictement
//     inchangé après passage du hook.
//   - Le bruit des commits de session reste HORS de main, sur sa branche.
//   - Ne bloque JAMAIS la session : le hook tourne à CHAQUE tour (Stop), donc
//     toute sortie autre que 0 — et en particulier le code 2, qui bloque
//     l'arrêt de Claude — ferait boucler indéfiniment la session. Le script
//     est fail-open de bout en bout (try/catch partout + filet
//     uncaughtException/unhandledRejection) et sort TOUJOURS en 0.
//   - Aucune sortie de contenu de pièce : le message ne porte que des chemins
//     et des demandes/réponses de l'utilisateur/assistant (jamais le contenu
//     des documents).
//   - Un working tree déjà propre (rien à committer, cas le plus fréquent
//     tour après tour) ressort en SKIP sans toucher à l'index : coût
//     négligeable.
//
// Journal : chaque exécution trace sa décision et ses erreurs dans
// ~/.piecemaker/session-autocommit.log. Le hook restant fail-open et muet,
// c'est la SEULE façon de distinguer « rien à committer » (cas nominal, le
// plus fréquent : le travail a déjà été commité sur main) d'une vraie panne.
//
// Variables :
//   PIECEMAKER_AUTOCOMMIT_BRANCH  branche cible (défaut : sessions/auto)
//   PIECEMAKER_AUTOCOMMIT_LOG     fichier de journal (défaut ci-dessus)

import {
  appendFileSync, copyFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const BRANCH = process.env.PIECEMAKER_AUTOCOMMIT_BRANCH || 'sessions/auto';
const MAX_REQUESTS = 6;
const MAX_FILES = 25;
const LOG_FILE = process.env.PIECEMAKER_AUTOCOMMIT_LOG
  || path.join(os.homedir(), '.piecemaker', 'session-autocommit.log');
// Une ligne par exécution ou presque : 512 Ko couvrent des mois. Au-delà, on
// bascule vers `.1` (une seule génération : le journal est un outil de
// diagnostic, pas une archive).
const MAX_LOG_BYTES = 512 * 1024;

let logContext = '';

/** Journalise sans jamais échouer : un hook muet ne doit pas mourir de son log. */
function log(level, message, extra) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_LOG_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* pas de journal existant, ou rotation impossible */ }
    const details = extra ? ` ${JSON.stringify(extra)}` : '';
    appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${process.pid}] ${level} ${logContext}${message}${details}\n`,
    );
  } catch { /* fail-open : un journal indisponible n'empêche pas le commit */ }
}

/** Détail exploitable d'une erreur (execFileSync porte le stderr sur .stderr). */
function describe(error) {
  const stderr = (error?.stderr || '').toString().trim();
  const base = error?.message || String(error);
  return stderr ? `${base} | stderr: ${stderr}` : base;
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch (error) {
    log('WARN', 'stdin illisible', { error: describe(error) });
    return '';
  }
}

// stderr est capturé (et non jeté) pour que les échecs git soient
// diagnosticables dans le journal. `env` permet de pointer GIT_INDEX_FILE
// sur l'index temporaire sans jamais toucher aux variables d'environnement
// du process ni à l'index réel du dépôt.
function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
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

  // Fichiers touchés (statut porcelain, chemins non échappés). Lu sur
  // l'index réel : c'est un simple `status`, rien n'est modifié.
  let porcelain = '';
  try {
    porcelain = git(['-c', 'core.quotepath=false', 'status', '--porcelain'], root);
  } catch (error) {
    log('WARN', 'status --porcelain indisponible pour la synthèse', { error: describe(error) });
  }
  const fileLines = porcelain.split('\n').filter(Boolean);
  const nFiles = fileLines.length;

  // Transcript : durée, demandes, tours assistant.
  let durationMin = null;
  let requests = [];
  let assistantTurns = 0;
  const tp = payload.transcript_path;
  if (!tp) {
    log('WARN', 'aucun transcript_path dans le payload : synthèse sans durée ni demandes');
  } else {
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
    } catch (error) {
      log('WARN', 'transcript illisible', { transcript: tp, error: describe(error) });
    }
  }

  const bits = [`${nFiles} fichier${nFiles > 1 ? 's' : ''}`];
  if (durationMin != null) bits.unshift(`${durationMin} min`);
  if (assistantTurns) bits.push(`${assistantTurns} tour${assistantTurns > 1 ? 's' : ''}`);
  const repere = bits.join(' · ');

  // Sujet + corps : le dernier message assistant du payload Stop quand il est
  // fourni (première ligne en sujet, suite en corps) ; sinon la synthèse
  // déterministe habituelle (demandes utilisateur extraites du transcript).
  // Dans les deux cas, le pied déterministe (fichiers/durée/tours) est
  // conservé.
  const lastMessage = typeof payload.last_assistant_message === 'string'
    ? payload.last_assistant_message.trim()
    : '';
  const parts = [];
  if (lastMessage) {
    const lines = lastMessage.split('\n');
    parts.push(lines[0].trim() || `session auto — ${stamp}`);
    parts.push('');
    const body = lines.slice(1).join('\n').trim();
    if (body) parts.push(body, '');
    parts.push(`Repère : ${repere}`);
    parts.push('');
  } else {
    parts.push(`session auto — ${stamp} · ${repere}`);
    parts.push('');
    if (requests.length) {
      parts.push('Demandes :');
      for (const r of requests) parts.push(`- ${r}`);
      parts.push('');
    }
  }
  parts.push('Fichiers :');
  for (const line of fileLines.slice(0, MAX_FILES)) parts.push(` ${line}`);
  if (nFiles > MAX_FILES) parts.push(` …(+${nFiles - MAX_FILES})`);
  parts.push('');
  parts.push('[commit auto — hook Stop]');
  return { message: parts.join('\n'), nFiles, durationMin, assistantTurns };
}

/** Chemin absolu du répertoire git (robuste aux worktrees). */
function resolveGitDir(root) {
  try {
    const abs = git(['rev-parse', '--absolute-git-dir'], root);
    if (abs) return abs;
  } catch { /* git ancien sans --absolute-git-dir : repli ci-dessous */ }
  const rel = git(['rev-parse', '--git-dir'], root);
  return path.resolve(root, rel);
}

// Fabrique le commit de session en plumbing, sur une COPIE TEMPORAIRE de
// l'index (GIT_INDEX_FILE) : l'index réel du dépôt (et tout `git add -p` de
// l'utilisateur) n'est jamais lu ni écrit. Aucun `git reset` n'est nécessaire
// puisque l'index réel n'a jamais bougé.
function createSessionCommit(root, message) {
  let tempIndex = '';
  try {
    const gitDir = resolveGitDir(root);
    tempIndex = path.join(gitDir, `index.piecemaker-autocommit.${process.pid}.${Date.now()}`);
    try {
      copyFileSync(path.join(gitDir, 'index'), tempIndex);
    } catch (error) {
      // Dépôt tout neuf sans index existant : GIT_INDEX_FILE démarre vide,
      // ce qui reste cohérent (rien n'était staged de toute façon).
      if (error?.code !== 'ENOENT') throw error;
    }

    const indexEnv = { GIT_INDEX_FILE: tempIndex };
    git(['add', '-A'], root, indexEnv);
    const tree = git(['write-tree'], root, indexEnv);

    let parent = '';
    try { parent = git(['rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`], root); } catch { parent = ''; }
    if (!parent) {
      log('INFO', `branche ${BRANCH} absente : rattachement à HEAD`);
      try { parent = git(['rev-parse', 'HEAD'], root); } catch (error) {
        return { ok: false, reason: 'HEAD introuvable (dépôt sans commit ?)', error: describe(error) };
      }
    }

    const commit = git(['commit-tree', tree, '-p', parent, '-m', message], root);
    git(['update-ref', `refs/heads/${BRANCH}`, commit], root);
    return { ok: true, commit, parent };
  } catch (error) {
    return { ok: false, reason: 'création du commit de session échouée', error: describe(error) };
  } finally {
    // Toujours nettoyer la copie temporaire ; l'index réel n'a jamais été
    // touché, donc rien d'autre à restaurer.
    if (tempIndex) {
      try { unlinkSync(tempIndex); } catch { /* déjà absente, ou jamais créée */ }
    }
  }
}

function main() {
  let payload = {};
  const raw = readStdin();
  try { payload = JSON.parse(raw || '{}'); } catch (error) {
    log('WARN', 'payload JSON invalide', { bytes: raw.length, error: describe(error) });
  }
  const startCwd = payload.cwd || process.cwd();
  logContext = payload.session_id ? `session=${payload.session_id} ` : '';
  log('INFO', 'début', {
    cwd: startCwd, branche: BRANCH, stopHookActive: payload.stop_hook_active ?? null,
  });

  // Racine du dépôt (robuste à un cwd en sous-dossier).
  let root;
  try { root = git(['rev-parse', '--show-toplevel'], startCwd); } catch (error) {
    log('SKIP', 'pas un dépôt git', { cwd: startCwd, error: describe(error) });
    process.exit(0);
  }
  if (!root) {
    log('SKIP', 'racine de dépôt vide');
    process.exit(0);
  }

  // Rien de modifié → aucun commit (jamais de commit vide), et surtout aucune
  // manipulation d'index : le cas le plus fréquent (arbre déjà propre à
  // chaque tour) reste à coût négligeable.
  let dirty;
  try { dirty = git(['status', '--porcelain'], root); } catch (error) {
    log('ERROR', 'git status a échoué', { root, error: describe(error) });
    process.exit(0);
  }
  if (!dirty) {
    // Cas nominal quand le travail a déjà été commité sur main pendant la
    // session : il n'y a rien à capturer, l'absence de commit est correcte.
    log('SKIP', 'working tree propre : rien à committer', { root });
    process.exit(0);
  }

  const { message, nFiles, durationMin, assistantTurns } = buildSummary(payload, root);
  const result = createSessionCommit(root, message);
  if (result.ok) {
    log('OK', 'commit de session créé', {
      commit: result.commit, branche: BRANCH, parent: result.parent,
      fichiers: nFiles, durationMin, assistantTurns,
    });
  } else {
    log('ERROR', result.reason, { root, error: result.error });
  }
  process.exit(0);
}

// Filet de sécurité ultime : le hook Stop tourne à chaque tour, donc toute
// sortie autre que 0 (et en particulier une exception non interceptée qui
// ferait sortir node en 1, ou pire) doit rester impossible.
process.on('uncaughtException', (error) => {
  log('ERROR', 'exception non interceptée : sortie forcée en 0', { error: describe(error) });
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  log('ERROR', 'rejet de promesse non intercepté : sortie forcée en 0', { error: describe(error) });
  process.exit(0);
});

try {
  main();
} catch (error) {
  log('ERROR', 'main() a levé une exception : sortie forcée en 0', { error: describe(error) });
  process.exit(0);
}

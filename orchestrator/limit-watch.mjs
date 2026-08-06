#!/usr/bin/env node
// Surveillance INDÉPENDANTE des limites d'abonnement Claude.
//
// Pourquoi : le hook Stop (report-cycle.mjs) n'alerte que s'il se déclenche
// pile au moment où la limite tombe. Si la limite coupe le tour sans lancer le
// Stop, l'alerte est ratée. Ce watcher scanne périodiquement les transcripts
// des sessions bridgées et alerte même quand le Stop n'est pas parti.
//
// Détection FONDÉE SUR DONNÉES RÉELLES (89 événements de limite observés dans
// ~/.claude/projects, aucun deviné) : chaque limite est une ligne assistant
// avec `isApiErrorMessage:true`, `error:"rate_limit"`, `apiErrorStatus:429`, et
// un texte `"You've hit your session limit · resets 7pm (Europe/Paris)"`.
// On EXCLUT les 500/server_error (transitoires) et les erreurs d'auth.
//
// Deux modes :
//   - importé par lord-daemon.mjs → checkLimits() appelé sur un intervalle ;
//   - standalone `node limit-watch.mjs` → boucle autonome avec son propre envoi
//     Telegram (même token Lord que report-cycle.mjs).
//
// Ne signe/exécute rien, ne touche aucune session : lecture seule + un sendMessage.

import {
  readFileSync, writeFileSync, openSync, readSync, fstatSync, closeSync,
  readdirSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHANNEL_ROOT = join(homedir(), '.claude', 'channels');
const LORD_DIR = join(CHANNEL_ROOT, 'telegram-piecemaker-lord');
// Ledger surchargeable (tests) via LIMIT_LEDGER ; défaut = state-dir du superviseur.
const LEDGER = process.env.LIMIT_LEDGER || join(LORD_DIR, 'limit-alerts.json');
const PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

// Dossier de travail de chaque session bridgée (doit rester aligné avec
// launch-telegram.sh ▸ workdir_for). Sert à mapper un transcript → un projet
// par son champ `cwd` (pas par l'encodage du chemin, jamais deviné).
// Importé ET ré-exporté : `export … from` ne crée pas de liaison locale, or
// checkLimits() s'en sert comme valeur par défaut plus bas.
import { WORKDIRS } from './config.mjs';

export { WORKDIRS };

// Fenêtre de fraîcheur : on n'inspecte que les transcripts modifiés récemment.
// Quand une limite tombe, la ligne d'erreur est écrite → mtime fraîche. La
// déduplication (ledger) garantit qu'on n'alerte qu'une fois même si le watcher
// repasse dessus. Surchargable pour les tests.
const DEFAULT_WINDOW_MS = 20 * 60 * 1000;
const TAIL_BYTES = 1 << 20; // 1 Mo : contient toujours le dernier tour assistant

// ---------------------------------------------------------------------------
// Détection

// Une ligne de transcript est-elle une VRAIE limite d'abonnement (pas un 500) ?
export function isLimitEntry(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.isApiErrorMessage) return false;
  // Signal structuré prioritaire, observé sur 89/89 limites réelles.
  if (entry.error === 'rate_limit' || entry.apiErrorStatus === 429) return true;
  // Filet pour la limite de crédits Fable (« You've reached your Fable 5 limit »),
  // dont le champ error peut différer. On reste strict sur le format du texte.
  const txt = entryText(entry);
  return /you've (hit|reached) your .*\blimit\b/i.test(txt);
}

// Extrait le texte affichable d'une ligne (le message porte l'heure de reset).
export function entryText(entry) {
  const c = entry?.message?.content;
  if (Array.isArray(c)) return c.map((p) => (p && p.text) || '').join('').trim();
  if (typeof c === 'string') return c.trim();
  return '';
}

// Parse un transcript (texte JSONL) et renvoie l'état de limite COURANT :
// { active, text, sessionId, cwd }. `active` = la ligne de limite est le tout
// dernier tour assistant (⇒ la session est en pause maintenant, pas reprise).
export function detectPausedLimit(jsonl) {
  const lines = jsonl.split('\n');
  let lastAssistant = null;
  let lastLimit = null;
  let sessionId = null;
  let cwd = null;
  for (const line of lines) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId) sessionId = e.sessionId;
    if (e.cwd) cwd = e.cwd;
    if (e.type !== 'assistant') continue;
    lastAssistant = e;
    if (isLimitEntry(e)) lastLimit = e; else lastLimit = null; // un tour normal « annule » la pause
  }
  if (lastAssistant && lastLimit && lastAssistant === lastLimit) {
    return {
      active: true,
      text: entryText(lastLimit),
      sessionId: lastLimit.sessionId || sessionId || null,
      cwd: lastLimit.cwd || cwd || null,
    };
  }
  return { active: false, text: '', sessionId, cwd };
}

// Lit les derniers `maxBytes` octets d'un fichier (le dernier tour assistant est
// toujours proche de la fin). Repli sur lecture complète si besoin.
export function readTail(path, maxBytes = TAIL_BYTES) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    let txt = buf.toString('utf8');
    // Si on a coupé au milieu d'une ligne, jette la première (partielle).
    if (start > 0) { const nl = txt.indexOf('\n'); if (nl >= 0) txt = txt.slice(nl + 1); }
    return txt;
  } finally { closeSync(fd); }
}

// ---------------------------------------------------------------------------
// Ledger de déduplication (partagé avec report-cycle.mjs)

export function readLedger() {
  try { return JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}
export function writeLedger(obj) {
  try { writeFileSync(LEDGER, JSON.stringify(obj)); } catch {}
}
// Signature d'une limite pour une session : sessionId + texte (contient l'heure
// de reset). On n'alerte que si elle a changé depuis la dernière alerte.
export function limitSignature(sessionId, text) { return `${sessionId || '?'}::${text}`; }

// True si cette limite précise a déjà été signalée (par le hook OU le watcher).
export function alreadyAlerted(ledger, sessionId, text) {
  return ledger[sessionId || '?'] === limitSignature(sessionId, text);
}
export function markAlerted(sessionId, text) {
  const l = readLedger();
  l[sessionId || '?'] = limitSignature(sessionId, text);
  writeLedger(l);
}

// ---------------------------------------------------------------------------
// Localisation des transcripts vivants

// Liste les transcripts .jsonl de TOUS les projets modifiés depuis < windowMs,
// triés du plus récent au plus ancien. Encodage des chemins non deviné : on lit
// le `cwd` DANS le fichier pour rattacher au projet.
export function recentTranscripts(windowMs = DEFAULT_WINDOW_MS, now = Date.now(), root = PROJECTS_ROOT) {
  const out = [];
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const dir = join(root, d);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (now - st.mtimeMs <= windowMs) out.push({ path: p, mtime: st.mtimeMs });
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// Orchestration

// Scanne les transcripts récents, mappe au projet par cwd, et pour chaque
// session en pause NON encore signalée, appelle send(project, text). Ne
// considère un projet que si isActive(project) (poller bridgé vivant) — évite
// d'alerter sur une session de dev CLI ou une session morte.
export async function checkLimits({
  send,
  isActive = () => true,
  workdirs = WORKDIRS,
  windowMs = DEFAULT_WINDOW_MS,
  now = Date.now(),
  root = PROJECTS_ROOT,
} = {}) {
  const cwdToProject = new Map(Object.entries(workdirs).map(([p, wd]) => [wd, p]));
  const ledger = readLedger();
  const seenProjects = new Set(); // un seul transcript (le + récent) par projet
  const alerts = [];

  for (const { path } of recentTranscripts(windowMs, now, root)) {
    let jsonl;
    try { jsonl = readTail(path); } catch { continue; }
    const st = detectPausedLimit(jsonl);
    if (!st.active) continue;
    const project = st.cwd && cwdToProject.get(st.cwd);
    if (!project) continue;                 // pas une session Lord surveillée
    if (seenProjects.has(project)) continue; // déjà traité le transcript le + récent
    seenProjects.add(project);
    if (!isActive(project)) continue;        // aucun poller bridgé vivant → on ignore
    if (alreadyAlerted(ledger, st.sessionId, st.text)) continue;
    markAlerted(st.sessionId, st.text);
    alerts.push({ project, text: st.text, sessionId: st.sessionId });
  }

  for (const a of alerts) {
    const now2 = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const msg =
      `⛔ *${a.project}* — limite atteinte (${now2})\n` +
      `${a.text}\n` +
      `_Session en pause jusqu'au reset._ · _détecté par surveillance_`;
    try { await send(a.project, msg); } catch {}
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Mode standalone : envoi Telegram autonome (même token Lord que le hook)

function readToken() {
  try {
    const raw = readFileSync(join(LORD_DIR, '.env'), 'utf8');
    const m = raw.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// isActive : un poller bridgé du projet est-il vivant ? (bot.pid validé)
function isActiveStandalone(project) {
  const file = join(CHANNEL_ROOT, `telegram-${project}`, 'bot.pid');
  let pid = 0;
  try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  const token = readToken();
  const CHAT_ID = process.env.CHAT_ID || '5609576448';
  if (!token) { console.error('[limit-watch] token Lord introuvable — arrêt'); process.exit(0); }

  const send = async (_project, text) => {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' }),
    }).catch(() => {});
  };

  const POLL_MS = Number(process.env.POLL_MS) || 30000;
  const once = process.env.ONCE === '1';
  const run = () => checkLimits({ send, isActive: isActiveStandalone })
    .then((a) => { if (a.length) console.error(`[limit-watch] ${a.length} alerte(s) envoyée(s)`); })
    .catch((e) => console.error('[limit-watch]', e?.message || e));

  await run();
  if (once) return;
  console.error(`[limit-watch] démarré (poll ${POLL_MS} ms)`);
  setInterval(run, POLL_MS);
}

// Exécuté directement (pas importé) ?
if (import.meta.url === `file://${process.argv[1]}`) main();

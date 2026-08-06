#!/usr/bin/env node
// Stop hook: à la fin de chaque cycle de réflexion Claude, envoie un rapport
// (tokens utilisés) sur Telegram via le daemon nommé par l'utilisateur.
// AUCUN LLM, aucune session conversationnelle.
//
// Câblage (dans le .claude/settings.json de CHAQUE session projet) :
//   "hooks": { "Stop": [ { "hooks": [ {
//       "type": "command",
//       "command": "PROJECT=trading node '/Users/tsardet/Sites/00 - Lord of the bots/report-cycle.mjs'"
//   } ] } ] }
//
// Variables :
//   PROJECT   label affiché (trading|app|dashboard|website). Défaut = basename(cwd).
//   LORD_ENV  chemin du .env contenant le token Lord. Défaut = state-dir telegram-lord.
//   CHAT_ID   destinataire. Défaut = 5609576448 (toi).
//
// Ne bloque JAMAIS la session : toute erreur => exit 0 silencieux.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { isLimitEntry, entryText, alreadyAlerted, markAlerted, readLedger } from './limit-watch.mjs';

const CHAT_ID = process.env.CHAT_ID || '5609576448';
const LORD_ENV = process.env.LORD_ENV || join(homedir(), '.claude', 'channels', 'telegram-piecemaker-lord', '.env');

function readToken() {
  try {
    const raw = readFileSync(LORD_ENV, 'utf8');
    const m = raw.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function num(x) { return typeof x === 'number' && isFinite(x) ? x : 0; }

function main() {
  // Ne reporter QUE depuis une session bridgée Telegram (lancée avec
  // TELEGRAM_STATE_DIR). Une session CLI de dev normale n'envoie rien.
  if (!process.env.TELEGRAM_STATE_DIR) process.exit(0);

  const token = readToken();
  if (!token) process.exit(0); // pas de token Lord => on ne fait rien

  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch {}

  const cwd = payload.cwd || process.cwd();
  // Label projet : PROJECT explicite, sinon dérivé du state-dir
  // (…/telegram-trading → "trading"), sinon nom du dossier courant.
  const project = process.env.PROJECT
    || basename(process.env.TELEGRAM_STATE_DIR || '').replace(/^telegram-/, '')
    || basename(cwd);
  const transcriptPath = payload.transcript_path;

  // Parse le transcript JSONL pour les usages de tokens.
  let lastUsage = null;          // dernier tour assistant (≈ taille de contexte)
  let cycleOutput = 0;           // sortie générée depuis le dernier vrai tour user
  let sessionOutput = 0;         // sortie cumulée sur toute la session
  let assistantTurns = 0;
  let limitHit = null;           // texte du message « limite atteinte » (heure de reset incluse)
  let limitIdx = -1;             // son index dans le transcript
  let limitSessionId = null;     // sessionId porté par la ligne de limite (dédup ledger)
  let lastAssistantIdx = -1;     // index du dernier tour assistant (erreur ou non)

  if (transcriptPath) {
    try {
      const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
      // Trouve l'index du dernier message user "réel" (pas un tool_result)
      let lastUserIdx = -1;
      const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if (!e) continue;
        if (e.type === 'user') {
          const c = e.message?.content;
          const isToolResult = Array.isArray(c) && c.every((p) => p?.type === 'tool_result');
          if (!isToolResult) lastUserIdx = i;
        }
      }
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if (!e || e.type !== 'assistant') continue;
        lastAssistantIdx = i;
        // Détecte le message d'erreur de limite d'abonnement (« You've hit your
        // session limit · resets 7pm »). Détection structurée partagée avec le
        // watcher : isApiErrorMessage + error:"rate_limit"/429 (les 500/auth sont
        // exclus). Le texte porte déjà l'heure de reset.
        if (isLimitEntry(e)) {
          limitHit = entryText(e); limitIdx = i; limitSessionId = e.sessionId || null;
        }
        const u = e.message?.usage;
        if (!u) continue;
        assistantTurns++;
        const out = num(u.output_tokens);
        sessionOutput += out;
        if (i > lastUserIdx) cycleOutput += out;
        lastUsage = u;
      }
    } catch {}
  }

  // Limite « active » = le message de limite est le TOUT dernier tour assistant
  // (aucun tour normal après → la session est bien en pause maintenant).
  const limitActive = !!limitHit && limitIdx === lastAssistantIdx;

  const ctxIn = lastUsage
    ? num(lastUsage.input_tokens) + num(lastUsage.cache_read_input_tokens) + num(lastUsage.cache_creation_input_tokens)
    : 0;

  // Fenêtre de contexte du modèle (200k par défaut, surchargeable via CONTEXT_LIMIT).
  const CONTEXT_LIMIT = Number(process.env.CONTEXT_LIMIT) || 200000;
  const ctxPct = Math.min(100, Math.round((ctxIn / CONTEXT_LIMIT) * 100));

  const fmt = (n) => n.toLocaleString('en-US');
  const now = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // Dédup partagée avec le watcher indépendant : si CETTE limite précise a déjà
  // été signalée (par le watcher qui a devancé le Stop, ou un cycle Stop
  // antérieur), on ne renvoie pas de doublon — on met juste à jour le snapshot.
  const limitDup = limitActive && alreadyAlerted(readLedger(), limitSessionId, limitHit);
  const shouldSend = !(limitActive && limitDup);

  // Limite d'abonnement atteinte → alerte prioritaire avec l'heure de reset.
  // Sinon → rapport de cycle habituel, avec le % d'usage du contexte.
  const text = limitActive
    ? `⛔ *${project}* — limite atteinte (${now})\n` +
      `${limitHit}\n` +
      `_Session en pause jusqu'au reset._`
    : `🤖 *${project}* — cycle terminé (${now})\n` +
      `• Sortie ce cycle : *${fmt(cycleOutput)}* tok\n` +
      `• Contexte : *${ctxPct}%* (${fmt(ctxIn)} / ${fmt(CONTEXT_LIMIT)} tok)\n` +
      `• Session : ${fmt(sessionOutput)} tok sortis · ${assistantTurns} tours`;

  // snapshot lisible à la demande par /usage du daemon Lord
  try {
    writeFileSync(join(process.env.TELEGRAM_STATE_DIR, 'usage.json'),
      JSON.stringify({ project, cycleOutput, ctxIn, ctxPct, sessionOutput, assistantTurns,
        limit: limitActive ? limitHit : null, ts: Date.now() }));
  } catch {}

  // Marque la limite comme signalée dans le ledger partagé (avant l'envoi : évite
  // qu'un watcher concurrent parte en même temps).
  if (limitActive && !limitDup) { try { markAlerted(limitSessionId, limitHit); } catch {} }

  if (!shouldSend) process.exit(0);

  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });

  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then(() => process.exit(0))
    .catch(() => process.exit(0));

  // filet de sécurité : ne jamais laisser le hook pendre
  setTimeout(() => process.exit(0), 4000);
}

try { main(); } catch { process.exit(0); }

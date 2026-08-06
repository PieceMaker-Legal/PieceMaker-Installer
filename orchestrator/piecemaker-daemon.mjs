#!/usr/bin/env node
// Superviseur PieceMaker — daemon Telegram. PAS une session Claude, aucun LLM.
// Long-poll Telegram getUpdates, exécute des commandes shell d'orchestration :
//   /status            état des sessions déclarées (active/arrêtée)
//   /launch <projet>   lance une session, saute si déjà active
//   /launch all        lance toutes les sessions déclarées
//   /help              aide
// Restreint à l'allowlist de telegram-piecemaker-lord/access.json.
//
// Porté depuis « Lord of the bots ». Seule différence de fond : la liste des
// projets n'est plus codée en dur, elle vient de
// ~/.piecemaker/orchestrator/projects.json (voir config.mjs). Le superviseur
// est livré vide, prêt à recevoir les bots déclarés à l'installation.
//
// Démarrage : node piecemaker-daemon.mjs

import { readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import {
  CODEX_HELP, CODEX_VERBS, applyCodexVerb, codexVerbNeedsClaudeStop,
  directCodexCommand, isSlowCodexVerb, stopCodexSessions,
} from './codex-addon.mjs';
import { checkLimits } from './limit-watch.mjs';
import {
  PROJECTS, STATE_DIR, isConfigured, resolveTarget, targetList, PROJECTS_FILE,
} from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, 'launch-telegram.sh');
const CHANNEL_ROOT = join(homedir(), '.claude', 'channels');

function readToken() {
  const raw = readFileSync(join(STATE_DIR, '.env'), 'utf8');
  const m = raw.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  if (!m) throw new Error('token du superviseur introuvable');
  return m[1].trim();
}
function readAllow() {
  try {
    const j = JSON.parse(readFileSync(join(STATE_DIR, 'access.json'), 'utf8'));
    return new Set((j.allowFrom || []).map(String));
  } catch { return new Set(); }
}

const TOKEN = readToken();
const API = `https://api.telegram.org/bot${TOKEN}`;

// Les alias de cible viennent de projects.json (voir config.mjs).
const VERBS = new Set(['/launch', '/stop', '/restart', '/status', '/compact', '/usage', '/model', ...CODEX_VERBS]);
const sd = (p) => join(CHANNEL_ROOT, `telegram-${p}`);

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j?.ok) console.error(`[piecemaker] ${method} refusé (${r.status}) : ${j?.description || '?'}`);
  return j;
}

// Un Markdown mal formé (input utilisateur ré-affiché) fait rejeter le message
// en 400 : la réponse disparaît sans trace côté user. Repli en texte brut —
// mieux vaut une réponse sans mise en forme que pas de réponse.
async function send(chat_id, text) {
  const r = await tg('sendMessage', { chat_id, text, parse_mode: 'Markdown' });
  return r?.ok ? r : tg('sendMessage', { chat_id, text });
}

// Affiche un extrait utilisateur dans un span `code`. Telegram (Markdown legacy)
// n'a aucun échappement pour un backtick à l'intérieur d'un span : on le remplace.
// Les autres caractères Markdown n'y sont pas interprétés — les échapper
// afficherait les backslashes. Tronqué : la cible vient d'un message arbitraire.
const code = (s) => '`' + String(s).replace(/`/g, "'").slice(0, 80) + '`';

// Pid du poller du projet, ou 0 s'il n'y en a pas de vivant.
// bot.pid survit souvent à la session : le plugin telegram ne l'efface qu'à
// l'arrêt propre, or killSession finit au SIGKILL. Le pid relu est donc VALIDÉ
// avant usage — macOS recycle vite les pids et killSession tue un GROUPE entier :
// un pid périmé emporterait un process tiers et ses enfants.
function livePollerPid(project) {
  const file = join(CHANNEL_ROOT, `telegram-${project}`, 'bot.pid');
  let pid = 0;
  try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { return 0; }
  if (!Number.isInteger(pid) || pid <= 1) return 0; // 0/NaN/1 : kill(-1) = diffusion à TOUT
  try { process.kill(pid, 0); } catch { return 0; } // mort
  // Le poller écrit bot.pid à son démarrage : il est donc né AVANT la mtime du
  // fichier (à la seconde près, granularité de ps). Un pid recyclé est né APRÈS
  // → on le rejette. Test indépendant des internes du plugin.
  try {
    const born = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)]).toString().trim());
    if (!Number.isFinite(born) || born > statSync(file).mtimeMs + 1000) return 0;
  } catch { return 0; }
  return pid;
}

function isActive(project) {
  return livePollerPid(project) !== 0;
}

function sh(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000 }, (err, stdout, stderr) => {
      resolve(((stdout || '') + (stderr || '')).trim() || (err ? String(err) : ''));
    });
  });
}

function statusLine(p) {
  return `${isActive(p) ? '🟢' : '⚪️'} @${p} — ${isActive(p) ? 'actif' : 'arrêté'} · ✴️ ${currentModel(p)}`;
}
function statusReport() {
  return `*État des sessions*\n${PROJECTS.map(statusLine).join('\n')}`;
}

// tty de contrôle d'un process (ex. "/dev/ttys007"), ou '' si mort/détaché.
// On identifie la fenêtre Terminal par ce tty et PAS par son titre : Claude Code
// réécrit le titre de l'onglet via des séquences d'échappement (« ✳ Claude Code… »),
// donc le custom title « lord-<projet> » posé au launch est écrasé et ne matche plus.
function ttyDev(pid) {
  try {
    const t = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)]).toString().trim();
    return t && t !== '??' ? '/dev/' + t.replace(/^\/dev\//, '') : '';
  } catch { return ''; }
}

// Ferme la fenêtre Terminal de la session, repérée par son tty (stable, immunisé
// contre les changements de titre). `dev` est capturé AVANT le kill (le process
// est mort ici) ; à défaut on relit le tty persisté par launch-telegram.sh dans
// $sd/tty (utile si la session était déjà éteinte, ex. /stop sur fenêtre zombie).
// Appelée après le kill : la fenêtre est idle → close sans prompt de terminaison.
function closeTerminalWindow(p, dev) {
  const ttyFile = join(CHANNEL_ROOT, `telegram-${p}`, 'tty');
  let tty = dev || '';
  if (!tty) { try { tty = readFileSync(ttyFile, 'utf8').trim(); } catch {} }
  if (tty) {
    try {
      execFileSync('osascript', ['-e',
        `tell application "Terminal"
           set target to missing value
           repeat with w in windows
             repeat with t in tabs of w
               if (tty of t) is "${tty}" then
                 set target to w
                 exit repeat
               end if
             end repeat
             if target is not missing value then exit repeat
           end repeat
           if target is not missing value then close target
         end tell`,
      ], { timeout: 5000 });
    } catch {}
  }
  try { unlinkSync(ttyFile); } catch {}
}

// Reap : tue les process MCP / pollers bun devenus ORPHELINS (ppid == 1),
// abandonnés par une session morte lors d'un ancien restart. Ne touche jamais
// une session vivante (ses enfants ont un ppid ≠ 1).
function reapOrphans() {
  try {
    const out = execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-ax']).toString();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      const [, pid, ppid, cmd] = m;
      if (ppid !== '1') continue; // uniquement les orphelins
      if (/mcp-server-local\.js/.test(cmd) ||
          /claude-plugins-official\/telegram\/.*\bstart\b/.test(cmd) ||
          /claude --channels plugin:telegram/.test(cmd)) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch {}
      }
    }
  } catch {}
}

// Termine complètement la session : tue le groupe de process de `claude`
// (claude + enfants bun/node), PUIS ferme la fenêtre Terminal et balaie les
// orphelins — de sorte que /stop et /restart ne laissent ni fenêtre ni process
// résiduel. Ne dépend plus de la préférence Terminal « fermer si sortie propre ».
async function killSession(p) {
  let killed = false;
  const pidFile = join(CHANNEL_ROOT, `telegram-${p}`, 'bot.pid');
  const pid = livePollerPid(p);       // 0 si absent, mort, ou pid recyclé par un tiers
  const dev = pid ? ttyDev(pid) : ''; // capturer le tty AVANT le kill (après, le pid n'a plus de tty)
  if (pid) {
    let pgid = 0;
    try { pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim()); }
    catch { pgid = 0; } // process déjà mort
    if (pgid > 1) {     // pgid 0/1 → kill(-pgid) diffuserait à tout ce que l'user peut signaler
      try {
        process.kill(-pgid, 'SIGTERM');
        killed = true;
        // attend jusqu'à 5 s que le groupe disparaisse, sinon SIGKILL
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 200));
          try { process.kill(-pgid, 0); } catch { break; } // plus de groupe → OK
        }
        try { process.kill(-pgid, 'SIGKILL'); } catch {}
      } catch { /* déjà mort entre-temps */ }
    }
  }
  try { unlinkSync(pidFile); } catch {} // le poller ne l'efface qu'à l'arrêt propre ; ici on finit au SIGKILL
  closeTerminalWindow(p, dev); // ferme la fenêtre (repérée par tty) même si le process était déjà parti
  reapOrphans();               // balaie les MCP/bun orphelins d'anciens restarts
  return killed;
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

function usageLine(p) { // lit le snapshot écrit par le hook report-cycle.mjs
  try {
    const u = JSON.parse(readFileSync(join(sd(p), 'usage.json'), 'utf8'));
    const age = Math.round((Date.now() - (u.ts || 0)) / 60000);
    const ctx = u.ctxPct != null ? `${u.ctxPct}%` : fmt(u.ctxIn);
    const base = `📊 @${p} — ${fmt(u.sessionOutput)} tok sortis · ctx ${ctx} · ${u.assistantTurns || 0} tours (il y a ${age} min)`;
    return u.limit ? `${base}\n⛔ ${u.limit}` : base;
  } catch { return `📊 @${p} — pas encore de données`; }
}

// Modèle par défaut global (settings.json), utilisé quand aucun override par session.
function globalModel() {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    return (j.model || '').trim() || null;
  } catch { return null; }
}
function currentModel(p) {
  try {
    const m = readFileSync(join(sd(p), 'model'), 'utf8').trim();
    if (m) return m; // override explicite posé via /model
  } catch {}
  const g = globalModel();
  return g ? `${g} (défaut)` : 'défaut';
}
function setModel(p, arg) {
  const file = join(sd(p), 'model');
  if (/^(default|défaut|reset)$/i.test(arg)) { try { unlinkSync(file); } catch {}; return `✴️ @${p} → défaut (au prochain launch)`; }
  if (!/^[A-Za-z0-9._-]+$/.test(arg)) return `⚠️ modèle invalide : ${code(arg)}`;
  try { writeFileSync(file, arg + '\n'); } catch { return `⚠️ @${p} : écriture impossible`; }
  return `✴️ @${p} → \`${arg}\` (appliqué au prochain launch/restart)`;
}

// Construit à l'exécution : les cibles dépendent de projects.json.
const HELP = () =>
  '*PieceMaker* — superviseur\n' +
  'Grammaire : `@cible /verbe [arg]`\n\n' +
  `*Cibles* : ${targetList()} \`@all\`\n` +
  '*Verbes* :\n' +
  '`/launch` lance (saute si déjà active, auto mode complet)\n' +
  '`/stop` quitte la session (ferme le Terminal)\n' +
  '`/restart` quitte puis relance (contexte neuf)\n' +
  '`/compact` = `/restart` (compactage in-place impossible à distance)\n' +
  '`/status` active/arrêtée\n' +
  '`/usage` tokens utilisés\n' +
  '`/model [nom]` voir / fixer le modèle (ex. `opus`, `sonnet`, `default`)\n\n' +
  `Globaux : \`/status\` (les ${PROJECTS.length}) · \`/help\`\n` +
  'Ex. : `@all /usage`' +
  CODEX_HELP;

// Message affiché tant qu'aucun projet n'est déclaré.
const NOT_CONFIGURED =
  '⚠️ Aucun projet déclaré.\n\n' +
  `Ajoutez vos bots dans \`${PROJECTS_FILE}\`, ou relancez :\n` +
  '`node installer/bin/piecemaker.mjs --step 10-superviseur`';

// Applique un verbe à un ou plusieurs projets. Renvoie le texte de réponse.
async function applyVerb(verb, projects, arg) {
  const out = [];
  for (const p of projects) {
    if (verb === '/status') { out.push(statusLine(p)); continue; }
    if (verb === '/usage') { out.push(usageLine(p)); continue; }
    if (verb === '/model') { out.push(arg ? setModel(p, arg) : `✴️ @${p} → ${currentModel(p)}`); continue; }
    if (verb === '/launch') { out.push(await sh('/bin/bash', [LAUNCHER, p])); continue; }
    if (verb === '/stop') {
      out.push((await killSession(p)) ? `🛑 @${p} quittée` : `— @${p} déjà arrêtée`);
      continue;
    }
    // /restart et /compact : quitte (si active) puis relance
    if (verb === '/restart' || verb === '/compact') {
      const killed = await killSession(p);
      if (killed) await new Promise((r) => setTimeout(r, 800));
      out.push(`${killed ? '♻️ ' : ''}` + (await sh('/bin/bash', [LAUNCHER, p])));
      continue;
    }
  }
  return out.join('\n');
}

async function handle(chatId, text) {
  const t = text.trim();

  // Sans projet déclaré il n'y a rien à piloter : on le dit une fois, au lieu
  // de répondre « cible inconnue » à chaque message.
  if (!isConfigured()) return send(chatId, NOT_CONFIGURED);

  // Commandes Codex directes sans cible : elles visent le premier projet
  // déclaré dans projects.json (l'amont visait « trading » en dur).
  // Les autres projets conservent la grammaire existante @cible /verbe.
  const directCodex = directCodexCommand(t);
  if (directCodex) {
    const fallback = PROJECTS[0];
    if (isSlowCodexVerb(directCodex.verb)) await send(chatId, `⏳ \`Codex\` → @${fallback}…`);
    if (codexVerbNeedsClaudeStop(directCodex.verb)) {
      const killed = await killSession(fallback);
      if (killed) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const out = await applyCodexVerb(directCodex.verb, [fallback], directCodex.arg);
    return send(chatId, out || '(pas de sortie)');
  }

  // Globaux sans cible
  if (/^\/(help|start)\b/i.test(t)) return send(chatId, HELP());
  if (/^\/status\b/i.test(t)) return send(chatId, statusReport());
  if (/^\/usage\b/i.test(t)) return send(chatId, PROJECTS.map(usageLine).join('\n'));

  // Grammaire @cible /verbe [arg]
  const m = t.match(/^(@?\S+)\s+(\/\S+)(?:\s+(.+))?$/);
  if (!m) return send(chatId, `⚠️ format attendu : \`@cible /verbe\`\n\n${HELP()}`);

  const target = resolveTarget(m[1]);
  const verb = m[2].toLowerCase();
  const arg = (m[3] || '').trim();
  if (!target) return send(chatId, `⚠️ cible inconnue : ${code(m[1])}\n\n${HELP()}`);
  if (!VERBS.has(verb)) return send(chatId, `⚠️ verbe inconnu : ${code(verb)}\n\n${HELP()}`);

  const projects = target === 'all' ? PROJECTS : [target];
  const slow = ['/launch', '/stop', '/restart', '/compact'].includes(verb) || isSlowCodexVerb(verb);
  if (slow) await send(chatId, `⏳ \`${verb}\` → ${projects.map((p) => '@' + p).join(' ')}…`);
  if (CODEX_VERBS.has(verb) && codexVerbNeedsClaudeStop(verb)) {
    for (const project of projects) {
      const killed = await killSession(project);
      if (killed) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!CODEX_VERBS.has(verb) && ['/launch', '/restart', '/compact'].includes(verb)) {
    await stopCodexSessions(projects);
  }
  const out = CODEX_VERBS.has(verb)
    ? await applyCodexVerb(verb, projects, arg)
    : await applyVerb(verb, projects, arg);
  return send(chatId, out || '(pas de sortie)');
}

// Enregistre le menu de commandes Telegram (bouton « / ») pour ce bot.
// Sans ça, aucune commande n'apparaît dans la liste proposée par Telegram.
async function registerCommands() {
  const commands = [
    { command: 'status',  description: 'État des 4 sessions + modèle' },
    { command: 'usage',   description: 'Tokens utilisés' },
    { command: 'launch',  description: '@cible : lance la session' },
    { command: 'restart', description: '@cible : relance (contexte neuf)' },
    { command: 'stop',    description: '@cible : quitte la session' },
    { command: 'model',   description: '@cible [nom] : voir/fixer le modèle (opus, sonnet…)' },
    { command: 'codex',         description: 'Transférer le projet par défaut vers Codex' },
    { command: 'restart_codex', description: 'Réinitialiser la session Codex' },
    { command: 'codex_restart', description: 'Alias : réinitialiser la session Codex' },
    { command: 'codex_auto',    description: 'on|off|status : mode autonome Codex' },
    { command: 'codex_status',  description: 'État de la session Codex' },
    { command: 'help',    description: 'Aide' },
  ];
  try {
    const r = await tg('setMyCommands', { commands });
    console.error(`[piecemaker] setMyCommands ok=${r?.ok}`);
  } catch (e) { console.error('[piecemaker] setMyCommands', e?.message || e); }
}

// Surveillance indépendante des limites d'abonnement : complète le hook Stop
// (report-cycle.mjs) au cas où il ne se déclenche pas quand la limite tombe.
// Lecture seule des transcripts + un sendMessage ; dédupliqué via le ledger
// partagé, donc pas de doublon avec le hook. Ne bloque jamais la boucle Telegram.
const LIMIT_CHAT_ID = process.env.CHAT_ID || '5609576448';
const LIMIT_POLL_MS = Number(process.env.LIMIT_POLL_MS) || 30000;
function startLimitWatch() {
  const run = () => checkLimits({
    send: (_project, text) => send(LIMIT_CHAT_ID, text),
    isActive,
  }).catch((e) => console.error('[piecemaker] limit-watch', e?.message || e));
  run();
  setInterval(run, LIMIT_POLL_MS);
  console.error(`[piecemaker] surveillance limites active (poll ${LIMIT_POLL_MS} ms)`);
}

async function loop() {
  const allow = readAllow();
  console.error(`[piecemaker] démarré. allowlist=${[...allow].join(',') || '(vide!)'}`);
  await registerCommands();
  startLimitWatch();
  let offset = 0;
  // purge le backlog pour ne pas rejouer d'anciens messages
  try {
    const first = await tg('getUpdates', { timeout: 0, offset: -1 });
    if (first.ok && first.result.length) offset = first.result.at(-1).update_id + 1;
  } catch {}
  for (;;) {
    try {
      const res = await tg('getUpdates', { timeout: 50, offset });
      if (!res.ok) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      for (const upd of res.result) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg || msg.chat?.id == null) continue;
        const from = String(msg.from?.id);
        const chatId = msg.chat.id;
        if (!readAllow().has(from)) { // re-lit à chaud
          console.error(`[piecemaker] refusé: ${from}`);
          continue;
        }
        // Tout message hors-commande (y compris non-texte : sticker, photo…)
        // renvoie la liste des commandes.
        if (!msg.text) { await send(chatId, HELP()).catch(() => {}); continue; }
        await handle(chatId, msg.text).catch((e) => console.error('[piecemaker] handle', e));
      }
    } catch (e) {
      console.error('[piecemaker] poll', e?.message || e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

loop();

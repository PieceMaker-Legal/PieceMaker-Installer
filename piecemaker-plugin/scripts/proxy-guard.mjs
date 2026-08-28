#!/usr/bin/env node
/**
 * SessionStart hook — sentinelle du proxy PII LiteLLM.
 *
 * Claude Code n'est protégé (anonymisation avant envoi au fournisseur) que si
 * deux conditions tiennent ensemble : `~/.claude/settings.json` route
 * `ANTHROPIC_BASE_URL` vers le proxy local, et ce proxy répond.
 *
 * Deux états d'arrêt existent, et ils ne se ressemblent pas :
 *  - `piecemaker stop` (et `piecemaker proxy bypass`) retirent volontairement
 *    le routage — `bypassClaudeCodeProxy()` supprime la variable — pour que les
 *    sessions continuent en accès direct plutôt que d'échouer. « Proxy arrêté »
 *    et « non routé » sont alors le même état.
 *  - un proxy mort sans passer par la CLI (crash, redémarrage machine) laisse
 *    le routage en place : les requêtes échouent avec une erreur réseau opaque.
 *
 * Ce hook couvre les deux : il sonde, relance si besoin, rétablit le routage,
 * et dit la vérité sur ce que la session en cours peut réellement attendre.
 *
 * Limite structurelle assumée : un hook est un processus enfant. Il ne peut pas
 * modifier l'environnement de Claude Code déjà lancé. Rétablir le routage
 * profite donc aux sessions suivantes, jamais à celle qui démarre — le message
 * le dit explicitement au lieu de laisser croire à une protection acquise.
 *
 * Deuxième limite : un démarrage à froid de LiteLLM dispose de 120 s
 * (`LITELLM_START_TIMEOUT_MS`). Une session ne peut pas attendre cela. Le hook
 * donne donc un « coup de pied » borné à `AUTOSTART_BUDGET_MS` : le processus
 * est lancé en détaché et poursuit son démarrage même quand le hook a rendu la
 * main. Un budget épuisé n'est pas un échec — c'est un démarrage en cours, et
 * le hook se garde bien de retirer le routage dans ce cas.
 *
 * Fail open partout : aucune exception ne remonte, aucun exit ≠ 0.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HOME_DIR,
  loadPieceMakerConfig,
  readHookPayload,
  runHook,
  noop,
  ensureDirSafe,
  appendJsonl,
} from './lib/hook-io.mjs';

const LOG_FILE = path.join(HOME_DIR, 'proxy-guard.log');
const MAX_LOG_BYTES = 512 * 1024;
const DEFAULT_PORT = 4000;
const PROBE_TIMEOUT_MS = 1500;
const AUTOSTART_BUDGET_MS = 10000;
const HOOK_TIMEOUT_MS = 25000;

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

/** Tronque le journal avant d'écrire si trop volumineux — jamais de throw. */
function truncateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_BYTES) fs.writeFileSync(LOG_FILE, '', 'utf8');
  } catch {
    // Fichier absent : rien à tronquer.
  }
}

/** Ligne JSONL de traçabilité. Le point clé : ne jamais échouer en silence. */
function logLine(entry) {
  try {
    ensureDirSafe(HOME_DIR);
    truncateLogIfNeeded();
    appendJsonl(LOG_FILE, entry);
  } catch {
    // Une panne de journalisation ne doit jamais faire échouer le hook.
  }
}

/**
 * Claude Code est-il routé vers le proxy local ? Lecture directe de
 * settings.json, sans dépendre de installer/lib — cette partie doit rester
 * lisible même sur une installation cassée.
 */
function readRouting() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    const value = settings?.env?.ANTHROPIC_BASE_URL;
    if (typeof value !== 'string' || !value) return { routed: false, value: value ?? null };
    const url = new URL(value);
    const routed = ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.pathname.replace(/\/$/, '') === '/anthropic';
    return { routed, value };
  } catch {
    return { routed: false, value: null };
  }
}

/** Sonde /health/liveliness sur le port du proxy. Jamais de throw, jamais de rejet. */
function probe(port, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, latencyMs: Date.now() - started });
    };
    try {
      const request = http.get({
        hostname: '127.0.0.1',
        port,
        path: '/health/liveliness',
        timeout: timeoutMs,
      }, (response) => {
        response.resume();
        finish(response.statusCode === 200);
      });
      request.on('timeout', () => { request.destroy(); finish(false); });
      request.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * Charge installer/lib/litellm-proxy.mjs. Le chemin est résolu depuis
 * import.meta.url, donc indépendant du cwd d'appel ; pathToFileURL est
 * indispensable sous Windows, où `C:\...` n'est pas un spécificateur valide.
 */
function loadProxyLib() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const modulePath = path.join(here, '..', '..', 'installer', 'lib', 'litellm-proxy.mjs');
  return import(pathToFileURL(modulePath).href);
}

/** Le venv LiteLLM existe-t-il ? Vérification sans sous-processus, contrairement
 *  à litellmDependenciesStatus() qui lance Python deux fois — trop cher ici. */
function venvPresent(config) {
  try {
    const venv = config.litellmVenvPath || path.join(HOME_DIR, 'litellm-venv');
    return fs.existsSync(venv);
  } catch {
    return false;
  }
}

/**
 * Le processus LiteLLM est-il vivant ? C'est ce qui distingue « démarrage en
 * cours » de « échec » sans dépendre du texte d'un message d'erreur : les
 * libellés changent, un PID vivant ne ment pas.
 *
 * La question est déléguée à `litellmProcessPid()`, qui couvre les deux modes
 * de gestion. Lire seulement `litellm.pid` ne suffit pas : sous launchd — le
 * mode nominal sur macOS — ce fichier n'existe jamais, et un proxy en plein
 * démarrage à froid était alors déclaré mort, déclenchant une fausse alerte
 * « le proxy n'a pas pu démarrer » sur une session qui n'avait qu'à attendre.
 */
async function proxyProcessAlive() {
  try {
    const { litellmProcessPid } = await loadProxyLib();
    return litellmProcessPid() !== null;
  } catch {
    return false;
  }
}

/**
 * Un unique coup de pied au proxy, borné. `startLitellmProxy` lance le
 * processus en détaché puis attend le health check ; passé le budget il lève,
 * mais le processus, lui, continue de démarrer. On distingue donc « lancé,
 * démarrage en cours » de « impossible à lancer ».
 */
async function attemptAutostart() {
  try {
    const { startLitellmProxy } = await loadProxyLib();
    await startLitellmProxy({ timeoutMs: AUTOSTART_BUDGET_MS });
    return { status: 'réussi', error: null };
  } catch (error) {
    const message = error?.message || String(error);
    return { status: (await proxyProcessAlive()) ? 'en-cours' : 'échoué', error: message };
  }
}

/** Rétablit le routage Claude Code + Codex, comme le fait `piecemaker start`. */
async function restoreRouting() {
  try {
    const { configureLlmClients } = await loadProxyLib();
    const clients = configureLlmClients({ userHome: os.homedir() });
    return { ok: Boolean(clients?.claude?.configured), reason: clients?.claude?.reason || null };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function main() {
  const startedAt = Date.now();
  let payload;
  try {
    payload = await readHookPayload(3000);
  } catch {
    payload = null;
  }

  if (!payload) {
    logLine({
      ts: new Date().toISOString(),
      event: null,
      source: null,
      sessionId: null,
      port: null,
      route: { routed: false, value: null },
      probe: { ok: false, latencyMs: null },
      autostart: { status: 'skipped', error: null },
      probeApres: { ok: false, latencyMs: null },
      routageRetabli: null,
      verdict: 'payload-illisible',
      dureeMs: Date.now() - startedAt,
    });
    return null;
  }

  try {
    const config = loadPieceMakerConfig();
    const port = validPort(config.litellmPort);
    const routing = readRouting();
    const installe = venvPresent(config);

    const before = await probe(port);
    let autostart = { status: 'skipped', error: null };
    let after = before;

    // Le proxy ne répond pas : on tente de le relancer, que le routage soit
    // encore en place (crash) ou déjà retiré (piecemaker stop).
    if (!before.ok && installe) {
      autostart = await attemptAutostart();
      after = await probe(port);
    }

    let routageRetabli = null;
    let verdict;
    let systemMessage;
    let additionalContext;

    if (after.ok && routing.routed) {
      verdict = 'actif';
      const relance = autostart.status === 'réussi' ? ' — proxy PII redémarré automatiquement.' : '';
      systemMessage = `🔒 Protection PieceMaker active ✓${relance}`;
      additionalContext = `Le proxy PII LiteLLM répond sur le port ${port} et Claude Code y est routé (ANTHROPIC_BASE_URL). Les échanges avec le fournisseur sont anonymisés puis ré-identifiés localement.`;
    } else if (after.ok && !routing.routed) {
      // Proxy debout mais routage absent : c'est l'état laissé par
      // « piecemaker stop ». On le rétablit pour la suite, sans prétendre
      // protéger la session en cours, dont l'environnement est déjà figé.
      const restored = await restoreRouting();
      routageRetabli = restored.ok;
      verdict = restored.ok ? 'restaure' : 'restauration-echouee';
      systemMessage = restored.ok
        ? "⚠️ [PieceMaker] Cette session a démarré en accès direct : elle n'est pas anonymisée. Le proxy PII tourne et le routage vient d'être rétabli — fermez cette session et rouvrez-en une pour activer la protection."
        : `⚠️ [PieceMaker] Le proxy PII tourne mais le routage de Claude Code n'a pas pu être rétabli (${restored.reason || 'raison inconnue'}). Accès direct au fournisseur, sans anonymisation. Rejouez « piecemaker --step 16-litellm-proxy ».`;
      additionalContext = `Le proxy PII répond sur le port ${port} mais ANTHROPIC_BASE_URL était absent au démarrage de cette session : les échanges de la session en cours ne sont pas anonymisés.${restored.ok ? ' Le routage a été rétabli pour les sessions suivantes.' : ''}`;
    } else if (!installe) {
      verdict = 'non-installe';
      systemMessage = "⚠️ [PieceMaker] Proxy PII LiteLLM non installé : accès direct au fournisseur, sans anonymisation. Rejouez « piecemaker --step 16-litellm-proxy ».";
      additionalContext = `Aucun environnement LiteLLM n'est installé sur cette machine. Les échanges Claude Code ne sont pas anonymisés.`;
    } else if (autostart.status === 'en-cours') {
      verdict = 'demarrage';
      systemMessage = `⏳ [PieceMaker] Proxy PII en cours de démarrage (jusqu'à 2 min à froid). Cette session n'est pas protégée${routing.routed ? ' et ses requêtes vont échouer tant que le proxy ne répond pas' : ''} — rouvrez-en une dans un moment.`;
      additionalContext = `Le proxy PII a été relancé mais ne répondait pas encore au bout de ${Math.round(AUTOSTART_BUDGET_MS / 1000)} s ; son démarrage se poursuit en arrière-plan. Journal : ${path.join(HOME_DIR, 'litellm.log')}.`;
    } else {
      verdict = 'arrete';
      systemMessage = `⚠️ [PieceMaker] Protection inactive : le proxy PII (port ${port}) n'a pas pu démarrer. Lancez « piecemaker start », puis consultez ${path.join(HOME_DIR, 'litellm.log')}.`;
      additionalContext = `Le proxy PII (port ${port}) ne répond pas et sa relance automatique a échoué (${autostart.error || 'raison inconnue'}). ${routing.routed ? 'Claude Code y est routé : aucune requête ne peut aboutir.' : 'Les échanges Claude Code ne sont pas anonymisés.'}`;
    }

    logLine({
      ts: new Date().toISOString(),
      event: payload.hook_event_name || null,
      source: payload.source ?? null,
      sessionId: payload.session_id || null,
      port,
      installe,
      route: { routed: routing.routed, value: routing.value },
      probe: { ok: before.ok, latencyMs: before.latencyMs },
      autostart,
      probeApres: { ok: after.ok, latencyMs: after.latencyMs },
      routageRetabli,
      verdict,
      dureeMs: Date.now() - startedAt,
    });

    return {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    };
  } catch (error) {
    logLine({
      ts: new Date().toISOString(),
      event: payload?.hook_event_name || null,
      source: payload?.source ?? null,
      sessionId: payload?.session_id || null,
      port: null,
      route: { routed: false, value: null },
      probe: { ok: false, latencyMs: null },
      autostart: { status: 'skipped', error: null },
      probeApres: { ok: false, latencyMs: null },
      routageRetabli: null,
      verdict: 'exception',
      erreur: error?.message || String(error),
      dureeMs: Date.now() - startedAt,
    });
    return null;
  }
}

runHook(main, { timeoutMs: HOOK_TIMEOUT_MS }).catch(() => noop());

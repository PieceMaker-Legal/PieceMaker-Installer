#!/usr/bin/env node
/**
 * SessionStart hook — sentinelle du proxy PII LiteLLM.
 *
 * Claude Code n'est protégé (anonymisation avant envoi au fournisseur) que si
 * deux conditions tiennent à la fois : `~/.claude/settings.json` route bien
 * `ANTHROPIC_BASE_URL` vers le proxy local (`installer/lib/litellm-proxy.mjs
 * configureClaudeCodeProxy()`), et ce proxy répond. Sans autostart hors macOS
 * (launchd seulement, voir `installLitellmLaunchAgent`), un proxy arrêté
 * plantait la session avec une erreur réseau opaque au premier appel modèle.
 *
 * Ce hook, à chaque démarrage/reprise de session :
 *  1. constate le routage (lecture directe de settings.json — aucune
 *     dépendance à installer/lib pour cette partie-là) ;
 *  2. sonde le proxy (node:http, jamais de throw) ;
 *  3. si routé mais arrêté, tente UN démarrage via un import dynamique de
 *     installer/lib/litellm-proxy.mjs, puis re-sonde ;
 *  4. informe l'utilisateur (systemMessage) et le modèle
 *     (hookSpecificOutput.additionalContext) de l'état constaté ;
 *  5. journalise chaque exécution, y compris les échecs, dans
 *     ~/.piecemaker/proxy-guard.log (JSONL, tronqué au-delà de ~512 Ko).
 *
 * Fail open partout : aucune exception ne doit remonter, aucun exit ≠ 0. Ce
 * hook ne fait jamais échouer une session — il informe, au pire silencieusement.
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
const AUTOSTART_TIMEOUT_MS = 20000;
const HOOK_TIMEOUT_MS = 30000;

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

/** Ligne JSONL de traçabilité. Le point clé de la demande : ne jamais échouer en silence. */
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
 * indépendante de l'installateur, contrairement à l'autostart (étape 5).
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
 * Un unique essai de démarrage, par import dynamique de
 * installer/lib/litellm-proxy.mjs (chemin résolu depuis import.meta.url, donc
 * indépendant du cwd d'appel). pathToFileURL est indispensable sous Windows,
 * où un chemin brut (`C:\...`) n'est pas un spécificateur de module valide.
 */
async function attemptAutostart() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const modulePath = path.join(here, '..', '..', 'installer', 'lib', 'litellm-proxy.mjs');
    const { startLitellmProxy } = await import(pathToFileURL(modulePath).href);
    await startLitellmProxy({ timeoutMs: AUTOSTART_TIMEOUT_MS });
    return { status: 'réussi', error: null };
  } catch (error) {
    return { status: 'échoué', error: error?.message || String(error) };
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
      verdict: 'payload-illisible',
      dureeMs: Date.now() - startedAt,
    });
    return null;
  }

  try {
    const config = loadPieceMakerConfig();
    const port = validPort(config.litellmPort);
    const routing = readRouting();

    const before = await probe(port);
    let autostart = { status: 'skipped', error: null };
    let after = before;

    if (routing.routed && !before.ok) {
      const result = await attemptAutostart();
      autostart = result;
      after = await probe(port);
    }

    let verdict;
    let systemMessage;
    let additionalContext;

    if (routing.routed && after.ok) {
      verdict = 'actif';
      systemMessage = '🔒 Protection PieceMaker active ✓';
      additionalContext = `Le proxy PII LiteLLM répond sur le port ${port} et Claude Code y est routé (ANTHROPIC_BASE_URL). Les échanges avec le fournisseur sont anonymisés puis ré-identifiés localement.`;
    } else if (routing.routed && !after.ok) {
      verdict = 'arrete';
      systemMessage = `⚠️ [PieceMaker] Protection inactive : le proxy PII LiteLLM (port ${port}) ne répond pas alors que Claude Code y est routé. Les requêtes vers le fournisseur vont échouer. Lancez « piecemaker start », puis consultez le journal : ${path.join(HOME_DIR, 'litellm.log')}.`;
      additionalContext = `Le proxy PII LiteLLM (port ${port}) ne répond toujours pas après une tentative de démarrage automatique (${autostart.status}). Claude Code y est routé mais aucune requête ne peut aboutir tant qu'il n'est pas relancé.`;
    } else {
      verdict = 'non-route';
      systemMessage = "⚠️ [PieceMaker] Claude Code n'est pas routé par le proxy PII local : accès direct au fournisseur, sans anonymisation. Rejouez « piecemaker --step 16-litellm-proxy » pour reconfigurer le routage.";
      additionalContext = `ANTHROPIC_BASE_URL (${routing.value || 'absent'}) ne pointe pas vers le proxy PII PieceMaker sur le port ${port}. Aucune anonymisation n'est appliquée aux échanges Claude Code tant que le routage n'est pas rétabli.`;
    }

    logLine({
      ts: new Date().toISOString(),
      event: payload.hook_event_name || null,
      source: payload.source ?? null,
      sessionId: payload.session_id || null,
      port,
      route: { routed: routing.routed, value: routing.value },
      probe: { ok: before.ok, latencyMs: before.latencyMs },
      autostart,
      probeApres: { ok: after.ok, latencyMs: after.latencyMs },
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
      verdict: 'exception',
      erreur: error?.message || String(error),
      dureeMs: Date.now() - startedAt,
    });
    return null;
  }
}

runHook(main, { timeoutMs: HOOK_TIMEOUT_MS }).catch(() => noop());

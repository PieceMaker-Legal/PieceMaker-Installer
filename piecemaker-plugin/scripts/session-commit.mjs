#!/usr/bin/env node
/**
 * Hook Stop — déclenche l'auto-commit par tour, sans rien coûter au tour.
 *
 * Ce script ne fait que déposer un instantané minimal du tour (session, cwd,
 * transcript, conclusion de l'IA) dans le spool
 * (`~/.piecemaker/spool/<session_id>-<horodatage>.json`), puis lance le
 * worker détaché `session-commit-worker.mjs` qui fait tout le travail Git —
 * comparer les arbres, ré-identifier la conclusion, écrire le commit — hors
 * du tour (même motif de spawn détaché que `compile-recherche.mjs`).
 *
 * `Stop` refuse un code de sortie 2 : sur cet événement, un code 2 empêche
 * Claude de s'arrêter et boucle la session. Ce hook sort donc TOUJOURS en 0 —
 * fail-open intégral, toute exception est avalée (journalisée si possible).
 * Objectif de latence : quelques millisecondes, jamais de `git` synchrone ici.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME_DIR,
  noop,
  readHookPayload,
  runHook,
} from './lib/hook-io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPOOL_DIR = path.join(HOME_DIR, 'spool');
const LOG_FILE = path.join(HOME_DIR, 'auto-commit.log');

function sanitizeSessionId(sessionId) {
  return String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Best-effort, jamais bloquant : une seule ligne append, pas de rotation ici
 * (le worker détaché tient le journal complet, y compris sa rotation).
 */
function logFailure(message, error) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const detail = error ? ` ${String(error?.message || error)}` : '';
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${process.pid}] ERROR (session-commit) ${message}${detail}\n`,
    );
  } catch { /* fail-open : un journal indisponible ne doit rien bloquer */ }
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || payload.hook_event_name !== 'Stop') return null;

  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const sessionId = sanitizeSessionId(payload.session_id);
    const spoolFile = path.join(SPOOL_DIR, `${sessionId}-${Date.now()}.json`);
    fs.writeFileSync(spoolFile, JSON.stringify({
      session_id: payload.session_id || null,
      cwd: payload.cwd || null,
      transcript_path: payload.transcript_path || null,
      last_assistant_message: payload.last_assistant_message || null,
      ts: new Date().toISOString(),
    }), 'utf8');

    const workerPath = path.join(HERE, 'session-commit-worker.mjs');
    const child = spawn(process.execPath, [workerPath, spoolFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (error) {
    // Fail-open intégral : jamais de code 2 sur Stop, jamais d'exception qui
    // remonte — au pire, ce tour n'aura pas de commit automatique.
    logFailure('commit de tour non lancé', error);
  }

  return null;
}

runHook(main, { timeoutMs: 2000 }).catch(() => noop());

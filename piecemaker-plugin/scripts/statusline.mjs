#!/usr/bin/env node
/**
 * statusLine Claude Code — bandeau permanent d'état de l'anonymisation PieceMaker.
 *
 * Contrat statusLine (type "command") : JSON sur stdin décrivant la session
 * (workspace, model...), une seule ligne sur stdout, exit 0. Appelé très
 * souvent (à chaque rendu de l'interface) : ce script doit rester rapide et
 * ne jamais bloquer ni jeter.
 *
 * Le badge reflète les deux mêmes conditions que `proxy-guard.mjs` (routage
 * + proxy vivant), mais sans autostart ni journalisation : une statusLine
 * n'est pas le bon endroit pour une action de fond, seulement pour un
 * affichage. Le sondage réseau est borné à 400 ms et son résultat est mis en
 * cache 5 s dans ~/.piecemaker/proxy-statusline.json pour éviter une requête
 * à chaque frappe.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HOME_DIR, loadPieceMakerConfig, readHookPayload } from './lib/hook-io.mjs';

const CACHE_FILE = path.join(HOME_DIR, 'proxy-statusline.json');
const CACHE_TTL_MS = 5000;
const PROBE_TIMEOUT_MS = 400;
const STDIN_TIMEOUT_MS = 1000;
const DEFAULT_PORT = 4000;
const FLUSH_TIMEOUT_MS = 1000;

const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

/** Même définition du routage que proxy-guard.mjs — lecture directe, jamais de throw. */
function readRouting() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const value = settings?.env?.ANTHROPIC_BASE_URL;
    if (typeof value !== 'string' || !value) return false;
    const url = new URL(value);
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.pathname.replace(/\/$/, '') === '/anthropic';
  } catch {
    return false;
  }
}

/** Cache court entre deux sondages. Un cache illisible/absent n'empêche pas de sonder. */
function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (typeof parsed?.ts !== 'number' || typeof parsed?.actif !== 'boolean') return null;
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(actif) {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), actif }), 'utf8');
  } catch {
    // Le cache est un confort de performance, pas une garantie.
  }
}

function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
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
 * Couleur ANSI du badge : vert quand l'anonymisation est effective, rouge
 * sinon. Claude Code rend les séquences ANSI de la statusLine ; on n'en met
 * que sur le badge, jamais sur le dossier ni le modèle.
 */
const VERT = '\u001b[32m';
const ROUGE = '\u001b[31m';
const RESET = '\u001b[0m';

function colore(texte, couleur) {
  return process.env.NO_COLOR ? texte : `${couleur}${texte}${RESET}`;
}

function badge(routed, actif) {
  if (routed && actif) return colore('🔒 Anonymisation PieceMaker active ✓', VERT);
  if (routed) return colore('⚠️ Anonymisation PieceMaker inactive — proxy arrêté (piecemaker start)', ROUGE);
  return colore('⚠️ Anonymisation PieceMaker inactive — accès direct', ROUGE);
}

/** Écrit la ligne et quitte proprement, en attendant le flush comme hook-io.mjs::emit. */
function printAndExit(text) {
  const guard = setTimeout(() => process.exit(0), FLUSH_TIMEOUT_MS);
  guard.unref?.();
  try {
    process.stdout.write(`${text}\n`, () => {
      clearTimeout(guard);
      process.exit(0);
    });
  } catch {
    clearTimeout(guard);
    process.exit(0);
  }
}

function safeCwdName(cwd) {
  try {
    const value = String(cwd || process.cwd());
    return path.basename(value) || value;
  } catch {
    return '';
  }
}

async function main() {
  let payload = null;
  try {
    payload = await readHookPayload(STDIN_TIMEOUT_MS);
  } catch {
    payload = null;
  }

  const dirName = safeCwdName(payload?.workspace?.current_dir || payload?.cwd);
  const modelName = typeof payload?.model?.display_name === 'string' ? payload.model.display_name : '';

  let config = {};
  try {
    config = loadPieceMakerConfig();
  } catch {
    config = {};
  }
  const port = validPort(config.litellmPort);
  const routed = readRouting();

  const cached = readCache();
  let actif;
  if (cached) {
    actif = cached.actif;
  } else {
    actif = await probe(port, PROBE_TIMEOUT_MS);
    writeCache(actif);
  }

  const parts = [badge(routed, actif)];
  if (dirName) parts.push(dirName);
  if (modelName) parts.push(modelName);
  printAndExit(parts.join(' · '));
}

main().catch(() => {
  printAndExit(safeCwdName(process.cwd()));
});

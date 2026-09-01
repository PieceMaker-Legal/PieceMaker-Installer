/**
 * Étape 07 — plugin MCP Légifrance autonome et clés PISTE.
 *
 * Le runtime vit dans https://github.com/PieceMaker-Legal/mcp-legifrance.
 * PieceMaker ne possède plus son code : il installe le marketplace Claude,
 * prépare le venv privé du plugin et écrit les identifiants dans le fichier de
 * configuration stable ~/.config/mcp-legifrance/.env (0600). Une copie reste
 * dans le .env PieceMaker pour l'administration et les migrations existantes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, spinner, blank, link } from '../lib/ui.mjs';
import { ask, select, confirm, nonInteractive } from '../lib/prompt.mjs';
import { commandExists, compareVersions, findPython, run, runCapture } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

export const meta = {
  id: '07-legifrance',
  label: 'Serveur MCP Légifrance (clés PISTE)',
  description: "Installe le plugin MCP autonome et configure l'accès à l'API Légifrance via PISTE",
};

const MARKETPLACE_NAME = 'mcp-legifrance';
const MARKETPLACE_REPO = 'PieceMaker-Legal/mcp-legifrance';
const PLUGIN_NAME = 'piecemaker';
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const MINIMUM_PLUGIN_VERSION = '1.0.0';
const REGISTRATION_URL = 'https://piste.gouv.fr/registration';
const CATALOG_URL = 'https://piste.gouv.fr/api-catalog-all';
const PISTE_ENV = 'production';

const ENDPOINTS = {
  token: 'https://oauth.piste.gouv.fr/api/oauth/token',
  api: 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/',
};

function parseJson(raw, fallback = null) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function marketplaceRegistered(capture = runCapture) {
  const result = capture('claude', ['plugin', 'marketplace', 'list', '--json']);
  const marketplaces = result.code === 0 ? parseJson(result.stdout, []) : [];
  return Array.isArray(marketplaces)
    && marketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME);
}

function pluginState(capture = runCapture) {
  const result = capture('claude', ['plugin', 'list', '--json']);
  if (result.code !== 0) return { known: false, installed: false, enabled: false, installPath: null, version: null };
  const plugins = parseJson(result.stdout, []);
  const plugin = Array.isArray(plugins)
    ? plugins.find((item) => item.id === PLUGIN_SPEC || item.name === PLUGIN_NAME)
    : null;
  return {
    known: true,
    installed: Boolean(plugin),
    enabled: Boolean(plugin) && plugin.enabled !== false,
    installPath: plugin?.installPath || null,
    version: plugin?.version || null,
  };
}

export function legifranceEnvFile(userHome = os.homedir()) {
  return path.join(userHome, '.config', 'mcp-legifrance', '.env');
}

function readSimpleEnv(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
      if (match) values[match[1]] = match[2];
    }
  } catch { /* fichier absent */ }
  return values;
}

/** Fusionne les secrets MCP sans écraser les commentaires ni les autres clés. */
export function writeLegifranceEnv(file, values) {
  const existing = new Map();
  const preamble = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
      if (match) existing.set(match[1], match[2]);
      else if (line.trim()) preamble.push(line);
    }
  } catch { /* première installation */ }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') existing.set(key, String(value));
  }
  const body = [...preamble, ...[...existing].map(([key, value]) => `${key}=${value}`)].join('\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch { /* ACL Windows */ }
  return file;
}

async function validatePisteCredentials(clientId, clientSecret, fetchImpl = fetch) {
  let tokenRes;
  try {
    tokenRes = await fetchImpl(ENDPOINTS.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: clientId,
        client_secret: clientSecret, scope: 'openid',
      }),
    });
  } catch (error) {
    return { ok: false, message: `Impossible de joindre le serveur OAuth PISTE (${ENDPOINTS.token}) : ${error.message}` };
  }
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    return {
      ok: false,
      message: `Authentification refusée par PISTE (HTTP ${tokenRes.status}). Vérifiez le Client ID et le Client Secret.${detail ? ` Détail : ${detail.slice(0, 200)}` : ''}`,
    };
  }
  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenData?.access_token) return { ok: false, message: 'Réponse PISTE invalide : aucun jeton reçu.' };
  let searchRes;
  try {
    searchRes = await fetchImpl(`${ENDPOINTS.api}search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: JSON.stringify({
        fond: 'CODE_DATE',
        recherche: {
          champs: [{ typeChamp: 'ALL', criteres: [{ typeRecherche: 'UN_DES_MOTS', valeur: 'code civil', operateur: 'ET' }], operateur: 'ET' }],
          filtres: [], pageNumber: 1, pageSize: 1, operateur: 'ET',
          sort: 'SIGNATURE_DATE_DESC', typePagination: 'DEFAUT',
        },
      }),
    });
  } catch (error) {
    return { ok: false, message: `Jeton obtenu, mais API Légifrance injoignable : ${error.message}` };
  }
  if (!searchRes.ok) {
    const detail = await searchRes.text().catch(() => '');
    return {
      ok: false,
      message: `Jeton obtenu, mais la requête Légifrance a échoué (HTTP ${searchRes.status}). Vérifiez la souscription PISTE.${detail ? ` Détail : ${detail.slice(0, 200)}` : ''}`,
    };
  }
  return { ok: true };
}

function dependencies(overrides = {}) {
  return {
    userHome: os.homedir(), log, run, runCapture, commandExists, findPython,
    writeEnv, writeLegifranceEnv, validatePisteCredentials,
    ask, select, confirm, nonInteractive,
    ...overrides,
  };
}

async function ensurePlugin(ops) {
  if (!ops.commandExists('claude', ['--version'])) return { ok: false, reason: 'CLI Claude Code introuvable.' };
  if (!marketplaceRegistered(ops.runCapture)) {
    const code = await ops.run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
    if (code !== 0) return { ok: false, reason: `Impossible d'enregistrer ${MARKETPLACE_REPO}.` };
  }
  let state = pluginState(ops.runCapture);
  if (!state.known) return { ok: false, reason: 'Claude Code ne peut pas lister ses plugins.' };
  if (!state.installed) {
    const code = await ops.run('claude', ['plugin', 'install', PLUGIN_SPEC]);
    if (code !== 0) return { ok: false, reason: `Impossible d'installer ${PLUGIN_SPEC}.` };
    state = pluginState(ops.runCapture);
  }
  if (state.installed && (!state.version || compareVersions(state.version, MINIMUM_PLUGIN_VERSION) < 0)) {
    await ops.run('claude', ['plugin', 'marketplace', 'update', MARKETPLACE_NAME]);
    const code = await ops.run('claude', ['plugin', 'update', PLUGIN_SPEC, '--yes']);
    if (code !== 0) return { ok: false, reason: `Impossible de mettre à jour ${PLUGIN_SPEC}.` };
    state = pluginState(ops.runCapture);
  }
  if (!state.enabled) {
    const code = await ops.run('claude', ['plugin', 'enable', PLUGIN_SPEC]);
    if (code !== 0) return { ok: false, reason: `Plugin ${PLUGIN_SPEC} installé mais non activé.` };
    state = pluginState(ops.runCapture);
  }
  const launcher = state.installPath && path.join(state.installPath, 'scripts', 'launcher.py');
  if (!launcher || !fs.existsSync(launcher)) return { ok: false, reason: 'Lanceur du plugin Légifrance introuvable.' };
  const python = ops.findPython();
  if (!python) return { ok: false, reason: 'Python 3 introuvable pour préparer le plugin.' };
  const code = await ops.run(python.command, [launcher, '--bootstrap-only']);
  if (code !== 0) return { ok: false, reason: 'Échec de la préparation du venv Légifrance.' };
  return { ok: true, state };
}

export async function install(ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (ctx.dryRun) {
    ops.log.info(`[simulation] installation de ${PLUGIN_SPEC} depuis ${MARKETPLACE_REPO}`);
    ops.log.info(`[simulation] configuration PISTE dans ${legifranceEnvFile(ops.userHome)}`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }
  const pluginSpin = spinner('Installation du plugin MCP Légifrance autonome...');
  const plugin = await ensurePlugin(ops);
  if (!plugin.ok) {
    pluginSpin.fail('Plugin MCP Légifrance non installé.');
    return { status: 'failed', note: plugin.reason };
  }
  pluginSpin.succeed('Plugin MCP Légifrance installé et prêt.');

  const standalone = readSimpleEnv(legifranceEnvFile(ops.userHome));
  const existingEnv = { ...standalone, ...(ctx.env || {}) };
  let clientId = existingEnv.LEGIFRANCE_CLIENT_ID || '';
  let clientSecret = existingEnv.LEGIFRANCE_CLIENT_SECRET || '';
  if (clientId && clientSecret) {
    const keep = await ops.confirm('Des clés PISTE sont déjà configurées. Les conserver pour la production ?', true);
    if (!keep) { clientId = ''; clientSecret = ''; }
  }
  if (!clientId || !clientSecret) {
    ops.log.info("Le serveur MCP interroge l'API officielle Légifrance via PISTE.");
    ops.log.detail(`1. Compte PISTE : ${link(REGISTRATION_URL, REGISTRATION_URL)}`);
    ops.log.detail(`2. Souscrire à l'API Légifrance : ${link(CATALOG_URL, CATALOG_URL)}`);
    blank();
  }
  for (;;) {
    if (!clientId || !clientSecret) {
      clientId = await ops.ask('Client ID PISTE (production)', { required: true });
      clientSecret = await ops.ask('Client Secret PISTE (production)', { required: true });
    }
    if (!clientId || !clientSecret) return { status: 'partial', note: 'Plugin installé, mais clés PISTE absentes.' };
    const values = {
      LEGIFRANCE_CLIENT_ID: clientId,
      LEGIFRANCE_CLIENT_SECRET: clientSecret,
      LEGIFRANCE_ENV: PISTE_ENV,
    };
    ops.writeEnv(values);
    ops.writeLegifranceEnv(legifranceEnvFile(ops.userHome), values);
    const validationSpin = spinner('Validation des clés PISTE de production...');
    const validation = await ops.validatePisteCredentials(clientId, clientSecret);
    if (validation.ok) {
      validationSpin.succeed('Connexion à Légifrance confirmée.');
      return { status: 'done', note: '' };
    }
    validationSpin.fail('Échec de la validation PISTE.');
    ops.log.error(validation.message);
    if (ops.nonInteractive) return { status: 'partial', note: validation.message };
    const action = await ops.select('La validation a échoué. Que voulez-vous faire ?', [
      { value: 'retry', label: 'Réessayer', hint: 'ressaisir les clés' },
      { value: 'skip', label: 'Conserver sans validation', hint: 'terminer malgré l’échec' },
    ], { def: 0 });
    if (action === 'skip') return { status: 'partial', note: validation.message };
    clientId = ''; clientSecret = '';
  }
}

export async function check(_ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.commandExists('claude', ['--version'])) return { status: 'skipped', note: 'CLI Claude Code introuvable.' };
  const state = pluginState(ops.runCapture);
  if (!state.known) return { status: 'failed', note: 'Impossible de lister les plugins Claude Code.' };
  if (!state.installed) return { status: 'failed', note: `Plugin ${PLUGIN_SPEC} non installé.` };
  if (!state.enabled) return { status: 'partial', note: `Plugin ${PLUGIN_SPEC} désactivé.` };
  if (!state.version || compareVersions(state.version, MINIMUM_PLUGIN_VERSION) < 0) {
    return { status: 'partial', note: `Plugin ${PLUGIN_SPEC} antérieur à ${MINIMUM_PLUGIN_VERSION}.` };
  }
  const env = readSimpleEnv(legifranceEnvFile(ops.userHome));
  if (!env.LEGIFRANCE_CLIENT_ID || !env.LEGIFRANCE_CLIENT_SECRET) {
    return { status: 'partial', note: 'Plugin installé, mais clés PISTE absentes de ~/.config/mcp-legifrance/.env.' };
  }
  if ((env.LEGIFRANCE_ENV || PISTE_ENV).toLowerCase() !== PISTE_ENV) {
    return { status: 'partial', note: 'Le plugin Légifrance n’est pas configuré en production.' };
  }
  return { status: 'done', note: 'Plugin autonome installé ; clés présentes. Validation réseau non rejouée.' };
}

/**
 * Step 07 — Serveur MCP Légifrance (clés PISTE).
 *
 * Le plugin expose piecemaker-plugin/mcp/legifrance/, serveur MCP local porté
 * stdio qui interroge l'API officielle Légifrance via PISTE (OAuth2
 * client_credentials — voir ce fichier pour le détail des routes). Ce serveur
 * démarre sans clés (il liste ses outils), mais chaque appel échoue tant que
 * LEGIFRANCE_CLIENT_ID / LEGIFRANCE_CLIENT_SECRET ne sont pas configurés. Cette étape
 * les recueille, les écrit dans .env via writeEnv() (0600), puis valide
 * réellement la connexion (jeton OAuth2 + une recherche triviale) pour éviter
 * de découvrir une clé invalide seulement à l'usage dans Claude.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner, blank } from '../lib/ui.mjs';
import { ask, secret, select, confirm } from '../lib/prompt.mjs';
import { REPO_ROOT } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

export const meta = {
  id: '07-legifrance',
  label: 'Serveur MCP Légifrance (clés PISTE)',
  description: "Configure et valide l'accès à l'API Légifrance via PISTE pour le serveur MCP local",
};

const PLUGIN_ROOT = path.join(REPO_ROOT, 'piecemaker-plugin');
const MCP_SERVER_PATH = path.join(PLUGIN_ROOT, 'mcp', 'legifrance', 'mcp_stdio_server.py');
const MCP_JSON_PATH = path.join(PLUGIN_ROOT, '.mcp.json');

const REGISTRATION_URL = 'https://piste.gouv.fr/registration';
const CATALOG_URL = 'https://piste.gouv.fr/api-catalog-sandbox';

// Mêmes points de terminaison que piecemaker-plugin/mcp/legifrance/config/settings.py
// (dupliqués volontairement : cette étape doit rester autonome, sans importer
// le serveur MCP).
const ENDPOINTS = {
  sandbox: {
    token: 'https://sandbox-oauth.piste.gouv.fr/api/oauth/token',
    api: 'https://sandbox-api.piste.gouv.fr/dila/legifrance/lf-engine-app/',
  },
  production: {
    token: 'https://oauth.piste.gouv.fr/api/oauth/token',
    api: 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/',
  },
};

/** Obtains a token then runs one trivial search, to prove the keys actually work end to end. */
async function validatePisteCredentials(clientId, clientSecret, env) {
  const endpoints = ENDPOINTS[env];

  let tokenRes;
  try {
    tokenRes = await fetch(endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'openid',
      }),
    });
  } catch (error) {
    return { ok: false, message: `Impossible de joindre le serveur OAuth PISTE (${endpoints.token}) : ${error.message}` };
  }

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    return {
      ok: false,
      message:
        `Authentification refusée par PISTE (HTTP ${tokenRes.status}, environnement "${env}"). ` +
        `Vérifiez le Client ID et le Client Secret.` +
        (detail ? ` Détail : ${detail.slice(0, 200)}` : ''),
    };
  }

  const tokenData = await tokenRes.json().catch(() => null);
  const accessToken = tokenData?.access_token;
  if (!accessToken) {
    return { ok: false, message: 'Réponse PISTE invalide : aucun jeton d\'accès reçu.' };
  }

  let searchRes;
  try {
    searchRes = await fetch(`${endpoints.api}search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        fond: 'CODE_DATE',
        recherche: {
          champs: [
            { typeChamp: 'ALL', criteres: [{ typeRecherche: 'UN_DES_MOTS', valeur: 'code civil', operateur: 'ET' }], operateur: 'ET' },
          ],
          filtres: [],
          pageNumber: 1,
          pageSize: 1,
          operateur: 'ET',
          sort: 'SIGNATURE_DATE_DESC',
          typePagination: 'DEFAUT',
        },
      }),
    });
  } catch (error) {
    return { ok: false, message: `Jeton obtenu, mais impossible de joindre l'API Légifrance (${endpoints.api}) : ${error.message}` };
  }

  if (!searchRes.ok) {
    const detail = await searchRes.text().catch(() => '');
    return {
      ok: false,
      message:
        `Jeton obtenu, mais la requête de test a échoué (HTTP ${searchRes.status}). ` +
        `Vérifiez que l'API "Légifrance" est bien souscrite pour cette application PISTE, dans l'environnement "${env}" ` +
        `(catalogue : ${CATALOG_URL}).` +
        (detail ? ` Détail : ${detail.slice(0, 200)}` : ''),
    };
  }

  return { ok: true };
}

export async function install(ctx) {
  const existingEnv = ctx.env || {};
  let clientId = existingEnv.LEGIFRANCE_CLIENT_ID || '';
  let clientSecret = existingEnv.LEGIFRANCE_CLIENT_SECRET || '';
  let pisteEnv = (existingEnv.LEGIFRANCE_ENV || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';

  if (clientId && clientSecret) {
    const keep = await confirm(`Des clés PISTE sont déjà configurées (environnement : ${pisteEnv}). Les conserver ?`, true);
    if (!keep) {
      clientId = '';
      clientSecret = '';
    }
  }

  if (!clientId || !clientSecret) {
    log.info("Le serveur MCP Légifrance interroge l'API officielle de la DILA via la plateforme PISTE (OAuth2).");
    log.detail(`1. Créez un compte PISTE : ${REGISTRATION_URL}`);
    log.detail(`2. Dans votre application, souscrivez à l'API "Légifrance" et acceptez ses CGU — à faire dans les DEUX environnements (sandbox et production). Catalogue : ${CATALOG_URL}`);
    log.detail('3. Récupérez le Client ID et le Client Secret de votre application PISTE.');
    blank();

    clientId = await ask('Client ID PISTE', { required: true });
    clientSecret = await secret('Client Secret PISTE (saisie masquée)');
    pisteEnv = await select(
      'Environnement PISTE',
      [
        { value: 'sandbox', label: 'Sandbox', hint: 'gratuit, pour tester — quotas réduits' },
        { value: 'production', label: 'Production', hint: 'clés PISTE de production' },
      ],
      { def: 0 }
    );
  }

  if (!clientId || !clientSecret) {
    return {
      status: 'skipped',
      note: 'Aucune clé PISTE saisie — le serveur MCP Légifrance démarrera mais ses outils renverront une erreur tant que les clés ne sont pas configurées.',
    };
  }

  if (ctx.dryRun) {
    log.info('[simulation] Écriture de LEGIFRANCE_CLIENT_ID / LEGIFRANCE_CLIENT_SECRET / LEGIFRANCE_ENV dans .env (non exécutée).');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  writeEnv({ LEGIFRANCE_CLIENT_ID: clientId, LEGIFRANCE_CLIENT_SECRET: clientSecret, LEGIFRANCE_ENV: pisteEnv });
  log.ok('Clés PISTE enregistrées dans .env (permissions restreintes 0600).');

  if (!fs.existsSync(MCP_SERVER_PATH) || !fs.existsSync(MCP_JSON_PATH)) {
    log.warn(`Fichiers du serveur MCP Légifrance introuvables sous ${PLUGIN_ROOT} — les clés sont enregistrées mais le serveur ne pourra pas démarrer.`);
  }

  const spin = spinner("Validation des clés PISTE (jeton OAuth2 puis recherche de test)...");
  const validation = await validatePisteCredentials(clientId, clientSecret, pisteEnv);

  if (validation.ok) {
    spin.succeed('Clés PISTE valides — connexion à l\'API Légifrance confirmée.');
    return { status: 'done', note: '' };
  }

  spin.fail('Échec de la validation des clés PISTE.');
  log.error(validation.message);
  return { status: 'partial', note: validation.message };
}

export async function check(ctx) {
  const env = ctx.env || {};
  const hasKeys = Boolean(env.LEGIFRANCE_CLIENT_ID && env.LEGIFRANCE_CLIENT_SECRET);
  const serverExists = fs.existsSync(MCP_SERVER_PATH);
  const mcpJsonExists = fs.existsSync(MCP_JSON_PATH);

  if (!serverExists || !mcpJsonExists) {
    return { status: 'failed', note: `Fichiers du serveur MCP Légifrance manquants sous ${PLUGIN_ROOT} — réinstallez piecemaker-plugin/.` };
  }
  if (!hasKeys) {
    return { status: 'failed', note: 'Clés PISTE absentes de .env — relancez cette étape.' };
  }
  return { status: 'done', note: `Clés PISTE présentes (environnement : ${env.LEGIFRANCE_ENV || 'sandbox'}). Validation réseau non refaite ici — utilisez --step 07-legifrance pour retester.` };
}

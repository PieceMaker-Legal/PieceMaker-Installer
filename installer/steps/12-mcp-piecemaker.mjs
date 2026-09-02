/**
 * Étape 12 — serveur MCP « piecemaker » (graphe, conversion, chronologie).
 *
 * Les commandes de graphe et de conversion sont aujourd'hui présentées au
 * modèle par du texte injecté dans les templates, sans rien qui relie ce
 * texte au binaire : une commande renommée laisserait plusieurs fichiers en
 * dérive silencieuse. `mcp/piecemaker/server.mjs` les expose comme outils
 * MCP typés à la place — chaque outil lance le binaire `piecemaker` en
 * sous-processus, jamais les modules internes, donc pas de dérive possible.
 *
 * Cette étape se contente de l'enregistrer auprès de Claude Code, en portée
 * `user` (proposé dans toutes les sessions, y compris hors dossier
 * juridique — les outils échouent alors proprement).
 */

import fs from 'node:fs';
import path from 'node:path';

import { log } from '../lib/ui.mjs';
import { REPO_ROOT, commandExists, run, runCapture } from '../lib/platform.mjs';

export const meta = {
  id: '12-mcp-piecemaker',
  label: 'Serveur MCP piecemaker (graphe, conversion, chronologie)',
  description: 'Enregistre dans Claude Code le serveur MCP qui expose le graphe juridique, la conversion et la chronologie',
};

const SERVER_NAME = 'piecemaker';
const SERVER_PATH = path.join(REPO_ROOT, 'mcp', 'piecemaker', 'server.mjs');

function dependencies(overrides = {}) {
  return {
    commandExists,
    existsSync: fs.existsSync,
    runCapture,
    run,
    log,
    ...overrides,
  };
}

/**
 * Lit l'enregistrement existant via `claude mcp get`. `claude` ne propose pas
 * de sortie JSON pour cette commande : on cherche simplement le chemin
 * attendu dans le texte rendu, ce qui suffit à distinguer « déjà à jour »
 * d'« enregistré ailleurs » (autre clone, chemin périmé) sans dépendre du
 * détail de mise en forme de la commande `get`.
 */
function existingRegistration(ops) {
  const result = ops.runCapture('claude', ['mcp', 'get', SERVER_NAME]);
  if (result.code !== 0) return { present: false };
  return { present: true, current: result.stdout.includes(SERVER_PATH) };
}

export async function install(ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(SERVER_PATH)) {
    return { status: 'skipped', note: `Serveur MCP introuvable : ${SERVER_PATH}.` };
  }
  if (!ops.commandExists('claude', ['--version'])) {
    return {
      status: 'skipped',
      note: 'CLI "claude" introuvable — installez Claude Code puis relancez cette étape.',
    };
  }

  const existing = existingRegistration(ops);
  if (existing.present && existing.current) {
    ops.log.ok(`Serveur MCP « ${SERVER_NAME} » déjà enregistré pour ce dépôt.`);
    return { status: 'done', note: '' };
  }

  if (ctx.dryRun) {
    ops.log.info(existing.present
      ? `[simulation] réenregistrement du serveur MCP « ${SERVER_NAME} » (il pointe actuellement ailleurs)`
      : `[simulation] enregistrement du serveur MCP « ${SERVER_NAME} »`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  // Comparer et écraser si différent, jamais passer parce que c'est déjà
  // présent : un autre clone ou un chemin périmé laisserait les outils MCP
  // pointer vers un binaire qui n'est plus celui que l'on développe ici.
  if (existing.present) {
    const removed = await ops.run('claude', ['mcp', 'remove', SERVER_NAME, '-s', 'user']);
    if (removed !== 0) {
      return {
        status: 'failed',
        note: `Impossible de retirer l'ancien enregistrement du serveur MCP. À la main : claude mcp remove ${SERVER_NAME} -s user`,
      };
    }
    ops.log.detail(`Ancien enregistrement de « ${SERVER_NAME} » retiré (il pointait ailleurs).`);
  }

  const added = await ops.run('claude', ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', 'node', SERVER_PATH]);
  if (added !== 0) {
    return {
      status: 'failed',
      note: `Échec de l'enregistrement du serveur MCP. À la main : claude mcp add -s user ${SERVER_NAME} -- node ${SERVER_PATH}`,
    };
  }
  ops.log.ok(`Serveur MCP « ${SERVER_NAME} » enregistré.`);
  return {
    status: 'done',
    note: 'Relancez les sessions Claude Code ouvertes pour voir les nouveaux outils.',
  };
}

export async function check(_ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(SERVER_PATH)) {
    return { status: 'skipped', note: `Serveur MCP introuvable : ${SERVER_PATH}.` };
  }
  if (!ops.commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }
  const existing = existingRegistration(ops);
  if (!existing.present) {
    return { status: 'failed', note: `Serveur MCP « ${SERVER_NAME} » non enregistré dans Claude Code.` };
  }
  if (!existing.current) {
    return { status: 'failed', note: `Serveur MCP « ${SERVER_NAME} » enregistré, mais pointe ailleurs que ce dépôt.` };
  }
  return { status: 'done', note: '' };
}

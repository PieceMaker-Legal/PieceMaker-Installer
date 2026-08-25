/**
 * Étape 09 — composants PieceMaker pour Claude Code.
 *
 * Aucun manifest ni marketplace PieceMaker n'est requis : les composants
 * présents dans `piecemaker-plugin/{skills,agents,hooks}` sont enregistrés
 * directement dans `~/.claude`, que Claude Code découvre à chaque session.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { log } from '../lib/ui.mjs';
import { REPO_ROOT, commandExists } from '../lib/platform.mjs';
import { depositRootClaudeMd } from '../lib/service.mjs';
import { loadConfig } from '../lib/state.mjs';

const require = createRequire(import.meta.url);
const { claudeAssetStatus, repositoryAssets, syncClaudeAssets } = require('../../websocket-server/claude-assets.cjs');
const { claudeHooksStatus, installClaudeHooks } = require('../../websocket-server/claude-hooks.cjs');
const { refreshRegisteredCaseRules } = require('../../websocket-server/case-instructions.cjs');

export const meta = {
  id: '09-claude-assets',
  label: 'Composants Claude Code PieceMaker',
  description: 'Enregistre localement les skills, agents et hooks PieceMaker lorsque Claude Code est présent',
};

const PLUGIN_DIR = path.join(REPO_ROOT, 'piecemaker-plugin');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const CLAUDE_MD_TEMPLATE = path.join(REPO_ROOT, 'installer', 'templates', 'root-CLAUDE.md');

function dependencies(overrides = {}) {
  return {
    commandExists,
    existsSync: fs.existsSync,
    userHome: os.homedir(),
    log,
    claudeAssetStatus,
    repositoryAssets,
    syncClaudeAssets,
    claudeHooksStatus,
    installClaudeHooks,
    depositRootClaudeMd,
    loadConfig,
    refreshRegisteredCaseRules,
    ...overrides,
  };
}

/**
 * Dépose la persona utilisateur si le CLAUDE.md racine est absent. Un fichier
 * existant n'est jamais remplacé, afin de préserver les repères d'un clone de
 * développement.
 */
function reconcileClaudeMd(ops) {
  const result = ops.depositRootClaudeMd();
  if (result.status === 'missing-template') {
    return { status: 'partial', note: `CLAUDE.md absent et gabarit introuvable (${CLAUDE_MD_TEMPLATE}).` };
  }
  if (result.status === 'deposited') {
    return { status: 'done', note: 'CLAUDE.md (persona utilisateur) déposé depuis le gabarit.' };
  }
  return { status: 'done', note: '' };
}

export async function install(ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(PLUGIN_DIR)) {
    return { status: 'skipped', note: 'Dossier piecemaker-plugin absent.' };
  }
  if (!ops.commandExists('claude', ['--version'])) {
    return {
      status: 'skipped',
      note: 'CLI "claude" introuvable — installez Claude Code puis relancez cette étape.',
    };
  }

  const assets = ops.repositoryAssets(REPO_ROOT);
  if (!assets.length) {
    return { status: 'skipped', note: 'Aucun skill ni agent PieceMaker à enregistrer dans Claude Code.' };
  }
  if (ctx.dryRun) {
    ops.log.info(`[simulation] enregistrement de ${assets.length} skill(s)/agent(s) PieceMaker dans ~/.claude`);
    ops.log.info('[simulation] fusion des hooks PieceMaker dans ~/.claude/settings.json');
    ops.log.info('[simulation] dépôt de CLAUDE.md (racine) depuis le gabarit si absent');
    ops.log.info('[simulation] actualisation des instructions des dossiers juridiques enregistrés');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const result = ops.syncClaudeAssets(REPO_ROOT, ops.userHome);
  ops.log.detail(`${result.registered} skill(s)/agent(s) PieceMaker enregistré(s) dans ~/.claude.`);
  for (const conflict of result.conflicts) {
    ops.log.warn(`« ${conflict.slug} » existe déjà dans ~/.claude et n'a pas été remplacé.`);
  }
  const hooks = ops.installClaudeHooks(REPO_ROOT, ops.userHome);
  if (!hooks.ok) {
    return { status: 'partial', note: hooks.reason };
  }
  ops.log.detail(`${hooks.registered} hook(s) PieceMaker enregistré(s) directement dans ~/.claude/settings.json.`);

  const instructions = ops.refreshRegisteredCaseRules(REPO_ROOT, ops.loadConfig());
  ops.log.detail(`${instructions.refreshed} dossier(s) juridique(s) muni(s) des instructions PieceMaker.`);
  for (const failure of instructions.failed) {
    ops.log.warn(`Instructions non actualisées pour ${failure.folder} : ${failure.error}`);
  }

  const claudeMd = reconcileClaudeMd(ops);
  if (claudeMd.status !== 'done') return claudeMd;
  if (result.conflicts.length) {
    return {
      status: 'partial',
      note: `${result.conflicts.length} skill(s)/agent(s) Claude personnel(s) homonyme(s) conservé(s).`,
    };
  }
  return { status: 'done', note: 'Composants PieceMaker disponibles à la prochaine session Claude Code.' };
}

export async function check(_ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(PLUGIN_DIR)) {
    return { status: 'skipped', note: 'Dossier piecemaker-plugin absent.' };
  }
  if (!ops.commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }

  const unregistered = ops.repositoryAssets(REPO_ROOT)
    .filter((asset) => !['linked', 'copied'].includes(
      ops.claudeAssetStatus(REPO_ROOT, ops.userHome, asset)?.state,
    ));
  const claudeMdOk = ops.existsSync(CLAUDE_MD);
  const hooksOk = ops.claudeHooksStatus(REPO_ROOT, ops.userHome).ok;

  if (!claudeMdOk && unregistered.length) {
    return {
      status: 'partial',
      note: `CLAUDE.md absent et ${unregistered.length} skill(s)/agent(s) non enregistré(s) dans ~/.claude.`,
    };
  }
  if (!claudeMdOk) return { status: 'partial', note: 'CLAUDE.md absent.' };
  if (!hooksOk) return { status: 'partial', note: 'Hooks PieceMaker non enregistrés dans ~/.claude/settings.json.' };
  if (unregistered.length) {
    return {
      status: 'partial',
      note: `${unregistered.length} skill(s)/agent(s) PieceMaker non enregistré(s) dans ~/.claude.`,
    };
  }
  return { status: 'done', note: '' };
}

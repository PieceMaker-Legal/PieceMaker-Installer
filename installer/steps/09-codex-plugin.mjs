/**
 * Étape 09 — composants PieceMaker pour la CLI Codex.
 *
 * Aucune entrée de marketplace ni aucun plugin d'application n'est créé :
 * les skills sont enregistrés dans `~/.codex/skills/` et la sentinelle du
 * proxy dans `~/.codex/hooks.json`, deux emplacements locaux découverts par
 * la CLI Codex. Claude Code et son marketplace restent entièrement inchangés.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { log } from '../lib/ui.mjs';
import { REPO_ROOT, commandExists } from '../lib/platform.mjs';
import {
  codexSessionHookStatus,
  codexSkillStatus,
  installCodexSessionHook,
  repositoryCodexSkills,
  syncCodexSkills,
} from '../lib/codex-skills.mjs';
import { loadConfig } from '../lib/state.mjs';

const require = createRequire(import.meta.url);
const { refreshRegisteredCaseRules } = require('../../websocket-server/case-instructions.cjs');

export const meta = {
  id: '09-codex-plugin',
  label: 'Composants Codex PieceMaker',
  description: 'Enregistre les skills et le badge d’anonymisation lorsque la CLI Codex est présente',
  required: false,
};

const PLUGIN_DIR = path.join(REPO_ROOT, 'piecemaker-plugin');

function dependencies(overrides = {}) {
  return {
    commandExists,
    existsSync: fs.existsSync,
    userHome: os.homedir(),
    log,
    codexSkillStatus,
    codexSessionHookStatus,
    installCodexSessionHook,
    repositoryCodexSkills,
    syncCodexSkills,
    loadConfig,
    refreshRegisteredCaseRules,
    ...overrides,
  };
}

export async function install(ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(PLUGIN_DIR)) {
    return { status: 'skipped', note: 'Dossier piecemaker-plugin absent.' };
  }
  if (!ops.commandExists('codex', ['--version'])) {
    return { status: 'skipped', note: 'CLI "codex" introuvable.' };
  }

  const skills = ops.repositoryCodexSkills(REPO_ROOT);
  if (!skills.length) {
    return { status: 'skipped', note: 'Aucun skill PieceMaker à enregistrer dans Codex.' };
  }
  if (ctx.dryRun) {
    ops.log.info(`[simulation] enregistrement de ${skills.length} skill(s) PieceMaker dans ~/.codex/skills`);
    ops.log.info('[simulation] enregistrement du badge d’anonymisation au démarrage des sessions Codex');
    ops.log.info('[simulation] actualisation des instructions AGENTS.md des dossiers enregistrés');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const result = ops.syncCodexSkills(REPO_ROOT, ops.userHome);
  ops.log.detail(`${result.registered} skill(s) PieceMaker enregistré(s) pour la CLI Codex.`);
  for (const conflict of result.conflicts) {
    ops.log.warn(`Le skill Codex personnel « ${conflict.slug} » existe déjà et n'a pas été remplacé.`);
  }
  const sessionHook = ops.installCodexSessionHook(REPO_ROOT, ops.userHome);
  if (!sessionHook.ok) {
    ops.log.warn(`Badge d’anonymisation Codex non enregistré : ${sessionHook.reason}.`);
  } else {
    ops.log.detail(`Badge d’anonymisation Codex ${sessionHook.changed ? 'enregistré' : 'déjà à jour'} dans ~/.codex/hooks.json.`);
  }
  const instructions = ops.refreshRegisteredCaseRules(REPO_ROOT, ops.loadConfig());
  ops.log.detail(`${instructions.refreshed} dossier(s) juridique(s) muni(s) des instructions Codex/Claude.`);
  for (const failure of instructions.failed) {
    ops.log.warn(`Instructions non actualisées pour ${failure.folder} : ${failure.error}`);
  }
  if (result.conflicts.length || !sessionHook.ok) {
    return {
      status: 'partial',
      note: !sessionHook.ok
        ? `Badge d’anonymisation Codex non enregistré (${sessionHook.reason}).`
        : `${result.conflicts.length} skill(s) Codex personnel(s) homonyme(s) conservé(s).`,
    };
  }
  return { status: 'done', note: 'Skills et badge PieceMaker disponibles à la prochaine session Codex CLI.' };
}

export async function check(_ctx, overrides = {}) {
  const ops = dependencies(overrides);
  if (!ops.existsSync(PLUGIN_DIR)) {
    return { status: 'skipped', note: 'Dossier piecemaker-plugin absent.' };
  }
  if (!ops.commandExists('codex', ['--version'])) {
    return { status: 'skipped', note: 'CLI "codex" introuvable.' };
  }

  const skills = ops.repositoryCodexSkills(REPO_ROOT);
  const missing = skills.filter((relativePath) => {
    const state = ops.codexSkillStatus(REPO_ROOT, ops.userHome, relativePath)?.state;
    return state !== 'linked' && state !== 'copied';
  });
  if (missing.length) {
    return {
      status: 'partial',
      note: `${missing.length} skill(s) PieceMaker non enregistré(s) dans ~/.codex/skills.`,
    };
  }
  const sessionHook = ops.codexSessionHookStatus(REPO_ROOT, ops.userHome);
  if (!sessionHook.ok) {
    return { status: 'partial', note: `Badge d’anonymisation Codex absent ou périmé (${sessionHook.reason}).` };
  }
  return { status: 'done', note: '' };
}

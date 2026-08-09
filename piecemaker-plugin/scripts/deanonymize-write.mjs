#!/usr/bin/env node
/**
 * PreToolUse hook — rétablit les vrais noms sur tout ce que l'IA produit.
 *
 * Symétrique d'`anonymize-read.mjs` : le modèle ne voit et ne manipule que des
 * codes, mais ce qui atterrit chez un humain doit être lisible. La réécriture
 * se fait sur `updatedInput`, donc avant que l'outil s'exécute — le fichier
 * écrit, le message Telegram envoyé portent le nom réel, sans qu'il soit jamais
 * repassé par l'API.
 *
 * `Edit` réécrit **les deux** chaînes. C'est structurel : le modèle a lu le
 * fichier à travers le mapping, son `old_string` porte donc des codes, alors
 * que le disque porte les noms réels. Ne reverter que `new_string` ferait
 * échouer chaque édition sur « chaîne introuvable ».
 *
 * Telegram passe par l'outil MCP `reply` du plugin officiel
 * (`telegram/server.ts`), pas par le canal du harnais : `updatedInput` suffit
 * donc, sans rien savoir des internes du plugin.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPieceMakerConfig, readHookPayload, runHook, noop } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { resolveConfiguredCaseMapping, revertMapping } = require('./lib/mapping.cjs');

/** Champs textuels à rétablir, par outil. */
const FIELDS_BY_TOOL = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
};

/** Outils MCP Telegram porteurs d'un message sortant. */
const TELEGRAM_TOOLS = /^mcp__[^_]*telegram[^_]*__(reply|edit_message)$/;

function absolutePath(value, cwd) {
  if (!value) return null;
  const raw = String(value);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

function fieldsFor(toolName) {
  if (FIELDS_BY_TOOL[toolName]) return FIELDS_BY_TOOL[toolName];
  if (TELEGRAM_TOOLS.test(toolName)) return ['text'];
  return null;
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;

  const toolName = String(payload.tool_name || '');
  const fields = fieldsFor(toolName);
  if (!fields) return null;

  const config = loadPieceMakerConfig();
  if (config.anonymization?.enabled === false) return null;
  const cwd = payload.cwd || process.cwd();
  // Un message Telegram n'a pas de chemin : le dossier vient du répertoire de
  // travail, qui est celui de l'assistant du dossier (orchestrator/launch-telegram.sh).
  const hint = absolutePath(payload.tool_input?.file_path, cwd) || cwd;
  const legalCase = resolveConfiguredCaseMapping(config, hint);
  if (!legalCase) return null;

  const updatedInput = {};
  for (const field of fields) {
    const value = payload.tool_input?.[field];
    if (typeof value !== 'string' || !value) continue;
    const reverted = revertMapping(value, legalCase.reverse_mapping);
    if (reverted !== value) updatedInput[field] = reverted;
  }
  if (!Object.keys(updatedInput).length) return null;

  // Pas de `permissionDecision` : ce hook réécrit, il n'autorise pas. Émettre
  // `allow` ici approuverait en silence toutes les écritures du dossier.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...payload.tool_input, ...updatedInput },
    },
  };
}

runHook(main, { timeoutMs: 5000 }).catch(() => noop());

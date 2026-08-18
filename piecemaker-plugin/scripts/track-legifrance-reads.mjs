#!/usr/bin/env node
/**
 * PostToolUse hook (Read) — trace les lectures dans un dossier de résultats
 * Legifrance téléchargé par l'outil MCP `Download_Query_Results`.
 *
 * Purement mécanique (« synthetic & static », jamais un LLM) : si le fichier lu
 * est sous un dossier portant le marqueur `.legifrance-results.json`, la lecture
 * est comptabilisée dans `.read-log.json` à la racine de ce dossier. C'est ce
 * qui permet à l'orchestrateur de savoir quelles décisions l'agent de tri a
 * réellement ouvertes.
 *
 * Fail-open : hors dossier de résultats, ou sur la moindre erreur → exit 0,
 * stdout vide, la session n'est pas affectée.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { noop, readHookPayload, runHook } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { findResultsRoot, recordRead } = require('./lib/legifrance-reads.cjs');

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || payload.tool_name !== 'Read') return null;
  if (payload.tool_response?.success === false) return null;

  const cwd = payload.cwd || process.cwd();
  const target = payload.tool_input?.file_path;
  if (!target) return null;
  const absolute = path.isAbsolute(target) ? target : path.resolve(cwd, target);

  const root = findResultsRoot(absolute);
  if (!root) return null;

  const relFile = path.relative(root, absolute);
  if (!relFile || relFile.startsWith('..')) return null;

  recordRead(root, relFile, {
    sessionId: payload.session_id || null,
    toolUseId: payload.tool_use_id || null,
  });
  return null;
}

runHook(main, { timeoutMs: 4000 }).catch(() => noop());

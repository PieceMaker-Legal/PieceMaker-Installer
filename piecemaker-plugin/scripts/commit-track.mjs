#!/usr/bin/env node
/**
 * PostToolUse hook — records every successful Write/Edit as a per-case commit.
 *
 * Each explicitly registered folder (and each legacy workspace child) is an
 * independent legal case.
 * Its Markdown and mapping JSON history lives outside client data under
 * ~/.piecemaker/case-history/. Original pieces are never opened or indexed.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  HOME_DIR,
  loadPieceMakerConfig,
  noop,
  readHookPayload,
  runHook,
} from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { createCommit, locateCaseFile } = require('./lib/commits.cjs');
const { locateConfiguredCase } = require('./lib/case-folders.cjs');
const { revertMapping } = require('./lib/mapping.cjs');
const { readCentralMapping } = require('./lib/central-mapping.cjs');

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || !['Write', 'Edit'].includes(payload.tool_name)) return null;
  if (payload.tool_response?.success === false) return null;

  const config = loadPieceMakerConfig();
  if (config.commits?.enabled === false) return null;

  const cwd = payload.cwd || process.cwd();
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  let located;
  try {
    const configured = locateConfiguredCase(config, absolute);
    if (!configured) return null;
    located = locateCaseFile(configured.casesRoot, absolute);
  } catch {
    return null;
  }
  if (!located?.safe || located.protected) return null;

  // Le nom d'un fichier porte souvent une entité
  // (« 06_Email_..._par_CAITLYN_SA.md ») : l'historique du cabinet doit rester
  // lisible, alors que l'IA n'a vu que des codes. On rétablit avec le mapping
  // central (schéma de codes unique désormais appliqué par le hook central).
  const central = readCentralMapping();
  const relative = revertMapping(located.relative, central.reverse_mapping);

  await createCommit({
    casesRoot: located.casesRoot,
    caseName: located.name,
    homeDir: HOME_DIR,
    label: `${payload.tool_name === 'Write' ? 'Création' : 'Modification'} de ${relative}`,
    sessionId: payload.session_id || null,
    event: 'PostToolUse',
    paths: [located.relative],
    waitForLockMs: 4000,
  });
  return null;
}

const timeoutMs = loadPieceMakerConfig().commits?.timeoutMs ?? 8000;
runHook(main, { timeoutMs }).catch(() => noop());

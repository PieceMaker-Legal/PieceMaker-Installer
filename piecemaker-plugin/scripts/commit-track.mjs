#!/usr/bin/env node
/**
 * PostToolUse hook — marque le dossier de cas touché par un Write/Edit.
 *
 * Ne commite plus rien lui-même (aucun appel git) : il note juste, pour la
 * session en cours, quel dossier de cas a bougé pendant CE tour, dans
 * `~/.piecemaker/pending/<session_id>.json`. Le hook `Stop`
 * (`session-commit.mjs`) déclenche à la fin du tour un worker détaché
 * (`session-commit-worker.mjs`) qui consomme ce fichier et fait le commit
 * réel — un seul commit par tour et par dossier, au lieu d'un commit par
 * Write/Edit.
 *
 * Chaque dossier de cas explicitement enregistré (et chaque enfant de
 * l'espace de travail historique) reste une affaire indépendante. Les pièces
 * originales ne sont ni ouvertes ni indexées ici.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import {
  HOME_DIR,
  appendJsonl,
  loadPieceMakerConfig,
  noop,
  readHookPayload,
  runHook,
} from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { locateCaseFile } = require('./lib/commits.cjs');
const { locateConfiguredCase } = require('./lib/case-folders.cjs');

const PENDING_DIR = path.join(HOME_DIR, 'pending');

function sanitizeSessionId(sessionId) {
  return String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9_-]/g, '_');
}

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

  const pendingFile = path.join(PENDING_DIR, `${sanitizeSessionId(payload.session_id)}.json`);
  appendJsonl(pendingFile, {
    casesRoot: located.casesRoot,
    caseName: located.name,
    ts: new Date().toISOString(),
  });
  return null;
}

const timeoutMs = loadPieceMakerConfig().commits?.timeoutMs ?? 8000;
runHook(main, { timeoutMs }).catch(() => noop());

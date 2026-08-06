#!/usr/bin/env node
/**
 * PreToolUse hook — hard boundary around each case's “pièces originales”.
 *
 * The UI may enumerate names and protection metadata, but Claude must never
 * read original contents. Converted Markdown and mapping JSON remain usable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPieceMakerConfig, readHookPayload, runHook, noop } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { isOriginalDirectoryName, isProtectedOriginalPath } = require('./lib/commits.cjs');

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
    systemMessage: reason,
  };
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function isBroadCaseSearch(filePath, casesRoot) {
  if (!filePath || !casesRoot) return false;
  const candidate = path.resolve(filePath);
  const root = path.resolve(casesRoot);
  if (candidate === root) return true;
  if (!candidate.startsWith(`${root}${path.sep}`)) return false;
  const relative = path.relative(root, candidate);
  if (!relative || relative.split(path.sep).length !== 1) return false;
  try {
    return fs.statSync(candidate).isDirectory() && fs.readdirSync(candidate, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && isOriginalDirectoryName(entry.name));
  } catch {
    return true;
  }
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;
  const config = loadPieceMakerConfig();
  const casesRoot = config.workspacePath;
  if (!casesRoot) return null;
  const reason = '[PieceMaker] Accès refusé : les pièces originales sont isolées et interdites à l’IA. Utilisez uniquement le Markdown converti hors de ce dossier.';

  if (payload.tool_name === 'Bash') {
    const command = normalize(payload.tool_input?.command);
    if (command.includes('pieces originales')) return deny(reason);
    return null;
  }

  if (!['Read', 'Grep', 'Glob'].includes(payload.tool_name)) return null;
  const filePath = payload.tool_input?.file_path || payload.tool_input?.path;
  const pattern = payload.tool_input?.pattern || payload.tool_input?.glob || '';
  if (isProtectedOriginalPath(filePath, casesRoot) || normalize(pattern).includes('pieces originales')) return deny(reason);
  if ((payload.tool_name === 'Grep' || payload.tool_name === 'Glob') && isBroadCaseSearch(filePath, casesRoot)) {
    return deny(`${reason} Une recherche récursive à la racine risquerait de parcourir ce dossier ; ciblez un fichier Markdown précis.`);
  }
  return null;
}

runHook(main, { timeoutMs: 3000 }).catch(() => noop());

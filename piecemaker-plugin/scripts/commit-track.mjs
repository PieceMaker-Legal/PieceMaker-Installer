#!/usr/bin/env node
/**
 * PostToolUse hook — records every successful Write/Edit as a per-case commit.
 *
 * Each immediate child of config.workspacePath is an independent legal case.
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

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || !['Write', 'Edit'].includes(payload.tool_name)) return null;
  if (payload.tool_response?.success === false) return null;

  const config = loadPieceMakerConfig();
  if (config.commits?.enabled === false) return null;

  const cwd = payload.cwd || process.cwd();
  const casesRoot = config.workspacePath;
  if (!casesRoot) return null;
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  let located;
  try {
    located = locateCaseFile(casesRoot, absolute);
  } catch {
    return null;
  }
  if (!located?.safe || located.protected) return null;

  createCommit({
    casesRoot,
    caseName: located.name,
    homeDir: HOME_DIR,
    label: `${payload.tool_name === 'Write' ? 'Création' : 'Modification'} de ${located.relative}`,
    sessionId: payload.session_id || null,
    event: 'PostToolUse',
  });
  return null;
}

const timeoutMs = loadPieceMakerConfig().commits?.timeoutMs ?? 8000;
runHook(main, { timeoutMs }).catch(() => noop());

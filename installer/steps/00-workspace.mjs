/**
 * Step 00 — choose the PieceMaker legal workspace.
 *
 * workspacePath is the single storage boundary: every generated file is
 * routed into the active legal matter below this directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ask } from '../lib/prompt.mjs';
import { ensureDir } from '../lib/platform.mjs';
import { updateConfig } from '../lib/state.mjs';
import { log } from '../lib/ui.mjs';

export const meta = {
  id: '00-workspace',
  label: 'Dossier racine PieceMaker',
  description: 'Choisit la racine contenant les dossiers juridiques indépendants',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Reuse the folder selected in the former desktop application when present. */
function legacyWorkspacePath() {
  const candidates = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'piecemaker', 'config.json')]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA || '', 'piecemaker', 'config.json')]
      : [path.join(os.homedir(), '.config', 'piecemaker', 'config.json')];

  for (const file of candidates) {
    const config = readJson(file);
    const candidate = config?.config?.basePath || config?.basePath;
    if (candidate && path.isAbsolute(candidate)) return path.normalize(candidate);
  }
  return null;
}

function defaultWorkspace(ctx) {
  return process.env.PIECEMAKER_WORKSPACE_PATH
    || ctx.config?.workspacePath
    || legacyWorkspacePath()
    || path.join(os.homedir(), 'Documents', 'PieceMaker');
}

function normalizeWorkspace(input) {
  const expanded = String(input || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!expanded) throw new Error('Le dossier racine PieceMaker est requis.');
  return path.resolve(expanded);
}

export async function install(ctx) {
  const selected = normalizeWorkspace(await ask(
    'Dossier racine PieceMaker (un sous-dossier par dossier juridique)',
    { def: defaultWorkspace(ctx), required: true }
  ));

  if (ctx.dryRun) {
    log.info(`[simulation] racine PieceMaker : ${selected}`);
    return { status: 'skipped', note: selected };
  }

  ensureDir(selected);
  const anonymization = ctx.config?.anonymization
    ? { ...ctx.config.anonymization, watchPaths: [selected] }
    : undefined;
  updateConfig({
    workspacePath: selected,
    outputPath: selected,
    ...(anonymization ? { anonymization } : {}),
  });
  log.ok(`Racine PieceMaker : ${selected}`);
  log.detail('Toutes les productions seront intégrées au dossier juridique actif sous cette racine.');
  return { status: 'done', note: selected };
}

export async function check(ctx) {
  const selected = ctx.config?.workspacePath;
  if (!selected || !path.isAbsolute(selected)) {
    return { status: 'partial', note: 'Racine des dossiers juridiques non configurée — relancez cette étape.' };
  }
  if (!fs.existsSync(selected) || !fs.statSync(selected).isDirectory()) {
    return { status: 'partial', note: `Dossier introuvable : ${selected}` };
  }
  return { status: 'done', note: selected };
}

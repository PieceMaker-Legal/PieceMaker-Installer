/**
 * Step 00 — choose the PieceMaker legal workspace.
 *
 * workspacePath is the single storage boundary: every generated file is
 * routed into the active legal matter below this directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ask } from '../lib/prompt.mjs';
import { ensureDir } from '../lib/platform.mjs';
import { updateConfig } from '../lib/state.mjs';
import { log } from '../lib/ui.mjs';

export const meta = {
  id: '00-workspace',
  label: 'Dossier racine PieceMaker',
  description: 'Choisit la racine contenant les dossiers juridiques indépendants',
};

const WORKSPACE_CLAUDE_MD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
  'workspace-CLAUDE.md'
);

/**
 * CLAUDE.md at the workspace root — Claude Code walks up from the current
 * directory, so a single file here orients every session opened in a legal
 * matter (each one is an immediate child of this root). A file already in
 * place is never overwritten: it may carry the firm's own instructions.
 */
function ensureWorkspaceClaudeMd(workspace) {
  const target = path.join(workspace, 'CLAUDE.md');
  if (fs.existsSync(target)) return 'present';
  if (!fs.existsSync(WORKSPACE_CLAUDE_MD)) return 'missing-template';
  fs.copyFileSync(WORKSPACE_CLAUDE_MD, target);
  return 'created';
}

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

  const claudeMd = ensureWorkspaceClaudeMd(selected);
  if (claudeMd === 'created') log.ok('CLAUDE.md installé à la racine — lu par toute session ouverte dans un dossier juridique.');
  else if (claudeMd === 'present') log.detail('CLAUDE.md déjà présent à la racine — conservé tel quel.');
  else log.warn('Modèle installer/templates/workspace-CLAUDE.md introuvable — CLAUDE.md non installé.');

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
  if (!fs.existsSync(path.join(selected, 'CLAUDE.md'))) {
    return { status: 'partial', note: `CLAUDE.md absent de ${selected} — relancez cette étape.` };
  }
  return { status: 'done', note: selected };
}

/**
 * Step 09 — PieceMaker's own Claude Code plugin (marketplace + install) and
 * the root CLAUDE.md.
 *
 * The plugin (piecemaker-plugin/) bundles skills/ and agents/ via Claude
 * Code's default component auto-discovery — installing it is what delivers
 * requirement #7 ("root CLAUDE.md + skills + agents"). CLAUDE.md itself is
 * NOT a plugin component (plugin.json only supports skills/commands/agents/
 * hooks/mcpServers/outputStyles) — it is a git-tracked file at the repo
 * root that Claude Code auto-discovers per-project, handled separately
 * below via reconcileClaudeMd().
 *
 * Subcommands verified live against `claude` 2.1.222 (`claude plugin --help`,
 * `claude plugin marketplace --help`, `claude plugin install --help`,
 * `claude plugin marketplace add --help`):
 *   claude plugin marketplace add <source>   (URL, path, or GitHub "owner/repo")
 *   claude plugin marketplace list --json
 *   claude plugin install <plugin>[@marketplace]
 *   claude plugin list --json
 *
 * Marketplace source: this step tries the published GitHub source first
 * (PieceMaker-Legal/PieceMaker-Installer, matching the manual
 * `/plugin marketplace add PieceMaker-Legal/PieceMaker-Installer` documented
 * for end users, and the only source Claude Code's background refresher
 * polls for the "auto-update on session open" behaviour). If that fails
 * (repo not pushed yet, offline, private repo without credentials) it falls
 * back to registering the local working copy (REPO_ROOT) as a path-based
 * marketplace, which works but does not get background auto-refresh — see
 * piecemaker-plugin/README.md for the caveat.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { REPO_ROOT, commandExists, run, runCapture } from '../lib/platform.mjs';

export const meta = {
  id: '09-claude-assets',
  label: 'Plugin Claude Code PieceMaker',
  description: 'Enregistre le marketplace piecemaker, installe le plugin (skills + agents) et vérifie CLAUDE.md',
};

const REPO_SLUG = 'PieceMaker-Legal/PieceMaker-Installer';
const MARKETPLACE_NAME = 'piecemaker';
const PLUGIN_NAME = 'piecemaker';
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

function parseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function listMarketplaces() {
  const result = runCapture('claude', ['plugin', 'marketplace', 'list', '--json']);
  return result.code === 0 ? parseJson(result.stdout) : null;
}

function listPlugins() {
  const result = runCapture('claude', ['plugin', 'list', '--json']);
  return result.code === 0 ? parseJson(result.stdout) : null;
}

function isPluginInstalled(plugins) {
  return Array.isArray(plugins) && plugins.some((p) => p.id === PLUGIN_SPEC && p.enabled !== false);
}

async function ensureMarketplace() {
  const marketplaces = listMarketplaces();
  if (Array.isArray(marketplaces) && marketplaces.some((m) => m.name === MARKETPLACE_NAME)) {
    log.ok(`Marketplace "${MARKETPLACE_NAME}" déjà enregistré.`);
    return { ok: true };
  }

  let spin = spinner(`Enregistrement du marketplace depuis GitHub (${REPO_SLUG})...`);
  let code = await run('claude', ['plugin', 'marketplace', 'add', REPO_SLUG]);
  if (code === 0) {
    spin.succeed('Marketplace enregistré depuis GitHub — mises à jour automatiques actives.');
    return { ok: true, source: 'github' };
  }
  spin.fail('Échec depuis GitHub (dépôt non publié, privé sans accès, ou hors ligne).');

  spin = spinner(`Repli : enregistrement depuis la copie locale (${REPO_ROOT})...`);
  code = await run('claude', ['plugin', 'marketplace', 'add', REPO_ROOT]);
  if (code === 0) {
    spin.succeed('Marketplace enregistré depuis la copie locale du dépôt.');
    log.detail('Source locale : pas de rafraîchissement automatique en arrière-plan (voir piecemaker-plugin/README.md).');
    return { ok: true, source: 'local' };
  }
  spin.fail('Échec de l\'enregistrement du marketplace (GitHub et copie locale).');
  return { ok: false };
}

async function ensurePlugin() {
  const plugins = listPlugins();
  if (isPluginInstalled(plugins)) {
    log.ok(`Plugin "${PLUGIN_SPEC}" déjà installé et activé.`);
    return true;
  }

  const spin = spinner(`Installation du plugin (${PLUGIN_SPEC})...`);
  const code = await run('claude', ['plugin', 'install', PLUGIN_SPEC]);
  if (code === 0) {
    spin.succeed('Plugin installé (skills + agents disponibles).');
    return true;
  }
  spin.fail('Échec de l\'installation du plugin.');
  return false;
}

/**
 * CLAUDE.md is git-tracked, not plugin-delivered. This never fabricates
 * content: it only ever restores from `git show HEAD:CLAUDE.md`, and only
 * with explicit confirmation, defaulting to keeping whatever is on disk.
 */
async function reconcileClaudeMd() {
  const existsOnDisk = fs.existsSync(CLAUDE_MD);

  if (!commandExists('git', ['--version'])) {
    if (existsOnDisk) return { status: 'done', note: '' };
    return { status: 'partial', note: 'CLAUDE.md absent et git indisponible pour le restaurer.' };
  }

  const tracked = runCapture('git', ['show', 'HEAD:CLAUDE.md'], { cwd: REPO_ROOT });

  if (tracked.code !== 0) {
    // Not committed at HEAD (e.g. on a feature branch not yet merged) —
    // the working-tree copy, if present, is all we can go by.
    if (existsOnDisk) return { status: 'done', note: '' };
    return { status: 'partial', note: 'CLAUDE.md absent (ni sur le disque ni encore versionné) — rien à installer automatiquement.' };
  }

  if (!existsOnDisk) {
    const restore = await confirm('CLAUDE.md est absent mais présent dans git. Le restaurer ?', true);
    if (!restore) return { status: 'partial', note: 'CLAUDE.md non restauré (choix utilisateur).' };
    const code = await run('git', ['checkout', '--', 'CLAUDE.md'], { cwd: REPO_ROOT });
    return code === 0
      ? { status: 'done', note: 'CLAUDE.md restauré depuis git.' }
      : { status: 'failed', note: 'Échec de "git checkout -- CLAUDE.md".' };
  }

  const onDisk = fs.readFileSync(CLAUDE_MD, 'utf8');
  const trackedContent = tracked.stdout.endsWith('\n') ? tracked.stdout : `${tracked.stdout}\n`;
  if (onDisk === trackedContent || onDisk === tracked.stdout) {
    return { status: 'done', note: '' };
  }

  // Existing file differs from the versioned one — never overwrite silently.
  log.warn('CLAUDE.md local diffère de la version versionnée dans git (modifications locales détectées).');
  const keepLocal = await confirm('Conserver votre version locale de CLAUDE.md ?', true);
  if (keepLocal) {
    return { status: 'done', note: 'Version locale de CLAUDE.md conservée (diffère de git).' };
  }
  const code = await run('git', ['checkout', '--', 'CLAUDE.md'], { cwd: REPO_ROOT });
  return code === 0
    ? { status: 'done', note: 'CLAUDE.md réinitialisé à la version versionnée dans git.' }
    : { status: 'failed', note: 'Échec de "git checkout -- CLAUDE.md".' };
}

export async function install(ctx) {
  if (!commandExists('claude', ['--version'])) {
    return {
      status: 'skipped',
      note: 'CLI "claude" introuvable — installez Claude Code puis relancez cette étape.',
    };
  }

  if (ctx.dryRun) {
    log.info(`[simulation] claude plugin marketplace add ${REPO_SLUG} (repli local : ${REPO_ROOT})`);
    log.info(`[simulation] claude plugin install ${PLUGIN_SPEC}`);
    log.info('[simulation] vérification de CLAUDE.md (racine)');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const marketplace = await ensureMarketplace();
  if (!marketplace.ok) {
    return { status: 'failed', note: `Impossible d'enregistrer le marketplace "${MARKETPLACE_NAME}".` };
  }

  const pluginOk = await ensurePlugin();
  const claudeMdResult = await reconcileClaudeMd();

  if (!pluginOk) {
    return {
      status: 'failed',
      note: `Marketplace enregistré mais échec de "claude plugin install ${PLUGIN_SPEC}".`,
    };
  }

  if (claudeMdResult.status !== 'done') {
    return { status: 'partial', note: claudeMdResult.note || 'CLAUDE.md nécessite une action manuelle.' };
  }

  return { status: 'done', note: '' };
}

export async function check(ctx) {
  if (!commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }

  const plugins = listPlugins();
  const pluginInstalled = isPluginInstalled(plugins);
  const claudeMdOk = fs.existsSync(CLAUDE_MD);

  if (pluginInstalled && claudeMdOk) return { status: 'done', note: '' };
  if (!pluginInstalled && !claudeMdOk) return { status: 'failed', note: 'Plugin non installé et CLAUDE.md absent.' };
  return {
    status: 'partial',
    note: !pluginInstalled ? 'CLAUDE.md présent, plugin non installé.' : 'Plugin installé, CLAUDE.md absent.',
  };
}

/**
 * Step 08 — official Telegram plugin (claude-plugins-official).
 *
 * PieceMaker does NOT ship its own Telegram client. Anthropic's official
 * "telegram" plugin already does this (grammY-based MCP server, its own
 * pairing/allowlist system, its own /telegram:configure and /telegram:access
 * skills). This step only: (1) makes sure that plugin is installed and
 * enabled, (2) walks the user through creating a bot with @BotFather, and
 * (3) hands the token to the plugin's own configuration skill instead of
 * writing TELEGRAM_BOT_TOKEN anywhere ourselves.
 *
 * Verified against a live `claude` 2.1.222 install:
 *   claude plugin marketplace list --json   -> [{ name: "claude-plugins-official",
 *     source: "github", repo: "anthropics/claude-plugins-official", installLocation }]
 *   claude plugin list --json               -> [{ id: "telegram@claude-plugins-official",
 *     version, scope, enabled, installPath, mcpServers }, ...]
 *   claude plugin install <plugin>          -> "Install a plugin from available marketplaces"
 * The plugin's own README (~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/README.md)
 * documents /telegram:configure <token>, which "Writes TELEGRAM_BOT_TOKEN=...
 * to ~/.claude/channels/telegram/.env". Its skill frontmatter
 * (.../telegram/<version>/skills/configure/SKILL.md) declares
 * `allowed-tools: Read, Write, Bash(ls *), Bash(mkdir *)`, which Claude Code
 * grants for the skill's own execution — this is what lets us drive it
 * headlessly via `claude -p` without --dangerously-skip-permissions.
 *
 * OPEN QUESTION (see final report): whether `claude -p "/telegram:configure
 * <token>"` reliably loads plugin skills in print/non-interactive mode is
 * not documented in `claude --help` and was not executed live here (it would
 * write a real token to the operator's real ~/.claude/channels/telegram/.env).
 * The token is passed as a single argv element via node's spawnSync argv
 * array (no shell involved, so no shell-history/injection exposure), but it
 * is transiently visible in `ps` output on the local machine while the
 * subprocess runs — flagged as a known limitation, not silently accepted.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm, secret } from '../lib/prompt.mjs';
import { commandExists, run, runCapture } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

export const meta = {
  id: '08-telegram',
  label: 'Plugin Telegram officiel',
  description: "Installe le plugin Telegram officiel de Claude Code et configure le token du bot",
};

const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
const PLUGIN_ID = 'telegram';
const PLUGIN_SPEC = `${PLUGIN_ID}@${OFFICIAL_MARKETPLACE}`;
const TELEGRAM_ENV = path.join(os.homedir(), '.claude', 'channels', 'telegram', '.env');
const CONFIGURE_TIMEOUT_MS = 90000;

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

function isTelegramInstalled(plugins) {
  return Array.isArray(plugins) && plugins.some((p) => p.id === PLUGIN_SPEC && p.enabled !== false);
}

/** Read-only check — never writes here. The plugin's own skill owns writing this file. */
function hasTokenConfigured() {
  if (!fs.existsSync(TELEGRAM_ENV)) return false;
  try {
    return /^TELEGRAM_BOT_TOKEN=.+/m.test(fs.readFileSync(TELEGRAM_ENV, 'utf8'));
  } catch {
    return false;
  }
}

async function ensureOfficialMarketplace() {
  const marketplaces = listMarketplaces();
  const already = Array.isArray(marketplaces) && marketplaces.some((m) => m.name === OFFICIAL_MARKETPLACE);
  if (already) {
    log.ok(`Marketplace officiel "${OFFICIAL_MARKETPLACE}" déjà enregistré.`);
    return true;
  }

  const spin = spinner(`Enregistrement du marketplace officiel (${OFFICIAL_MARKETPLACE_REPO})...`);
  const code = await run('claude', ['plugin', 'marketplace', 'add', OFFICIAL_MARKETPLACE_REPO]);
  if (code === 0) {
    spin.succeed('Marketplace officiel enregistré.');
    return true;
  }
  spin.fail('Échec de l\'enregistrement du marketplace officiel.');
  return false;
}

async function ensureTelegramPlugin() {
  const plugins = listPlugins();
  if (isTelegramInstalled(plugins)) {
    log.ok(`Plugin "${PLUGIN_SPEC}" déjà installé et activé.`);
    return true;
  }

  const spin = spinner(`Installation du plugin officiel (${PLUGIN_SPEC})...`);
  const code = await run('claude', ['plugin', 'install', PLUGIN_SPEC]);
  if (code === 0) {
    spin.succeed('Plugin Telegram installé.');
    return true;
  }
  spin.fail('Échec de l\'installation du plugin Telegram.');
  return false;
}

export async function install(ctx) {
  if (!commandExists('claude', ['--version'])) {
    return {
      status: 'skipped',
      note: 'CLI "claude" introuvable — installez Claude Code puis relancez cette étape.',
    };
  }

  if (ctx.dryRun) {
    log.info(`[simulation] claude plugin marketplace add ${OFFICIAL_MARKETPLACE_REPO}`);
    log.info(`[simulation] claude plugin install ${PLUGIN_SPEC}`);
    log.info('[simulation] claude -p "/telegram:configure ***" (token masqué)');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const marketplaceOk = await ensureOfficialMarketplace();
  if (!marketplaceOk) {
    return {
      status: 'failed',
      note: `Impossible d'accéder au marketplace officiel Claude Code (${OFFICIAL_MARKETPLACE_REPO}). Vérifiez la connexion réseau.`,
    };
  }

  const pluginOk = await ensureTelegramPlugin();
  if (!pluginOk) {
    return {
      status: 'failed',
      note: `Échec de "claude plugin install ${PLUGIN_SPEC}" — le marketplace officiel est peut-être indisponible.`,
    };
  }

  if (hasTokenConfigured()) {
    log.ok('Un token Telegram est déjà configuré (~/.claude/channels/telegram/.env).');
    return { status: 'done', note: '' };
  }

  log.step('Configuration du bot Telegram');
  log.detail('1. Ouvrez une conversation avec @BotFather sur Telegram et envoyez /newbot.');
  log.detail('2. Choisissez un nom d\'affichage, puis un identifiant se terminant par "bot".');
  log.detail('3. BotFather répond avec un token du type 123456789:AAHfiqksKZ8... — copiez-le en entier.');
  log.detail('Ce token est transmis directement au plugin officiel (/telegram:configure) : il n\'est jamais écrit ailleurs par cet installeur.');

  const wantConfigure = await confirm('Configurer le bot Telegram maintenant ?', true);
  if (!wantConfigure) {
    return {
      status: 'partial',
      note: `Plugin installé, configuration reportée. Lancez "claude" puis /telegram:configure <token> (BotFather) dans une session interactive.`,
    };
  }

  const token = await secret('Token du bot (@BotFather)');
  if (!token) {
    return {
      status: 'partial',
      note: 'Aucun token saisi. Plugin installé ; configurez plus tard avec /telegram:configure <token>.',
    };
  }

  const spin = spinner('Transmission du token au plugin Telegram officiel (/telegram:configure)...');
  const result = runCapture('claude', ['-p', `/telegram:configure ${token}`], { timeout: CONFIGURE_TIMEOUT_MS });

  if (result.code === 0 && hasTokenConfigured()) {
    spin.succeed('Token transmis au plugin Telegram officiel.');
    log.info('Verrouillez l\'accès : dans une session "claude", lancez /telegram:access policy allowlist une fois votre propre identifiant appairé.');
    log.info(`Pour recevoir les messages : relancez avec "claude --channels plugin:${PLUGIN_SPEC}".`);
    return { status: 'done', note: '' };
  }

  spin.fail('Échec de la configuration automatique du plugin Telegram.');
  log.warn('Le token n\'a pas pu être transmis via "claude -p" (voir ci-dessous pour le faire vous-même).');
  if (result.stderr) log.detail(result.stderr.split('\n')[0]);

  // Fallback: keep the token for the user in the app's own .env — this is
  // NOT read by the telegram plugin, it is purely so the token is not lost.
  writeEnv({ TELEGRAM_BOT_TOKEN: token });
  return {
    status: 'partial',
    note: `Token sauvegardé dans le .env du projet (non lu par le plugin Telegram). Configurez-le vous-même : lancez "claude" puis /telegram:configure <token>.`,
  };
}

export async function check(ctx) {
  if (!commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }

  const plugins = listPlugins();
  const pluginInstalled = isTelegramInstalled(plugins);
  const tokenConfigured = hasTokenConfigured();

  if (pluginInstalled && tokenConfigured) return { status: 'done', note: '' };
  if (!pluginInstalled) return { status: 'failed', note: `Plugin "${PLUGIN_SPEC}" non installé.` };
  return { status: 'partial', note: 'Plugin installé, token Telegram non configuré.' };
}

/**
 * Étape Telegram unique.
 *
 * Deux bots Telegram, deux rôles volontairement séparés :
 *   1. l'Assistant Bot ouvre une vraie session Claude dans la racine PieceMaker ;
 *   2. le daemon de surveillance ne contient aucun assistant/LLM. Il observe et
 *      pilote la session avec des commandes déterministes (/status, /restart…).
 *
 * Écrit :
 *   ~/.claude/channels/telegram-piecemaker/       état de l'Assistant Bot
 *   ~/.claude/channels/telegram-piecemaker-lord/  état du daemon (chemin historique)
 *   ~/.piecemaker/orchestrator/projects.json      racine et nom du daemon
 *   ~/Library/LaunchAgents/com.piecemaker.telegram-monitor.plist (macOS)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { log, spinner } from '../lib/ui.mjs';
import { ask, confirm, secret, nonInteractive } from '../lib/prompt.mjs';
import {
  commandExists,
  ensureDir,
  HOME_DIR,
  IS_MAC,
  REPO_ROOT,
  run,
  runCapture,
} from '../lib/platform.mjs';

export const meta = {
  id: '08-telegram',
  label: 'Telegram — Assistant Bot et daemon',
  description: 'Configure le bot conversationnel PieceMaker et son daemon de surveillance séparé',
};

const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official';
const PLUGIN_SPEC = `telegram@${OFFICIAL_MARKETPLACE}`;

const CHANNEL_ROOT = path.join(os.homedir(), '.claude', 'channels');
const GENERIC_STATE_DIR = path.join(CHANNEL_ROOT, 'telegram');
const ASSISTANT_STATE_DIR = path.join(CHANNEL_ROOT, 'telegram-piecemaker');
// Conservé pour migrer sans casser les installations « Lord of the bots ».
const DAEMON_STATE_DIR = path.join(CHANNEL_ROOT, 'telegram-piecemaker-lord');

const ORCHESTRATOR_SRC = path.join(REPO_ROOT, 'orchestrator');
const ORCHESTRATOR_DIR = path.join(HOME_DIR, 'orchestrator');
const PROJECTS_FILE = path.join(ORCHESTRATOR_DIR, 'projects.json');
const ASSISTANT_LAUNCHER = path.join(ORCHESTRATOR_SRC, 'launch-telegram.sh');
const DAEMON_ENTRY = path.join(ORCHESTRATOR_SRC, 'piecemaker-daemon.mjs');

const DAEMON_LABEL = 'com.piecemaker.telegram-monitor';
const DAEMON_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${DAEMON_LABEL}.plist`);
const DAEMON_LOG = path.join(ORCHESTRATOR_DIR, 'telegram-monitor.log');
const DEFAULT_DAEMON_NAME = 'PieceMaker Monitor';

function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
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
  return Array.isArray(plugins) && plugins.some((plugin) => (
    plugin.id === PLUGIN_SPEC && plugin.enabled !== false
  ));
}

async function ensureOfficialPlugin() {
  const marketplaces = listMarketplaces();
  const marketplaceInstalled = Array.isArray(marketplaces)
    && marketplaces.some((marketplace) => marketplace.name === OFFICIAL_MARKETPLACE);

  if (!marketplaceInstalled) {
    const spin = spinner(`Enregistrement du marketplace officiel (${OFFICIAL_MARKETPLACE_REPO})...`);
    const code = await run('claude', ['plugin', 'marketplace', 'add', OFFICIAL_MARKETPLACE_REPO]);
    if (code !== 0) {
      spin.fail('Échec de l\'enregistrement du marketplace officiel.');
      return false;
    }
    spin.succeed('Marketplace officiel enregistré.');
  } else {
    log.ok(`Marketplace officiel « ${OFFICIAL_MARKETPLACE} » déjà enregistré.`);
  }

  const plugins = listPlugins();
  if (isTelegramInstalled(plugins)) {
    log.ok(`Plugin « ${PLUGIN_SPEC} » déjà installé et activé.`);
    return true;
  }

  const spin = spinner(`Installation du plugin officiel (${PLUGIN_SPEC})...`);
  const code = await run('claude', ['plugin', 'install', PLUGIN_SPEC]);
  if (code !== 0) {
    spin.fail('Échec de l\'installation du plugin Telegram.');
    return false;
  }
  spin.succeed('Plugin Telegram installé.');
  return true;
}

function readToken(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, '.env'), 'utf8')
      .match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]
      ?.trim() || '';
  } catch {
    return '';
  }
}

function writeToken(stateDir, token) {
  ensureDir(stateDir);
  const file = path.join(stateDir, '.env');
  fs.writeFileSync(file, `TELEGRAM_BOT_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Les ACL du profil utilisateur s'appliquent sur Windows.
  }
}

function readAccess(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAccess(stateDir, ids, { pairing = false } = {}) {
  ensureDir(stateDir);
  const existing = readAccess(stateDir);
  const access = {
    ...existing,
    dmPolicy: pairing && !ids.length ? 'pairing' : 'allowlist',
    allowFrom: ids,
    groups: existing.groups || {},
    pending: existing.pending || {},
  };
  fs.writeFileSync(
    path.join(stateDir, 'access.json'),
    `${JSON.stringify(access, null, 2)}\n`,
    'utf8',
  );
}

function configuredIds() {
  for (const stateDir of [ASSISTANT_STATE_DIR, DAEMON_STATE_DIR, GENERIC_STATE_DIR]) {
    const ids = readAccess(stateDir).allowFrom;
    if (Array.isArray(ids) && ids.length) return ids.map(String);
  }
  return [];
}

function readOrchestratorConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(parsed)) return { projects: parsed };
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Une configuration saine sera créée ci-dessous.
  }
  return { projects: [] };
}

function normalizeDaemonName(value) {
  return String(value || DEFAULT_DAEMON_NAME).replace(/[\r\n]+/g, ' ').trim().slice(0, 64)
    || DEFAULT_DAEMON_NAME;
}

function writeOrchestratorConfig(daemonName) {
  const config = readOrchestratorConfig();
  const projects = Array.isArray(config.projects) ? [...config.projects] : [];
  const index = projects.findIndex((project) => project?.name === 'piecemaker');
  const existing = index >= 0 ? projects[index] : {};
  const piecemaker = {
    ...existing,
    name: 'piecemaker',
    workdir: REPO_ROOT,
    aliases: [...new Set([...(existing.aliases || []), 'pm'])],
    permissionMode: existing.permissionMode || 'auto',
  };

  if (index >= 0) projects[index] = piecemaker;
  else projects.unshift(piecemaker);

  ensureDir(ORCHESTRATOR_DIR);
  fs.writeFileSync(
    PROJECTS_FILE,
    `${JSON.stringify({ ...config, daemonName, projects }, null, 2)}\n`,
    'utf8',
  );
  return projects;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function daemonPlist() {
  const values = [process.execPath, DAEMON_ENTRY].map((value) => (
    `      <string>${xml(value)}</string>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${DAEMON_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${values}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(REPO_ROOT)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(DAEMON_LOG)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(DAEMON_LOG)}</string>
  </dict>
</plist>
`;
}

function installDaemonService() {
  if (!IS_MAC || typeof process.getuid !== 'function') return false;

  ensureDir(path.dirname(DAEMON_PLIST));
  ensureDir(ORCHESTRATOR_DIR);
  fs.writeFileSync(DAEMON_PLIST, daemonPlist(), 'utf8');

  const domain = `gui/${process.getuid()}`;
  // bootout échoue normalement lors de la première installation.
  runCapture('launchctl', ['bootout', domain, DAEMON_PLIST]);
  const bootstrap = runCapture('launchctl', ['bootstrap', domain, DAEMON_PLIST]);
  if (bootstrap.code !== 0) {
    log.warn(`Le service n'a pas démarré : ${bootstrap.stderr || 'erreur launchctl'}`);
    return false;
  }
  const start = runCapture('launchctl', ['kickstart', '-k', `${domain}/${DAEMON_LABEL}`]);
  if (start.code !== 0) {
    log.warn(`Le daemon est installé mais n'a pas démarré : ${start.stderr || 'erreur launchctl'}`);
    return false;
  }
  return true;
}

function daemonServiceRunning() {
  if (!IS_MAC || typeof process.getuid !== 'function') return false;
  return runCapture('launchctl', ['print', `gui/${process.getuid()}/${DAEMON_LABEL}`]).code === 0;
}

async function configureToken({ title, purpose, stateDir, migrateFrom = null }) {
  log.step(title);
  log.detail(purpose);

  let token = readToken(stateDir);
  if (!token && migrateFrom) {
    const previous = readToken(migrateFrom);
    if (previous && await confirm('Réutiliser le bot Telegram déjà configuré ?', true)) {
      writeToken(stateDir, previous);
      token = previous;
      log.ok('Token existant réutilisé dans la configuration dédiée PieceMaker.');
    }
  }

  if (token) {
    log.ok('Token déjà configuré.');
    if (!nonInteractive && await confirm('Remplacer ce token ?', false)) {
      const replacement = await secret(`Nouveau token — ${title}`);
      if (replacement) {
        writeToken(stateDir, replacement);
        token = replacement;
      }
    }
    return token;
  }

  if (nonInteractive) return '';
  const value = await secret(`Token BotFather — ${title}`);
  if (value) {
    writeToken(stateDir, value);
    log.ok(`Token enregistré en 0600 dans ${stateDir}`);
  }
  return value;
}

async function launchAssistant() {
  if (!IS_MAC) {
    log.info('Démarrage manuel de l’Assistant Bot :');
    log.detail(`cd "${REPO_ROOT}" && TELEGRAM_STATE_DIR="${ASSISTANT_STATE_DIR}" claude --channels plugin:${PLUGIN_SPEC}`);
    return true;
  }

  if (!await confirm('Ouvrir maintenant la session de l’Assistant Bot à la racine de PieceMaker ?', true)) {
    log.info(`Lancement reporté : /bin/bash ${ASSISTANT_LAUNCHER} piecemaker`);
    return true;
  }

  const result = runCapture('/bin/bash', [ASSISTANT_LAUNCHER, 'piecemaker'], { timeout: 30000 });
  if (result.code === 0) {
    log.ok(result.stdout || `Assistant Bot ouvert dans ${REPO_ROOT}`);
    return true;
  }
  log.warn(result.stderr || result.stdout || 'Impossible d’ouvrir la session de l’Assistant Bot.');
  return false;
}

export async function install(ctx) {
  if (!commandExists('claude', ['--version'])) {
    return {
      status: 'skipped',
      note: 'CLI « claude » introuvable — installez Claude Code puis relancez cette étape.',
    };
  }
  if (!fs.existsSync(ORCHESTRATOR_SRC)) {
    return { status: 'failed', note: `Dossier orchestrator/ introuvable : ${ORCHESTRATOR_SRC}` };
  }

  if (ctx.dryRun) {
    log.info(`[simulation] Installation de ${PLUGIN_SPEC}`);
    log.info(`[simulation] Assistant Bot dans ${ASSISTANT_STATE_DIR}, session ouverte dans ${REPO_ROOT}`);
    log.info(`[simulation] Daemon de surveillance nommé et configuré dans ${DAEMON_STATE_DIR}`);
    if (IS_MAC) log.info(`[simulation] Service utilisateur ${DAEMON_PLIST}`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!await ensureOfficialPlugin()) {
    return {
      status: 'failed',
      note: `Impossible d'installer le plugin officiel « ${PLUGIN_SPEC} ».
Vérifiez la connexion réseau et le marketplace Claude Code.`,
    };
  }

  log.step('Deux bots Telegram distincts sont nécessaires');
  log.detail('Dans @BotFather, utilisez /newbot deux fois : un bot conversationnel et un bot de surveillance.');
  log.detail('Leurs tokens doivent être différents : le daemon ne dialogue jamais avec Claude et ne consomme aucun LLM.');

  const assistantToken = await configureToken({
    title: '1/2 — Assistant Bot conversationnel',
    purpose: `Sa session Claude est toujours ouverte à la racine de PieceMaker : ${REPO_ROOT}`,
    stateDir: ASSISTANT_STATE_DIR,
    migrateFrom: GENERIC_STATE_DIR,
  });

  const existingConfig = readOrchestratorConfig();
  const currentName = normalizeDaemonName(existingConfig.daemonName);
  const daemonName = nonInteractive
    ? currentName
    : normalizeDaemonName(await ask('Nom du daemon de surveillance', { def: currentName }));

  const daemonToken = await configureToken({
    title: `2/2 — ${daemonName}, daemon de surveillance`,
    purpose: 'Outil déterministe sans assistant : état, usage, lancement, arrêt et redémarrage de la session.',
    stateDir: DAEMON_STATE_DIR,
  });

  const previousIds = configuredIds();
  const idsRaw = nonInteractive
    ? previousIds.join(', ')
    : await ask('Identifiants Telegram autorisés pour les deux bots', { def: previousIds.join(', ') });
  const ids = [...new Set(idsRaw.split(',').map((id) => id.trim()).filter(Boolean))];

  if (assistantToken) writeAccess(ASSISTANT_STATE_DIR, ids, { pairing: true });
  if (daemonToken) writeAccess(DAEMON_STATE_DIR, ids);
  if (ids.length) log.ok(`Allowlist commune enregistrée : ${ids.join(', ')}`);
  else log.warn('Aucun identifiant autorisé : le daemon refusera tous les messages.');

  const projects = writeOrchestratorConfig(daemonName);
  log.ok(`Assistant « piecemaker » fixé à la racine : ${REPO_ROOT}`);

  const issues = [];
  if (!assistantToken) issues.push('token de l’Assistant Bot absent');
  if (!daemonToken) issues.push('token du daemon absent');
  if (assistantToken && daemonToken && assistantToken === daemonToken) {
    issues.push('les deux bots utilisent le même token');
    log.warn('Un token Telegram ne peut pas être interrogé simultanément par l’Assistant Bot et le daemon.');
  }
  if (!ids.length) issues.push('allowlist du daemon vide');

  let daemonStarted = false;
  if (daemonToken && ids.length && assistantToken !== daemonToken) {
    if (IS_MAC) {
      daemonStarted = installDaemonService();
      if (daemonStarted) log.ok(`Daemon « ${daemonName} » installé et démarré (sans LLM).`);
      else issues.push('service du daemon non démarré');
    } else {
      log.info(`Démarrage manuel du daemon : node ${DAEMON_ENTRY}`);
    }
  }

  let assistantStarted = true;
  if (assistantToken) assistantStarted = await launchAssistant();
  if (!assistantStarted) issues.push('session de l’Assistant Bot non ouverte');

  if (issues.length) return { status: 'partial', note: issues.join(' ; ') };
  return {
    status: 'done',
    note: `${projects.length} projet(s) ; Assistant Bot à la racine ; daemon « ${daemonName} »${daemonStarted ? ' actif' : ' configuré'}.`,
  };
}

export async function check() {
  if (!commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI « claude » introuvable.' };
  }

  const syntax = runCapture(process.execPath, ['--check', DAEMON_ENTRY]);
  if (syntax.code !== 0) {
    return { status: 'failed', note: `Le daemon ne compile pas : ${syntax.stderr.split('\n')[0]}` };
  }

  const pluginInstalled = isTelegramInstalled(listPlugins());
  const assistantToken = readToken(ASSISTANT_STATE_DIR);
  const daemonToken = readToken(DAEMON_STATE_DIR);
  const config = readOrchestratorConfig();
  const rootConfigured = Array.isArray(config.projects) && config.projects.some((project) => (
    project?.name === 'piecemaker'
      && typeof project.workdir === 'string'
      && path.resolve(project.workdir) === REPO_ROOT
  ));
  const ids = readAccess(DAEMON_STATE_DIR).allowFrom || [];
  const serviceReady = !IS_MAC || daemonServiceRunning();

  const missing = [];
  if (!pluginInstalled) missing.push('plugin Telegram absent');
  if (!assistantToken) missing.push('Assistant Bot non configuré');
  if (!daemonToken) missing.push('daemon non configuré');
  if (assistantToken && daemonToken && assistantToken === daemonToken) missing.push('tokens identiques');
  if (!rootConfigured) missing.push('racine PieceMaker non configurée');
  if (!ids.length) missing.push('allowlist du daemon vide');
  if (!serviceReady) missing.push('service du daemon arrêté');

  if (missing.length) return { status: 'partial', note: missing.join(' ; ') };
  return { status: 'done', note: `Assistant Bot + daemon « ${normalizeDaemonName(config.daemonName)} »` };
}

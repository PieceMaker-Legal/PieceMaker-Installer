/**
 * Installation, configuration des clients et cycle de vie du proxy LiteLLM.
 *
 * Le proxy reste une application LiteLLM standard. PieceMaker ne lui ajoute
 * que son mapping PII et configure les clients locaux pour passer par lui.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  HOME_DIR,
  IS_MAC,
  REPO_ROOT,
  ensureDir,
  findPython,
  run,
  runCapture,
  venvPaths,
} from './platform.mjs';
import { loadConfig } from './state.mjs';

export const LITELLM_LAUNCHD_LABEL = 'com.piecemaker.litellm';
export const CODEX_PROVIDER_ID = 'piecemaker_litellm';

const CODEX_BLOCK_START = '# >>> PieceMaker LiteLLM (géré automatiquement)';
const CODEX_BLOCK_END = '# <<< PieceMaker LiteLLM';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configuredPort(config = loadConfig()) {
  const port = Number(config.litellmPort) || 4000;
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`Port LiteLLM invalide : ${config.litellmPort}`);
  }
  return port;
}

export function litellmUrls(config = loadConfig()) {
  const origin = `http://127.0.0.1:${configuredPort(config)}`;
  return {
    origin,
    health: `${origin}/health/liveliness`,
    ui: `${origin}/ui`,
    claude: `${origin}/anthropic`,
    // Codex connecté avec ChatGPT doit conserver son backend d’abonnement.
    // Le pass-through LiteLLM correspondant relaie son jeton OAuth sans le lire.
    codex: `${origin}/chatgpt`,
  };
}

export function litellmPaths({
  config = loadConfig(),
  homeDir = HOME_DIR,
  repoRoot = REPO_ROOT,
  userHome = os.homedir(),
} = {}) {
  const venvDir = config.litellmVenvPath || path.join(homeDir, 'litellm-venv');
  const proxyDir = path.join(repoRoot, 'litellm-proxy');
  return {
    proxyDir,
    entry: path.join(proxyDir, 'start_proxy.py'),
    requirements: path.join(proxyDir, 'requirements.txt'),
    config: path.join(proxyDir, 'litellm_config.yaml'),
    mapping: path.join(homeDir, 'central-mapping.json'),
    venvDir,
    python: venvPaths(venvDir).python,
    pid: path.join(homeDir, 'litellm.pid'),
    log: path.join(homeDir, 'litellm.log'),
    launchAgent: path.join(userHome, 'Library', 'LaunchAgents', `${LITELLM_LAUNCHD_LABEL}.plist`),
  };
}

function dependencyProbeCode() {
  return [
    'from importlib.metadata import version',
    "parts = [int(value) for value in version('litellm').split('.')[:2]]",
    'assert parts >= [1, 98]',
    'import fastapi, uvicorn',
  ].join('; ');
}

export function litellmDependenciesStatus(options = {}) {
  const capture = options.runCapture || runCapture;
  const paths = litellmPaths(options);
  if (!fs.existsSync(paths.python)) {
    return { installed: false, python: paths.python, version: '', reason: 'venv-absent' };
  }
  const result = capture(paths.python, ['-c', dependencyProbeCode()]);
  if (result.code !== 0 || result.error) {
    return { installed: false, python: paths.python, version: '', reason: 'dependencies-invalid' };
  }
  const version = capture(paths.python, ['-c', "from importlib.metadata import version; print(version('litellm'))"]);
  return {
    installed: version.code === 0 && !version.error,
    python: paths.python,
    version: version.stdout || '',
    reason: version.code === 0 && !version.error ? '' : 'version-unreadable',
  };
}

export async function installLitellmDependencies(options = {}) {
  const capture = options.runCapture || runCapture;
  const execute = options.runCommand || run;
  const paths = litellmPaths(options);
  const current = litellmDependenciesStatus({ ...options, runCapture: capture });
  if (current.installed) return { ...current, changed: false };

  ensureDir(path.dirname(paths.venvDir));
  if (!fs.existsSync(paths.python)) {
    const interpreter = options.python || findPython();
    if (!interpreter?.command) {
      throw new Error('Python 3.10 ou supérieur est requis pour installer LiteLLM.');
    }
    const created = capture(interpreter.command, ['-m', 'venv', paths.venvDir]);
    if (created.code !== 0 || created.error) {
      throw new Error(`Création du venv LiteLLM impossible : ${created.stderr || created.stdout || created.error?.message}`);
    }
  }

  let lastLine = '';
  let installCode;
  try {
    installCode = await execute(paths.python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '-r', paths.requirements,
    ], {
      onLine: (line) => {
        lastLine = String(line).trim();
        options.onLine?.(lastLine);
      },
    });
  } catch (error) {
    throw new Error(`Installation de LiteLLM impossible : ${error.message}`);
  }
  if (installCode !== 0) {
    throw new Error(`Installation de LiteLLM impossible${lastLine ? ` : ${lastLine}` : ` (code ${installCode})`}`);
  }

  const status = litellmDependenciesStatus({ ...options, runCapture: capture });
  if (!status.installed) throw new Error('LiteLLM a été installé, mais son import de contrôle échoue.');
  return { ...status, changed: true };
}

function atomicWrite(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.piecemaker-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', mode });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, mode); } catch { /* Windows ignore les modes POSIX. */ }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Déjà renommé ou absent. */ }
  }
}

function isPieceMakerLoopbackUrl(value, suffix) {
  try {
    const url = new URL(String(value || ''));
    return ['127.0.0.1', 'localhost'].includes(url.hostname)
      && url.pathname.replace(/\/$/, '') === suffix;
  } catch {
    return false;
  }
}

export function configureClaudeCodeProxy({
  baseUrl,
  userHome = os.homedir(),
} = {}) {
  const settingsFile = path.join(userHome, '.claude', 'settings.json');
  let settings = {};
  try {
    if (fs.existsSync(settingsFile)) {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('objet JSON attendu');
      settings = parsed;
    }
  } catch {
    return { configured: false, changed: false, conflict: true, file: settingsFile, reason: 'settings-invalid' };
  }

  const target = baseUrl || litellmUrls().claude;
  if (settings.env !== undefined
    && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
    return { configured: false, changed: false, conflict: true, file: settingsFile, reason: 'env-invalid' };
  }
  if (!settings.env) settings.env = {};
  const existing = settings.env.ANTHROPIC_BASE_URL;
  if (existing && existing !== target && !isPieceMakerLoopbackUrl(existing, '/anthropic')) {
    return { configured: false, changed: false, conflict: true, file: settingsFile, reason: 'base-url-conflict' };
  }
  if (existing === target) return { configured: true, changed: false, conflict: false, file: settingsFile };

  settings.env.ANTHROPIC_BASE_URL = target;
  atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return { configured: true, changed: true, conflict: false, file: settingsFile };
}

export function bypassClaudeCodeProxy({ userHome = os.homedir() } = {}) {
  const settingsFile = path.join(userHome, '.claude', 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    return { bypassed: true, changed: false, conflict: false, file: settingsFile };
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('objet JSON attendu');
  } catch {
    return { bypassed: false, changed: false, conflict: true, file: settingsFile, reason: 'settings-invalid' };
  }

  const env = settings.env;
  if (env === undefined || (env && typeof env === 'object' && !Array.isArray(env)
      && !env.ANTHROPIC_BASE_URL)) {
    return { bypassed: true, changed: false, conflict: false, file: settingsFile };
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { bypassed: false, changed: false, conflict: true, file: settingsFile, reason: 'env-invalid' };
  }
  if (!isPieceMakerLoopbackUrl(env.ANTHROPIC_BASE_URL, '/anthropic')) {
    return { bypassed: true, changed: false, conflict: false, file: settingsFile };
  }

  delete env.ANTHROPIC_BASE_URL;
  if (Object.keys(env).length === 0) delete settings.env;
  atomicWrite(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return { bypassed: true, changed: true, conflict: false, file: settingsFile };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function topLevelAssignment(lines, key) {
  const expression = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=\\s*(.*?)\\s*$`);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) break;
    const match = line.match(expression);
    if (match) return { index, raw: match[1] };
  }
  return null;
}

function parseTomlString(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('"')) {
    const literal = value.match(/^("(?:\\.|[^"\\])*")/)?.[1];
    try { return literal ? JSON.parse(literal) : null; } catch { return null; }
  }
  const literal = value.match(/^'([^']*)'/)?.[1];
  if (literal !== undefined) return literal;
  return null;
}

export function configureCodexProxy({
  baseUrl,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  const configFile = path.join(codexHome, 'config.toml');
  let content = '';
  try { content = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''; } catch {
    return { configured: false, changed: false, conflict: true, file: configFile, reason: 'config-unreadable' };
  }

  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const provider = topLevelAssignment(lines, 'model_provider');
  const providerValue = provider ? parseTomlString(provider.raw) : 'openai';
  if (provider && !['openai', CODEX_PROVIDER_ID].includes(providerValue)) {
    return { configured: false, changed: false, conflict: true, file: configFile, reason: 'provider-conflict' };
  }

  const target = baseUrl || litellmUrls().codex;
  const managedTable = lines.findIndex((line) => line.trim() === `[model_providers.${CODEX_PROVIDER_ID}]`);
  const managedStart = lines.findIndex((line) => line.trim() === CODEX_BLOCK_START);
  const managedEnd = lines.findIndex((line) => line.trim() === CODEX_BLOCK_END);
  if (managedTable >= 0 && (managedStart < 0 || managedEnd < managedTable)) {
    return { configured: false, changed: false, conflict: true, file: configFile, reason: 'provider-table-conflict' };
  }

  if (provider) {
    lines[provider.index] = `model_provider = ${tomlString(CODEX_PROVIDER_ID)} # géré par PieceMaker`;
  } else {
    const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    lines.splice(firstTable < 0 ? 0 : firstTable, 0,
      '# Fournisseur Responses protégé par PieceMaker.',
      `model_provider = ${tomlString(CODEX_PROVIDER_ID)} # géré par PieceMaker`,
      '');
  }

  const block = [
    CODEX_BLOCK_START,
    `[model_providers.${CODEX_PROVIDER_ID}]`,
    'name = "PieceMaker · LiteLLM"',
    `base_url = ${tomlString(target)}`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    // LiteLLM relaie Responses WebSocket ; PieceMaker se limite à coder et
    // ré-identifier les trames dans son middleware PII.
    'supports_websockets = true',
    CODEX_BLOCK_END,
  ];
  if (managedStart >= 0 && managedEnd >= managedStart) {
    lines.splice(managedStart, managedEnd - managedStart + 1, ...block);
  } else {
    while (lines.at(-1) === '') lines.pop();
    lines.push('', ...block);
  }
  const normalized = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  if (normalized === `${content.replace(/^﻿/, '').replace(/\n*$/, '')}\n`) {
    return { configured: true, changed: false, conflict: false, file: configFile };
  }
  atomicWrite(configFile, normalized);
  return { configured: true, changed: true, conflict: false, file: configFile };
}

export function bypassCodexProxy({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
} = {}) {
  const configFile = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configFile)) {
    return { bypassed: true, changed: false, conflict: false, file: configFile };
  }

  let content;
  try { content = fs.readFileSync(configFile, 'utf8'); } catch {
    return { bypassed: false, changed: false, conflict: true, file: configFile, reason: 'config-unreadable' };
  }

  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  const provider = topLevelAssignment(lines, 'model_provider');
  const providerValue = provider ? parseTomlString(provider.raw) : 'openai';
  const managedStart = lines.findIndex((line) => line.trim() === CODEX_BLOCK_START);
  const managedEnd = lines.findIndex((line) => line.trim() === CODEX_BLOCK_END);
  if ((managedStart < 0) !== (managedEnd < 0) || managedEnd < managedStart) {
    return { bypassed: false, changed: false, conflict: true, file: configFile, reason: 'provider-block-invalid' };
  }
  if (providerValue !== CODEX_PROVIDER_ID && managedStart < 0) {
    return { bypassed: true, changed: false, conflict: false, file: configFile };
  }
  if (managedStart >= 0) lines.splice(managedStart, managedEnd - managedStart + 1);

  if (providerValue === CODEX_PROVIDER_ID) {
    lines[provider.index] = 'model_provider = "openai"';
    if (lines[provider.index - 1]?.trim() === '# Fournisseur Responses protégé par PieceMaker.') {
      lines.splice(provider.index - 1, 1);
    }
  }

  const normalized = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  if (normalized === `${content.replace(/^﻿/, '').replace(/\n*$/, '')}\n`) {
    return { bypassed: true, changed: false, conflict: false, file: configFile };
  }
  atomicWrite(configFile, normalized);
  return { bypassed: true, changed: true, conflict: false, file: configFile };
}

export function bypassLlmClients({ userHome = os.homedir() } = {}) {
  return {
    claude: bypassClaudeCodeProxy({ userHome }),
    codex: bypassCodexProxy({
      codexHome: process.env.CODEX_HOME || path.join(userHome, '.codex'),
    }),
  };
}

export function configureLlmClients({ config = loadConfig(), userHome = os.homedir() } = {}) {
  const urls = litellmUrls(config);
  return {
    claude: configureClaudeCodeProxy({ baseUrl: urls.claude, userHome }),
    codex: configureCodexProxy({
      baseUrl: urls.codex,
      codexHome: process.env.CODEX_HOME || path.join(userHome, '.codex'),
    }),
  };
}

export function llmClientProxyStatus({ config = loadConfig(), userHome = os.homedir() } = {}) {
  const urls = litellmUrls(config);
  const claudeFile = path.join(userHome, '.claude', 'settings.json');
  const codexHome = process.env.CODEX_HOME || path.join(userHome, '.codex');
  const codexFile = path.join(codexHome, 'config.toml');
  let claude = false;
  let codex = false;
  try {
    const settings = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    claude = settings?.env?.ANTHROPIC_BASE_URL === urls.claude;
  } catch { /* absent ou illisible */ }
  try {
    const lines = fs.readFileSync(codexFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
    const provider = parseTomlString(topLevelAssignment(lines, 'model_provider')?.raw);
    const start = lines.findIndex((line) => line.trim() === CODEX_BLOCK_START);
    const end = lines.findIndex((line) => line.trim() === CODEX_BLOCK_END);
    const managed = start >= 0 && end > start ? lines.slice(start, end + 1).join('\n') : '';
    codex = provider === CODEX_PROVIDER_ID
      && managed.includes(`base_url = ${tomlString(urls.codex)}`)
      && managed.includes('supports_websockets = true')
      && managed.includes('requires_openai_auth = true');
  } catch { /* absent ou illisible */ }
  return { claude, codex, claudeFile, codexFile };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function litellmLaunchAgentPlist(options = {}) {
  const paths = litellmPaths(options);
  const urls = litellmUrls(options.config || loadConfig());
  const variables = {
    HOME: options.userHome || os.homedir(),
    LITELLM_CONFIG_PATH: paths.config,
    PIECEMAKER_MAPPING_PATH: paths.mapping,
    PROXY_HOST: '127.0.0.1',
    PROXY_PORT: new URL(urls.origin).port,
    PYTHONUNBUFFERED: '1',
  };
  const environment = Object.entries(variables)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LITELLM_LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xmlEscape(paths.python)}</string>
      <string>${xmlEscape(paths.entry)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(paths.proxyDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(paths.log)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(paths.log)}</string>
  </dict>
</plist>
`;
}

function launchdDomain() {
  return typeof process.getuid === 'function' ? `gui/${process.getuid()}` : null;
}

function launchAgentState(capture = runCapture) {
  if (!IS_MAC) return { supported: false, loaded: false, pid: null };
  const domain = launchdDomain();
  if (!domain) return { supported: false, loaded: false, pid: null };
  const result = capture('launchctl', ['print', `${domain}/${LITELLM_LAUNCHD_LABEL}`]);
  const pid = Number.parseInt(result.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1] || '', 10);
  return {
    supported: true,
    loaded: result.code === 0 && !result.error,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    domain,
  };
}

export function installLitellmLaunchAgent(options = {}) {
  if (!IS_MAC) return { installed: false, supported: false, reason: 'unsupported' };
  const capture = options.runCapture || runCapture;
  const paths = litellmPaths(options);
  const state = launchAgentState(capture);
  if (state.loaded) capture('launchctl', ['bootout', `${state.domain}/${LITELLM_LAUNCHD_LABEL}`]);
  atomicWrite(paths.launchAgent, litellmLaunchAgentPlist(options), 0o644);
  const result = capture('launchctl', ['bootstrap', state.domain, paths.launchAgent]);
  if (result.code !== 0 || result.error) {
    throw new Error(`Démarrage automatique LiteLLM impossible : ${result.stderr || result.stdout || result.error?.message}`);
  }
  return { installed: true, supported: true, changed: true, file: paths.launchAgent };
}

function readPid(file) {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function processRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export function probeLitellm(config = loadConfig(), timeoutMs = 1200) {
  const url = new URL(litellmUrls(config).health);
  return new Promise((resolve) => {
    const request = http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function getLitellmStatus(options = {}) {
  const config = options.config || loadConfig();
  const userHome = options.userHome || os.homedir();
  const paths = litellmPaths({ ...options, config });
  const dependencies = litellmDependenciesStatus({ ...options, config });
  const launchd = launchAgentState(options.runCapture || runCapture);
  const directPid = readPid(paths.pid);
  const directRunning = processRunning(directPid);
  if (directPid && !directRunning) {
    try { fs.unlinkSync(paths.pid); } catch { /* déjà absent */ }
  }
  return {
    installed: dependencies.installed,
    version: dependencies.version,
    running: await probeLitellm(config, options.timeoutMs),
    pid: launchd.pid || (directRunning ? directPid : null),
    managed: launchd.loaded || directRunning,
    autoStart: fs.existsSync(paths.launchAgent),
    routing: llmClientProxyStatus({ config, userHome }),
    logFile: paths.log,
    ...litellmUrls(config),
  };
}

function directEnvironment(config, paths) {
  return {
    ...process.env,
    LITELLM_CONFIG_PATH: paths.config,
    PIECEMAKER_MAPPING_PATH: paths.mapping,
    PROXY_HOST: '127.0.0.1',
    PROXY_PORT: String(configuredPort(config)),
    PYTHONUNBUFFERED: '1',
  };
}

// Le démarrage de LiteLLM est lent et très variable : import du paquet
// (~5 s à chaud, bien plus après une mise à jour qui vide le cache disque)
// puis préparation de l'UI empaquetée. Un budget de 20 s expirait alors que
// le proxy devenait sain quelques secondes plus tard — la mise à jour
// rétablissait alors l'accès direct, sans anonymisation, sur un proxy en
// réalité fonctionnel. On attend donc largement, en sortant tôt dès que le
// processus attendu meurt (échec réel, pas démarrage lent).
const LITELLM_START_TIMEOUT_MS = 120_000;

async function waitForProxy(config, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeLitellm(config)) return true;
    if (expected && !processRunning(expected)) return false;
    await delay(250);
  }
  return false;
}

export async function startLitellmProxy(options = {}) {
  const config = options.config || loadConfig();
  const current = await getLitellmStatus({ ...options, config });
  if (current.running) return { ...current, started: false };
  if (!current.installed) throw new Error("LiteLLM n’est pas installé. Relancez le composant 16 — Proxy PII LiteLLM.");

  // Le processus tourne mais le health check a échoué (timeout réseau,
  // démarrage en cours…) — on attend au lieu de tuer et relancer.
  if (current.pid) {
    if (await waitForProxy(config, current.pid, options.timeoutMs || LITELLM_START_TIMEOUT_MS)) {
      return { ...await getLitellmStatus({ ...options, config }), started: false };
    }
    throw new Error(`LiteLLM tourne (PID ${current.pid}) mais ne répond pas au health check. Consultez ${litellmPaths({ ...options, config }).log}.`);
  }

  const capture = options.runCapture || runCapture;
  const paths = litellmPaths({ ...options, config });
  const launchd = launchAgentState(capture);
  let expectedPid = null;
  if (IS_MAC && fs.existsSync(paths.launchAgent) && launchd.domain) {
    const result = launchd.loaded
      ? capture('launchctl', ['kickstart', '-k', `${launchd.domain}/${LITELLM_LAUNCHD_LABEL}`])
      : capture('launchctl', ['bootstrap', launchd.domain, paths.launchAgent]);
    if (result.code !== 0 || result.error) {
      throw new Error(`Démarrage LiteLLM impossible : ${result.stderr || result.stdout || result.error?.message}`);
    }
  } else {
    ensureDir(path.dirname(paths.log));
    fs.appendFileSync(paths.log, `\n[${new Date().toISOString()}] Démarrage de LiteLLM\n`, 'utf8');
    const logFd = fs.openSync(paths.log, 'a');
    let child;
    try {
      child = spawn(paths.python, [paths.entry], {
        cwd: paths.proxyDir,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: directEnvironment(config, paths),
      });
    } finally {
      fs.closeSync(logFd);
    }
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    }).catch((error) => {
      throw new Error(`Lancement du processus LiteLLM impossible : ${error.message}`);
    });
    child.unref();
    expectedPid = child.pid;
    fs.writeFileSync(paths.pid, `${child.pid}\n`, 'utf8');
  }

  if (!await waitForProxy(config, expectedPid, options.timeoutMs || LITELLM_START_TIMEOUT_MS)) {
    throw new Error(`LiteLLM n’a pas démarré. Consultez ${paths.log}.`);
  }
  return { ...await getLitellmStatus({ ...options, config }), started: true };
}

export async function stopLitellmProxy(options = {}) {
  const config = options.config || loadConfig();
  const capture = options.runCapture || runCapture;
  const paths = litellmPaths({ ...options, config });
  const launchd = launchAgentState(capture);
  const directPid = readPid(paths.pid);
  const alreadyStopped = !launchd.loaded && !processRunning(directPid);
  if (launchd.loaded) {
    const result = capture('launchctl', ['bootout', `${launchd.domain}/${LITELLM_LAUNCHD_LABEL}`]);
    if (result.code !== 0 || result.error) {
      throw new Error(`Arrêt LiteLLM impossible : ${result.stderr || result.stdout || result.error?.message}`);
    }
  } else {
    if (directPid && processRunning(directPid)) process.kill(directPid, 'SIGTERM');
  }

  const deadline = Date.now() + (options.timeoutMs || 8_000);
  while (Date.now() < deadline && await probeLitellm(config, 400)) await delay(200);
  const running = await probeLitellm(config, 400);
  if (running) throw new Error("LiteLLM répond toujours après la demande d’arrêt.");
  try { fs.unlinkSync(paths.pid); } catch { /* absent */ }
  return { ...await getLitellmStatus({ ...options, config }), stopped: true, alreadyStopped };
}

export function readLitellmLogs(lines = 80, options = {}) {
  try {
    const content = fs.readFileSync(litellmPaths(options).log, 'utf8').trimEnd();
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch { return ''; }
}

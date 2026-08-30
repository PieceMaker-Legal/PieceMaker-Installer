const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isProtectedFile, readProtection } = require('../piecemaker-plugin/scripts/lib/protection.cjs');
const { listConfiguredCases, readRegistryConfig } = require('./case-registry.cjs');

const ASSISTANT_DIR = 'telegram-piecemaker';
const MONITOR_DIR = 'telegram-piecemaker-lord';
const LEGACY_MONITOR_DIR = 'telegram-lord';
const MONITOR_LABEL = 'com.piecemaker.telegram-monitor';
const DEFAULT_ASSISTANT_NAME = 'Assistant PieceMaker';
const DEFAULT_MONITOR_NAME = 'PieceMaker Monitor';
const RESERVED_DOSSIER_DIRS = new Set([
  'models', 'ressources', '_python_uploads', 'node_modules', 'admin', 'build',
  'certificates', 'docs', 'electron', 'installer', 'orchestrator',
  'output', 'piecemaker-plugin', 'test', 'websocket-server',
]);
// Arborescences techniques : un dossier juridique finit par en héberger.
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv']);
const MAX_PROTECTED_NAMES = 100;

function readJson(file, fallback = {}) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, content, mode = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  fs.renameSync(temporary, file);
  if (mode) {
    try { fs.chmodSync(file, mode); } catch { /* Windows applique ses ACL. */ }
  }
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

function tokenState(token) {
  if (!token) return { configured: false, hint: '' };
  return { configured: true, hint: token.length > 4 ? `••••${token.slice(-4)}` : 'configuré' };
}

function validateToken(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  if (token.length > 256 || /\s/.test(token) || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new Error('Le token Telegram doit être un token BotFather valide, au format nombre:secret.');
  }
  return token;
}

function writeToken(stateDir, token) {
  const file = path.join(stateDir, '.env');
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  let replaced = false;
  const lines = original
    .filter((line, index, values) => line || index < values.length - 1)
    .map((line) => {
      if (/^\s*TELEGRAM_BOT_TOKEN=/.test(line)) {
        replaced = true;
        return `TELEGRAM_BOT_TOKEN=${token}`;
      }
      return line;
    });
  if (!replaced) lines.push(`TELEGRAM_BOT_TOKEN=${token}`);
  while (lines.at(-1) === '') lines.pop();
  atomicWrite(file, `${lines.join('\n')}\n`, 0o600);
}

function cleanName(value, fallback) {
  const name = String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!name) return fallback;
  if (name.length > 64) throw new Error('Le nom Telegram est limité à 64 caractères.');
  return name;
}

function projectId(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'dossier';
  return slug === 'piecemaker' ? 'dossier-piecemaker' : slug;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 10_000,
    cwd: options.cwd,
    env: options.env || process.env,
    windowsHide: true,
  });
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function psValue(pid, field) {
  if (process.platform === 'win32') return '';
  const executable = process.platform === 'darwin' ? '/bin/ps' : 'ps';
  const result = run(executable, ['-p', String(pid), '-o', `${field}=`]);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function readBotProcess(stateDir) {
  const pidFile = path.join(stateDir, 'bot.pid');
  let pid = 0;
  try { pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch { return null; }
  if (!processExists(pid)) return null;

  // Sur macOS/Linux, refuse un PID recyclé ou un processus qui n'est pas le poller Telegram.
  if (process.platform !== 'win32') {
    const command = psValue(pid, 'command');
    const born = Date.parse(psValue(pid, 'lstart'));
    let pidFileTime = 0;
    try { pidFileTime = fs.statSync(pidFile).mtimeMs; } catch { return null; }
    if (!/\bbun\b.*\bserver\.ts\b/.test(command)) return null;
    if (!Number.isFinite(born) || born > pidFileTime + 2000) return null;
  }
  return { pid, command: psValue(pid, 'command') };
}

function findClaudeParent(botPid) {
  let pid = botPid;
  for (let depth = 0; depth < 10 && pid > 1; depth++) {
    const parent = Number.parseInt(psValue(pid, 'ppid'), 10);
    if (!Number.isInteger(parent) || parent <= 1) return null;
    const command = psValue(parent, 'command');
    if (/\bclaude\b.*--channels\b.*telegram/.test(command)) return parent;
    pid = parent;
  }
  return null;
}

function monitorStatus(userHome) {
  const plist = path.join(userHome, 'Library', 'LaunchAgents', `${MONITOR_LABEL}.plist`);
  const installed = fs.existsSync(plist);
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return { installed, loaded: false, running: false, pid: null, autoStart: installed, plist };
  }
  const service = `gui/${process.getuid()}/${MONITOR_LABEL}`;
  const result = run('/bin/launchctl', ['print', service]);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const pid = Number.parseInt(output.match(/\bpid\s*=\s*(\d+)/)?.[1] || '', 10) || null;
  return { installed, loaded: result.status === 0, running: result.status === 0 && Boolean(pid), pid, autoStart: installed, plist };
}

function configuredDossiersRoot(repoRoot, homeDir) {
  const config = readJson(path.join(homeDir, 'config.json'), {});
  const candidate = config.dossiersRoot || config.outputPath || repoRoot;
  return path.resolve(String(candidate));
}

function countMarkdownFiles(root, { maxDepth = 6, maxFiles = 5000 } = {}) {
  let count = 0;
  function visit(directory, depth) {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIPPED_DIR_NAMES.has(entry.name.toLowerCase())) {
          visit(path.join(directory, entry.name), depth + 1);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        count += 1;
      }
    }
  }
  visit(root, 0);
  return count;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mappingPairs(mappingFile) {
  const document = readJson(mappingFile, null);
  if (!document || typeof document !== 'object') return [];
  const source = document.mapping || document.mappings || document.anonymizationMapping || document;
  if (!source || typeof source !== 'object') return [];
  const pairs = [];
  const ignoredKeys = new Set(['reverse_mapping', 'reverseMapping', 'extracted_data', 'extractedData']);

  function add(original, replacement) {
    const from = String(original || '').trim();
    const to = String(replacement || '').trim();
    if (from && to && from !== to) pairs.push([from, to]);
  }

  function visit(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (typeof node.code === 'string') {
      add(node.original, node.code);
      add(node.variant, node.code);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (ignoredKeys.has(key)) continue;
      if (typeof value === 'string') add(key, value);
      else visit(value);
    }
  }

  visit(source);
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function filteredOriginalName(filename, pairs, index) {
  const extension = path.extname(filename).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12);
  let filtered = filename;
  let replacements = 0;
  for (const [original, code] of pairs) {
    const fragments = original.split(/[\s._-]+/).filter(Boolean).map(escapeRegExp);
    if (!fragments.length) continue;
    const pattern = new RegExp(fragments.join('[\\s._-]+'), 'giu');
    const before = filtered;
    filtered = filtered.replace(pattern, code.replace(/[\\/\x00-\x1f\x7f]/g, '-'));
    if (filtered !== before) replacements += 1;
  }
  if (!replacements) return `Pièce originale ${index + 1}${extension}`;
  return filtered.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\/]/g, '-').slice(0, 180);
}

/**
 * Pièces protégées d'un dossier, récursivement. La protection ne dépend plus
 * d'un sous-dossier « Pièces originales » mais du fichier lui-même
 * (`piecemaker-plugin/scripts/lib/protection.cjs`) : un dossier rangé à plat,
 * qui est le cas courant, était auparavant compté comme n'ayant aucune pièce
 * isolée.
 */
function collectProtectedFiles(root, { maxDepth = 6, maxFiles = 5000 } = {}) {
  const protection = readProtection(root);
  const files = [];
  function visit(directory, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIR_NAMES.has(entry.name.toLowerCase())) visit(absolute, depth + 1);
      } else if (entry.isFile() && isProtectedFile(absolute, root, protection)) {
        files.push(entry.name);
      }
    }
  }
  visit(root, 0);
  return files.sort((a, b) => a.localeCompare(b, 'fr'));
}

function inspectDossier(directory) {
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { /* état vide */ }
  const mappingFiles = entries
    .filter((entry) => entry.isFile() && /^mapping.*\.json$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  const pairs = mappingFiles.flatMap(mappingPairs);
  const protectedFiles = collectProtectedFiles(directory);
  // Les noms de fichiers eux-mêmes portent des entités : ils ne sont exposés
  // qu'une fois passés par le mapping, jamais bruts.
  const mappedOriginalNames = mappingFiles.length
    ? protectedFiles.slice(0, MAX_PROTECTED_NAMES).map((name, index) => filteredOriginalName(name, pairs, index))
    : [];
  return {
    mappingConfigured: mappingFiles.length > 0,
    originalsProtected: protectedFiles.length > 0,
    originalFiles: protectedFiles.length,
    mappedOriginalNames,
    originalNamesTruncated: mappedOriginalNames.length < protectedFiles.length && mappingFiles.length > 0,
    markdownFiles: countMarkdownFiles(directory),
  };
}

function pathsFor({ repoRoot, userHome, homeDir }) {
  const channelRoot = path.join(userHome, '.claude', 'channels');
  const orchestratorDir = path.join(homeDir, 'orchestrator');
  return {
    channelRoot,
    genericState: path.join(channelRoot, 'telegram'),
    assistantState: path.join(channelRoot, ASSISTANT_DIR),
    monitorState: path.join(channelRoot, MONITOR_DIR),
    legacyMonitorState: path.join(channelRoot, LEGACY_MONITOR_DIR),
    projectsFile: path.join(orchestratorDir, 'projects.json'),
    launcher: path.join(repoRoot, 'orchestrator', 'launch-telegram.sh'),
    dossiersRoot: configuredDossiersRoot(repoRoot, homeDir),
    dossierEntries: listConfiguredCases(readRegistryConfig(path.join(homeDir, 'config.json'))),
  };
}

function readMonitorToken(paths) {
  return readToken(paths.monitorState) || readToken(paths.legacyMonitorState);
}

function dossierDirectories(paths, config) {
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const usedIds = new Set(['piecemaker']);
  return paths.dossierEntries
    .filter((entry) => !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .filter((entry) => !RESERVED_DOSSIER_DIRS.has(entry.name.toLowerCase()))
    .map((entry) => {
      const workdir = entry.root;
      const configured = projects.find((project) => {
        try { return project?.name !== 'piecemaker' && path.resolve(project.workdir) === path.resolve(workdir); }
        catch { return false; }
      });
      const configuredId = /^[a-z0-9][a-z0-9-]{0,63}$/.test(configured?.name || '')
        ? configured.name
        : '';
      let id = configuredId || projectId(entry.name);
      if (usedIds.has(id)) {
        const suffix = crypto.createHash('sha256').update(workdir).digest('hex').slice(0, 6);
        id = `${id.slice(0, 41)}-${suffix}`;
      }
      usedIds.add(id);
      const stateDir = path.join(paths.channelRoot, `telegram-${id}`);
      const processInfo = readBotProcess(stateDir);
      return {
        id,
        directoryName: entry.name,
        workdir,
        name: cleanName(configured?.displayName, entry.name),
        linked: Boolean(configured && readToken(stateDir)),
        projectConfigured: Boolean(configured),
        token: tokenState(readToken(stateDir)),
        running: Boolean(processInfo),
        pid: processInfo?.pid || null,
        ...inspectDossier(workdir),
      };
    });
}

function readNames(projectsFile) {
  const config = readJson(projectsFile, { projects: [] });
  const project = Array.isArray(config.projects)
    ? config.projects.find((entry) => entry?.name === 'piecemaker')
    : null;
  return {
    config,
    assistantName: cleanName(config.assistantName || project?.displayName, DEFAULT_ASSISTANT_NAME),
    monitorName: cleanName(config.daemonName, DEFAULT_MONITOR_NAME),
  };
}

function assertTokenUnique(channelRoot, token, excludedStateDirs = []) {
  if (!token || !fs.existsSync(channelRoot)) return;
  const excluded = new Set(excludedStateDirs.map((entry) => path.resolve(entry)));
  for (const entry of fs.readdirSync(channelRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('telegram')) continue;
    const stateDir = path.join(channelRoot, entry.name);
    if (!excluded.has(path.resolve(stateDir)) && readToken(stateDir) === token) {
      throw new Error(`Ce token est déjà utilisé par la configuration « ${entry.name} ». Chaque bot doit avoir son propre token.`);
    }
  }
}

function copyGeneralAccess(paths, targetState) {
  const target = path.join(targetState, 'access.json');
  if (fs.existsSync(target)) return;
  const source = path.join(paths.assistantState, 'access.json');
  if (!fs.existsSync(source)) return;
  atomicWrite(target, fs.readFileSync(source, 'utf8'), 0o600);
}

function getTelegramState(options) {
  const { repoRoot, userHome = os.homedir(), homeDir = path.join(userHome, '.piecemaker') } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir });
  const names = readNames(paths.projectsFile);
  const assistantProcess = readBotProcess(paths.assistantState);
  const monitor = monitorStatus(userHome);
  return {
    dossiersRoot: paths.dossiersRoot,
    assistant: {
      name: names.assistantName,
      token: tokenState(readToken(paths.assistantState)),
      running: Boolean(assistantProcess),
      pid: assistantProcess?.pid || null,
      autoStart: false,
    },
    monitor: {
      name: names.monitorName,
      token: tokenState(readMonitorToken(paths)),
      ...monitor,
    },
    dossiers: dossierDirectories(paths, names.config),
    capabilities: {
      assistantControl: process.platform === 'darwin' && fs.existsSync(paths.launcher),
      monitorControl: process.platform === 'darwin' && monitor.installed,
      dossierControl: process.platform === 'darwin' && fs.existsSync(paths.launcher),
    },
  };
}

function saveTelegramConfig(options, patch = {}) {
  const { repoRoot, userHome = os.homedir(), homeDir = path.join(userHome, '.piecemaker') } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir });
  const current = readNames(paths.projectsFile);
  const assistantName = cleanName(patch.assistantName, current.assistantName);
  const monitorName = cleanName(patch.monitorName, current.monitorName);
  const assistantToken = validateToken(patch.assistantToken);
  const monitorToken = validateToken(patch.monitorToken);
  const savedAssistant = assistantToken || readToken(paths.assistantState);
  const savedMonitor = monitorToken || readMonitorToken(paths);
  if (savedAssistant && savedMonitor && savedAssistant === savedMonitor) {
    throw new Error('L’Assistant et le bot de surveillance doivent utiliser deux tokens différents.');
  }
  if (assistantToken) assertTokenUnique(paths.channelRoot, assistantToken, [paths.assistantState, paths.genericState]);
  if (monitorToken) assertTokenUnique(paths.channelRoot, monitorToken, [paths.monitorState, paths.legacyMonitorState]);
  const projects = Array.isArray(current.config.projects) ? [...current.config.projects] : [];
  const projectIndex = projects.findIndex((entry) => entry?.name === 'piecemaker');
  const existing = projectIndex >= 0 ? projects[projectIndex] : {};
  const project = {
    ...existing,
    name: 'piecemaker',
    displayName: assistantName,
    workdir: paths.dossiersRoot,
    aliases: [...new Set([...(existing.aliases || []), 'pm'])],
    permissionMode: existing.permissionMode || 'auto',
  };
  if (projectIndex >= 0) projects[projectIndex] = project;
  else projects.unshift(project);
  atomicWrite(paths.projectsFile, `${JSON.stringify({
    ...current.config,
    assistantName,
    daemonName: monitorName,
    projects,
  }, null, 2)}\n`, 0o600);

  if (assistantToken) writeToken(paths.assistantState, assistantToken);
  if (monitorToken || (!readToken(paths.monitorState) && savedMonitor)) {
    writeToken(paths.monitorState, savedMonitor);
    const legacyAccess = path.join(paths.legacyMonitorState, 'access.json');
    const targetAccess = path.join(paths.monitorState, 'access.json');
    if (!fs.existsSync(targetAccess) && fs.existsSync(legacyAccess)) {
      atomicWrite(targetAccess, fs.readFileSync(legacyAccess, 'utf8'), 0o600);
    } else {
      copyGeneralAccess(paths, paths.monitorState);
    }
  }
  return getTelegramState({ repoRoot, userHome, homeDir });
}

function saveDossierBot(options, dossierId, patch = {}) {
  const { repoRoot, userHome = os.homedir(), homeDir = path.join(userHome, '.piecemaker') } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir });
  const names = readNames(paths.projectsFile);
  const dossier = dossierDirectories(paths, names.config).find((entry) => entry.id === dossierId);
  if (!dossier) throw new Error('Dossier juridique introuvable dans la racine configurée.');
  const name = cleanName(patch.name, dossier.name || dossier.directoryName);
  const token = validateToken(patch.token);
  const stateDir = path.join(paths.channelRoot, `telegram-${dossier.id}`);
  const effectiveToken = token || readToken(stateDir);
  if (!effectiveToken) throw new Error('Un token BotFather est requis pour lier ce dossier.');
  if (token) assertTokenUnique(paths.channelRoot, token, [stateDir]);

  const projects = Array.isArray(names.config.projects) ? [...names.config.projects] : [];
  const index = projects.findIndex((project) => project?.name === dossier.id || (() => {
    try { return path.resolve(project?.workdir) === path.resolve(dossier.workdir); } catch { return false; }
  })());
  const existing = index >= 0 ? projects[index] : {};
  const project = {
    ...existing,
    name: dossier.id,
    displayName: name,
    workdir: dossier.workdir,
    aliases: [...new Set([...(existing.aliases || []), dossier.id])],
    permissionMode: existing.permissionMode || 'auto',
  };
  if (index >= 0) projects[index] = project;
  else projects.push(project);
  atomicWrite(paths.projectsFile, `${JSON.stringify({ ...names.config, projects }, null, 2)}\n`, 0o600);
  if (token) writeToken(stateDir, token);
  copyGeneralAccess(paths, stateDir);
  return getTelegramState({ repoRoot, userHome, homeDir }).dossiers.find((entry) => entry.id === dossier.id);
}

function controlProjectSession(options, { projectName, stateDir, label }, action) {
  const { repoRoot, userHome = os.homedir() } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir: options.homeDir || path.join(userHome, '.piecemaker') });
  if (process.platform !== 'darwin') throw new Error('Le contrôle graphique de la session Telegram est actuellement disponible sur macOS.');
  const active = readBotProcess(stateDir);
  if (action === 'start') {
    if (active) return { ok: true, message: `${label} déjà actif (PID ${active.pid}).` };
    if (!readToken(stateDir)) throw new Error(`Configurez d’abord le token de ${label}.`);
    const result = run('/bin/bash', [paths.launcher, projectName], {
      cwd: repoRoot,
      timeout: 30_000,
      env: { ...process.env, HOME: userHome },
    });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Le lancement a échoué.').trim());
    return { ok: true, message: String(result.stdout || `${label} lancé.`).trim() };
  }
  if (action === 'stop') {
    if (!active) return { ok: true, message: `${label} déjà arrêté.` };
    const claudePid = findClaudeParent(active.pid);
    if (!claudePid) throw new Error('Le processus parent Claude n’a pas pu être identifié en sécurité.');
    process.kill(claudePid, 'SIGTERM');
    return { ok: true, message: `Arrêt demandé à la session Claude (PID ${claudePid}).` };
  }
  throw new Error('Action Telegram inconnue.');
}

function controlAssistant(options, action) {
  const { repoRoot, userHome = os.homedir(), homeDir = path.join(userHome, '.piecemaker') } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir });
  return controlProjectSession({ repoRoot, userHome, homeDir }, {
    projectName: 'piecemaker',
    stateDir: paths.assistantState,
    label: 'L’Assistant général',
  }, action);
}

function controlDossierBot(options, dossierId, action) {
  const { repoRoot, userHome = os.homedir(), homeDir = path.join(userHome, '.piecemaker') } = options;
  const paths = pathsFor({ repoRoot, userHome, homeDir });
  const names = readNames(paths.projectsFile);
  const dossier = dossierDirectories(paths, names.config).find((entry) => entry.id === dossierId);
  if (!dossier || !dossier.projectConfigured) throw new Error('Ce dossier n’est pas encore lié à un Assistant Telegram.');
  return controlProjectSession({ repoRoot, userHome, homeDir }, {
    projectName: dossier.id,
    stateDir: path.join(paths.channelRoot, `telegram-${dossier.id}`),
    label: `L’Assistant « ${dossier.name} »`,
  }, action);
}

function controlMonitor(options, action) {
  const { userHome = os.homedir() } = options;
  const status = monitorStatus(userHome);
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new Error('Le contrôle du service de surveillance est actuellement disponible sur macOS.');
  }
  if (!status.installed) throw new Error('Le service de surveillance n’est pas installé. Relancez l’étape Telegram de l’installateur.');
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${MONITOR_LABEL}`;
  if (action === 'start') {
    if (!status.loaded) {
      const bootstrap = run('/bin/launchctl', ['bootstrap', domain, status.plist]);
      if (bootstrap.status !== 0 && monitorStatus(userHome).loaded === false) {
        throw new Error(String(bootstrap.stderr || 'Impossible de charger le service de surveillance.').trim());
      }
    }
    const start = run('/bin/launchctl', ['kickstart', '-k', service]);
    if (start.status !== 0) throw new Error(String(start.stderr || 'Impossible de démarrer le service.').trim());
    return { ok: true, message: 'Bot de surveillance démarré.' };
  }
  if (action === 'stop') {
    if (!status.running) return { ok: true, message: 'Bot de surveillance déjà arrêté.' };
    const stop = run('/bin/launchctl', ['bootout', service]);
    if (stop.status !== 0) throw new Error(String(stop.stderr || 'Impossible d’arrêter le service.').trim());
    return { ok: true, message: 'Bot de surveillance arrêté jusqu’à la prochaine ouverture de session.' };
  }
  throw new Error('Action Telegram inconnue.');
}

function controlTelegram(options, role, action) {
  if (!['start', 'stop'].includes(action)) throw new Error('Action Telegram inconnue.');
  if (role === 'assistant') return controlAssistant(options, action);
  if (role === 'monitor') return controlMonitor(options, action);
  throw new Error('Bot Telegram inconnu.');
}

module.exports = {
  ASSISTANT_DIR,
  MONITOR_DIR,
  getTelegramState,
  readToken,
  saveDossierBot,
  saveTelegramConfig,
  tokenState,
  validateToken,
  controlDossierBot,
  controlTelegram,
};

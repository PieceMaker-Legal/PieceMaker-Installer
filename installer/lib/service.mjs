/**
 * Local PieceMaker service lifecycle.
 *
 * The CLI owns the background HTTPS server now that the Electron shell is
 * disabled. Runtime files live in ~/.piecemaker so the repository stays
 * clean and the same commands work on macOS, Windows and Linux.
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  HOME_DIR,
  IS_MAC,
  IS_WINDOWS,
  REPO_ROOT,
  commandExists,
  ensureDir,
  npmBin,
  npmEnv,
  runCapture,
} from './platform.mjs';
import { loadConfig, readEnv } from './state.mjs';

export const PID_FILE = path.join(HOME_DIR, 'server.pid');
export const LOG_FILE = path.join(HOME_DIR, 'server.log');
export const SERVER_FILE = path.join(REPO_ROOT, 'websocket-server', 'server.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function adminUrl(config = loadConfig()) {
  return `https://localhost:${Number(config.port) || 43098}/admin/`;
}

function healthUrl(config = loadConfig()) {
  return `https://localhost:${Number(config.port) || 43098}/health`;
}

export function readServerPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parsePidList(output) {
  return [...new Set(
    String(output || '')
      .split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  )];
}

/**
 * Return every process listening on a TCP port, whether PieceMaker started it
 * or not. lsof is available by default on macOS; fuser/ss cover common Linux
 * installs, while Windows exposes the owning PID through PowerShell.
 */
export function findListeningPids(port) {
  const normalizedPort = Number(port);
  if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535) {
    throw new Error(`Port TCP invalide : ${port}`);
  }

  if (IS_WINDOWS) {
    const powershell = runCapture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; @(Get-NetTCPConnection -State Listen -LocalPort ${normalizedPort}).OwningProcess`,
    ]);
    if (!powershell.error && powershell.code === 0) return parsePidList(powershell.stdout);

    const netstat = runCapture('netstat', ['-ano', '-p', 'tcp']);
    if (!netstat.error && netstat.code === 0) {
      const pids = netstat.stdout.split(/\r?\n/).flatMap((line) => {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') return [];
        if (!columns[1].endsWith(`:${normalizedPort}`) || columns[3].toUpperCase() !== 'LISTENING') return [];
        return parsePidList(columns.at(-1));
      });
      return [...new Set(pids)];
    }

    throw new Error(`Impossible d’identifier le processus qui écoute sur le port ${normalizedPort}.`);
  }

  const lsof = runCapture('lsof', [
    '-nP',
    '-t',
    `-iTCP:${normalizedPort}`,
    '-sTCP:LISTEN',
  ]);
  if (!lsof.error && (lsof.code === 0 || lsof.code === 1)) return parsePidList(lsof.stdout);

  const fuser = runCapture('fuser', ['-n', 'tcp', String(normalizedPort)]);
  if (!fuser.error && (fuser.code === 0 || fuser.code === 1)) return parsePidList(fuser.stdout);

  const ss = runCapture('ss', ['-H', '-ltnp', 'sport', '=', `:${normalizedPort}`]);
  if (!ss.error && ss.code === 0) {
    return [...new Set(
      [...ss.stdout.matchAll(/pid=(\d+)/g)]
        .map((match) => Number.parseInt(match[1], 10))
        .filter((pid) => pid > 0 && pid !== process.pid)
    )];
  }

  throw new Error(`Impossible d’identifier le processus qui écoute sur le port ${normalizedPort}.`);
}

function signalProcesses(pids, signal) {
  const failures = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') failures.push(`${pid} (${error.code || error.message})`);
    }
  }
  if (failures.length) {
    throw new Error(`Impossible d’arrêter le(s) processus ${failures.join(', ')}.`);
  }
}

async function waitForPortRelease(port, managedPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listeners = findListeningPids(port);
    if (!listeners.length && (!managedPid || !isProcessRunning(managedPid))) return true;
    await delay(200);
  }
  return false;
}

function removePid(expectedPid = null) {
  const current = readServerPid();
  if (expectedPid && current !== expectedPid) return;
  try {
    fs.unlinkSync(PID_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function probeServer(config = loadConfig(), timeoutMs = 1200) {
  const url = new URL(healthUrl(config));
  return new Promise((resolve) => {
    const request = https.get(
      {
        hostname: '127.0.0.1',
        port: url.port,
        path: url.pathname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

export async function getServerStatus(config = loadConfig()) {
  const pid = readServerPid();
  const processRunning = isProcessRunning(pid);
  if (pid && !processRunning) removePid(pid);
  const running = await probeServer(config);
  return {
    running,
    pid: processRunning ? pid : null,
    managed: Boolean(processRunning && pid),
    url: adminUrl(config),
    logFile: LOG_FILE,
  };
}

function serverEnvironment(config) {
  const savedEnv = readEnv();
  return {
    ...process.env,
    ...savedEnv,
    PORT: String(Number(config.port) || 43098),
    PYTHON_PATH: config.pythonPath || savedEnv.PYTHON_PATH || '',
    PIECEMAKER_HOST: '127.0.0.1',
  };
}

export async function startServer({ timeoutMs = 15_000 } = {}) {
  const config = loadConfig();
  const current = await getServerStatus(config);
  if (current.running) return { ...current, started: false };

  if (current.pid && current.managed) {
    throw new Error(
      `Le processus serveur ${current.pid} existe mais ne répond pas. Consultez ${LOG_FILE} ou lancez "piecemaker stop".`
    );
  }

  const keyFile = path.join(REPO_ROOT, 'websocket-server', 'localhost.key');
  const certFile = path.join(REPO_ROOT, 'websocket-server', 'localhost.crt');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    throw new Error(
      'Les certificats HTTPS sont absents. Lancez "piecemaker install", puis installez le composant 05 — Certificats HTTPS.'
    );
  }

  ensureDir(HOME_DIR);
  fs.appendFileSync(LOG_FILE, `\n[${new Date().toISOString()}] Démarrage de PieceMaker\n`, 'utf8');
  const logFd = fs.openSync(LOG_FILE, 'a');
  let child;
  try {
    child = spawn(process.execPath, [SERVER_FILE], {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: serverEnvironment(config),
    });
  } finally {
    fs.closeSync(logFd);
  }

  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid}\n`, 'utf8');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServer(config)) {
      return {
        running: true,
        pid: child.pid,
        managed: true,
        url: adminUrl(config),
        logFile: LOG_FILE,
        started: true,
      };
    }
    if (!isProcessRunning(child.pid)) break;
    await delay(250);
  }

  removePid(child.pid);
  const tail = readLogs(20);
  throw new Error(`Le serveur n'a pas démarré. Consultez ${LOG_FILE}.${tail ? `\n${tail}` : ''}`);
}

export async function stopServer({ timeoutMs = 8_000, forceTimeoutMs = 2_000 } = {}) {
  const config = loadConfig();
  const status = await getServerStatus(config);
  const port = Number(config.port) || 43098;
  const listeners = findListeningPids(port);
  const targets = [...new Set([status.pid, ...listeners].filter(Boolean))];
  if (!targets.length) return { ...status, stopped: false, alreadyStopped: true };

  signalProcesses(targets, 'SIGTERM');
  let stopped = await waitForPortRelease(port, status.pid, timeoutMs);

  if (!stopped) {
    const remaining = [...new Set([
      ...findListeningPids(port),
      status.pid && isProcessRunning(status.pid) ? status.pid : null,
    ].filter(Boolean))];
    signalProcesses(remaining, 'SIGKILL');
    stopped = await waitForPortRelease(port, status.pid, forceTimeoutMs);
  }

  if (status.pid && !isProcessRunning(status.pid)) removePid(status.pid);
  const remaining = findListeningPids(port);
  const running = await probeServer(config);
  if (!stopped || remaining.length || running) {
    const suffix = remaining.length ? ` PID restant(s) : ${remaining.join(', ')}.` : '';
    throw new Error(`Le port ${port} n’a pas pu être libéré.${suffix}`);
  }
  return {
    running: false,
    pid: null,
    managed: false,
    stopped: true,
    stoppedPids: targets,
    url: adminUrl(config),
    logFile: LOG_FILE,
  };
}

export function readLogs(lines = 80) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8').trimEnd();
    return content.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export function openExternal(url) {
  let command;
  let args;
  if (IS_WINDOWS) {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', 'start', '', url];
  } else if (IS_MAC) {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

export async function openAdmin() {
  const status = await startServer();
  openExternal(status.url);
  return status;
}

function runOrThrow(command, args, label) {
  const result = runCapture(command, args, { cwd: REPO_ROOT });
  if (result.code !== 0 || result.error) {
    throw new Error(`${label} : ${result.stderr || result.stdout || result.error?.message || `code ${result.code}`}`);
  }
  return result;
}

/** launchd label of the Telegram monitor installed by step 08. */
const TELEGRAM_DAEMON_LABEL = 'com.piecemaker.telegram-monitor';

/**
 * The Telegram monitor runs `orchestrator/piecemaker-daemon.mjs` straight out
 * of the repository, so an update leaves it executing the previous revision
 * until launchd restarts it. Only touched when the service is already loaded.
 */
export function restartTelegramDaemon() {
  if (!IS_MAC || typeof process.getuid !== 'function') return { restarted: false, reason: 'unsupported' };
  const domain = `gui/${process.getuid()}`;
  if (runCapture('launchctl', ['print', `${domain}/${TELEGRAM_DAEMON_LABEL}`]).code !== 0) {
    return { restarted: false, reason: 'absent' };
  }
  const kick = runCapture('launchctl', ['kickstart', '-k', `${domain}/${TELEGRAM_DAEMON_LABEL}`]);
  return kick.code === 0
    ? { restarted: true }
    : { restarted: false, reason: kick.stderr || `code ${kick.code}` };
}

function gitOut(args, label) {
  return runOrThrow('git', args, label).stdout;
}

/**
 * Claude Code plugin coordinates — kept in sync with the marketplace/plugin
 * names declared in installer/steps/09-claude-assets.mjs.
 */
const CLAUDE_MARKETPLACE = 'piecemaker';
const CLAUDE_PLUGIN_SPEC = 'piecemaker@piecemaker';

/**
 * Refresh the installed Claude Code plugin after a repository update.
 *
 * `piecemaker update` moves the checked-out repo to origin, but the plugin
 * Claude Code actually loads is a frozen marketplace copy under
 * ~/.claude/plugins/. It only moves when the marketplace clone is pulled
 * (`plugin marketplace update`) and the plugin reinstalled from it
 * (`plugin update`) — the two commands a user otherwise runs by hand. Both
 * pull from the same GitHub source as the repo, so an update already published
 * upstream is exactly what this propagates into the running plugin.
 *
 * Best-effort by design: a missing `claude` CLI or a failing subcommand is
 * reported, never thrown, so it can't turn a successful repo update into a
 * failed command. A session restart is still required for Claude Code to load
 * the new revision — that part is on the user.
 */
export function refreshClaudePlugin() {
  if (!commandExists('claude', ['--version'])) {
    return { ok: false, refreshed: false, reason: 'CLI « claude » introuvable' };
  }
  const market = runCapture('claude', ['plugin', 'marketplace', 'update', CLAUDE_MARKETPLACE]);
  if (market.code !== 0) {
    return {
      ok: false,
      refreshed: false,
      reason: market.stderr || market.stdout || `« plugin marketplace update » a échoué (code ${market.code})`,
    };
  }
  const plugin = runCapture('claude', ['plugin', 'update', CLAUDE_PLUGIN_SPEC]);
  if (plugin.code !== 0) {
    return {
      ok: false,
      refreshed: false,
      reason: plugin.stderr || plugin.stdout || `« plugin update » a échoué (code ${plugin.code})`,
    };
  }
  return { ok: true, refreshed: true, reason: '' };
}

/**
 * Fetch the target ref and report whether it differs from the checked-out
 * revision. Read-only: nothing is stopped, moved or installed here, so the
 * caller can decide about downtime before the working tree is touched.
 */
export function checkForUpdate() {
  const branch = gitOut(['branch', '--show-current'], 'Impossible de déterminer la branche');
  const ref = process.env.PIECEMAKER_REF || branch || 'main';
  runOrThrow('git', ['fetch', 'origin', ref], 'Téléchargement Git impossible');

  const current = gitOut(['rev-parse', 'HEAD'], 'Impossible de lire la révision locale');
  const target = gitOut(['rev-parse', 'FETCH_HEAD'], 'Impossible de lire la révision distante');
  // The installed checkout is a deployment artifact: tracked local edits are
  // never a second source of truth. They trigger reconciliation with origin,
  // while untracked/ignored runtime data remains untouched.
  const localChanges = gitOut(
    ['status', '--porcelain', '--untracked-files=no'],
    'Impossible de vérifier le dépôt',
  ).split('\n').filter(Boolean);
  const changed = current === target
    ? []
    : gitOut(['diff', '--name-only', current, target], 'Impossible de comparer les révisions')
      .split('\n')
      .filter(Boolean);

  const remoteAvailable = current !== target;
  const dirty = localChanges.length > 0;
  return {
    ref,
    branch,
    current,
    target,
    changed,
    localChanges: localChanges.length,
    dirty,
    remoteAvailable,
    available: remoteAvailable || dirty,
  };
}

/**
 * Apply a pending update: move the working tree to the fetched revision, then
 * reconcile node_modules with the new package.json. `git` handles both halves
 * of "delete deprecated files, download new ones" — a checkout removes files
 * dropped upstream and writes the added ones — and `npm prune` does the same
 * for dependencies that no longer appear in package.json.
 *
 * Pass the result of `checkForUpdate()` to avoid fetching twice.
 */
export function updateRepository(pending = checkForUpdate()) {
  if (!pending.available) return { ...pending, updated: false };

  // origin is authoritative for every tracked file in the installed clone.
  // `reset --hard` also handles divergent commits and a detached HEAD. It does
  // not perform `git clean`, so untracked and ignored runtime data is kept.
  runOrThrow('git', ['reset', '--hard', 'FETCH_HEAD'], 'Mise à jour Git impossible');

  const npmOptions = { cwd: REPO_ROOT, env: npmEnv() };
  const installed = runCapture(npmBin('npm'), ['install', '--no-audit', '--no-fund'], npmOptions);
  if (installed.code !== 0 || installed.error) {
    throw new Error(`Mise à jour npm impossible : ${installed.stderr || installed.stdout || installed.error?.message || `code ${installed.code}`}`);
  }
  const pruned = runCapture(npmBin('npm'), ['prune', '--no-audit', '--no-fund'], npmOptions);
  if (pruned.code !== 0 || pruned.error) {
    throw new Error(`Nettoyage des dépendances impossible : ${pruned.stderr || pruned.stdout || pruned.error?.message || `code ${pruned.code}`}`);
  }
  return {
    ...pending,
    updated: true,
    // requirements.txt is installed into the venv by step 03, not by npm.
    pythonChanged: pending.changed.some((file) => file.endsWith('requirements.txt')),
  };
}

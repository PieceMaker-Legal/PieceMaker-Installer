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
  ensureDir,
  npmBin,
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
    PIECEMAKER_WORKSPACE_PATH: config.workspacePath || '',
    OUTPUT_PATH: config.workspacePath || config.outputPath || savedEnv.OUTPUT_PATH || '',
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

export async function stopServer({ timeoutMs = 8_000 } = {}) {
  const config = loadConfig();
  const status = await getServerStatus(config);
  if (!status.running && !status.pid) return { ...status, stopped: false, alreadyStopped: true };
  if (!status.pid) {
    throw new Error('Le serveur répond, mais son PID n’est pas géré par PieceMaker. Arrêtez le processus qui occupe le port manuellement.');
  }

  try {
    process.kill(status.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(status.pid) && !(await probeServer(config))) break;
    await delay(200);
  }
  removePid(status.pid);
  const running = await probeServer(config);
  if (running) throw new Error('Le serveur n’a pas pu être arrêté proprement.');
  return { running: false, pid: null, managed: false, stopped: true, url: adminUrl(config), logFile: LOG_FILE };
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

  runOrThrow(npmBin('npm'), ['install', '--no-audit', '--no-fund'], 'Mise à jour npm impossible');
  runOrThrow(npmBin('npm'), ['prune', '--no-audit', '--no-fund'], 'Nettoyage des dépendances impossible');
  // npm link needs a writable global prefix; a read-only one must not undo an
  // otherwise successful update, so it only downgrades to a warning.
  const linked = runCapture(npmBin('npm'), ['link', '--ignore-scripts'], { cwd: REPO_ROOT });

  return {
    ...pending,
    updated: true,
    linked: linked.code === 0,
    // requirements.txt is installed into the venv by step 03, not by npm.
    pythonChanged: pending.changed.some((file) => file.endsWith('requirements.txt')),
  };
}

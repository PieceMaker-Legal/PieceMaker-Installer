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

export function updateRepository() {
  const dirty = runOrThrow('git', ['status', '--porcelain'], 'Impossible de vérifier le dépôt').stdout;
  if (dirty) {
    throw new Error('Le dépôt contient des modifications locales. Committez-les ou remisez-les avant la mise à jour.');
  }

  const branch = runOrThrow('git', ['branch', '--show-current'], 'Impossible de déterminer la branche').stdout;
  const ref = process.env.PIECEMAKER_REF || branch || 'main';
  if (branch) {
    runOrThrow('git', ['pull', '--ff-only', 'origin', ref], 'Mise à jour Git impossible');
  } else {
    runOrThrow('git', ['fetch', '--depth', '1', 'origin', ref], 'Téléchargement Git impossible');
    runOrThrow('git', ['checkout', '--detach', 'FETCH_HEAD'], 'Mise à jour Git impossible');
  }
  runOrThrow(npmBin('npm'), ['install', '--no-audit', '--no-fund'], 'Mise à jour npm impossible');
  runOrThrow(npmBin('npm'), ['link', '--ignore-scripts'], 'Réinstallation de la commande impossible');
  return { ref };
}

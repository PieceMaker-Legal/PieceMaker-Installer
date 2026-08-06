/**
 * Cross-platform process and toolchain helpers (macOS + Windows + Linux).
 *
 * Everything that shells out goes through here so the Windows quirks live in
 * one place: `.cmd` shims for npm/npx, `python` vs `python3`, and venv layouts
 * that put binaries in Scripts/ instead of bin/.
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/** Repository root, derived from this file's location. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

/** Per-user PieceMaker directory, replacing Electron's userData path. */
export const HOME_DIR = path.join(os.homedir(), '.piecemaker');

/** npm and npx need the .cmd shim on Windows when spawned without a shell. */
export function npmBin(name = 'npm') {
  return IS_WINDOWS ? `${name}.cmd` : name;
}

/**
 * Run a command to completion, streaming nothing.
 * Returns { code, stdout, stderr } and never throws on a non-zero exit.
 */
export function runCapture(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error,
  };
}

/**
 * Run a command, forwarding output line by line to `onLine`.
 * Resolves with the exit code; rejects only if the process cannot be spawned.
 */
export function run(command, args = [], { onLine, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    const forward = (stream) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (line.trim() && onLine) onLine(line);
        }
      });
      stream.on('end', () => {
        if (buffer.trim() && onLine) onLine(buffer.trim());
      });
    };

    if (child.stdout) forward(child.stdout);
    if (child.stderr) forward(child.stderr);

    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** True when `command --version` (or the given probe) succeeds. */
export function commandExists(command, args = ['--version']) {
  const result = runCapture(command, args);
  return result.code === 0 && !result.error;
}

/** Locate a usable Python 3 interpreter, honouring PYTHON_PATH. */
export function findPython() {
  const candidates = [
    process.env.PYTHON_PATH,
    IS_WINDOWS ? 'python' : 'python3',
    IS_WINDOWS ? 'python3' : 'python',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = runCapture(candidate, ['--version']);
    if (result.code !== 0) continue;
    const version = `${result.stdout} ${result.stderr}`.match(/Python (\d+)\.(\d+)/);
    if (!version) continue;
    const [, major, minor] = version.map(Number);
    if (major === 3 && minor >= 10) {
      return { command: candidate, version: `${major}.${minor}` };
    }
  }
  return null;
}

/** Paths inside a virtualenv, which differ on Windows. */
export function venvPaths(venvDir) {
  const binDir = path.join(venvDir, IS_WINDOWS ? 'Scripts' : 'bin');
  return {
    dir: venvDir,
    binDir,
    python: path.join(binDir, IS_WINDOWS ? 'python.exe' : 'python'),
    pip: path.join(binDir, IS_WINDOWS ? 'pip.exe' : 'pip'),
    exists: fs.existsSync(path.join(binDir, IS_WINDOWS ? 'python.exe' : 'python')),
  };
}

/** Compare semver-ish strings. Returns 1, 0 or -1. */
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

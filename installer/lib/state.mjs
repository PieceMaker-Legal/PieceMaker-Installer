/**
 * Installer state and user configuration.
 *
 * Replaces electron-store and Electron's app.getPath('userData'). Two files:
 *   ~/.piecemaker/config.json   durable settings (paths, endpoints, choices)
 *   ~/.piecemaker/state.json    what the installer has completed, for resume
 *
 * Secrets never land here — they go to .env with 0600 permissions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, REPO_ROOT, ensureDir } from './platform.mjs';

const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
const STATE_FILE = path.join(HOME_DIR, 'state.json');
const ENV_FILE = path.join(REPO_ROOT, '.env');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function loadConfig() {
  const defaults = {
    port: 43098,
    litellmPort: 4000,
    litellmVenvPath: path.join(HOME_DIR, 'litellm-venv'),
    pythonPath: null,
    venvPath: path.join(HOME_DIR, 'venv'),
    // Confinement OS optionnel (microsoft/mxc). mxcPath pointe le binaire mxc-exec
    // une fois construit par l'étape 14 ; mxcEnabled permet de désactiver le
    // confinement sans supprimer le binaire.
    mxcPath: null,
    mxcEnabled: true,
  };
  return { ...defaults, ...readJson(CONFIG_FILE, {}) };
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
  return config;
}

export function updateConfig(patch) {
  return saveConfig({ ...loadConfig(), ...patch });
}

export function loadState() {
  return readJson(STATE_FILE, { steps: {}, version: 1 });
}

/** Record a step outcome: 'done' | 'partial' | 'failed' | 'skipped'. */
export function markStep(id, status, note = '') {
  const state = loadState();
  state.steps[id] = { status, note, at: new Date().toISOString() };
  writeJson(STATE_FILE, state);
  return state;
}

export function stepStatus(id) {
  return loadState().steps[id]?.status || null;
}

/**
 * Merge keys into .env, preserving unrelated lines and comments.
 * The file is written 0600 because it holds API keys.
 */
export function writeEnv(values) {
  const existing = new Map();
  const preamble = [];

  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
      if (match) existing.set(match[1], match[2]);
      else if (line.trim()) preamble.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    existing.set(key, String(value));
  }

  const body = [...preamble, ...[...existing].map(([k, v]) => `${k}=${v}`)].join('\n');
  fs.writeFileSync(ENV_FILE, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {
    // Windows ignores POSIX modes; ACLs already restrict the user profile.
  }
  return ENV_FILE;
}

export function readEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export { CONFIG_FILE, STATE_FILE, ENV_FILE };

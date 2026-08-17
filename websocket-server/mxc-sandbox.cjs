/**
 * mxc-sandbox.cjs — OS-level filesystem containment for the task-pane Claude
 * Code session (defence-in-depth over the anonymisation hooks).
 *
 * The PreToolUse hooks that guard the anonymisation mapping parse raw command
 * text and are therefore bypassable ($VAR, `python -c "open(...)"`, `find -exec
 * cat {}`, cd+relative paths — see docs/mxc-sandbox.md and the
 * `hook-protection-contournable` finding). A hook cannot decide which files a
 * shell command will read; only the OS can. This module builds a
 * microsoft/mxc policy (https://github.com/microsoft/mxc) so the interactive
 * shell we spawn in the PTY runs under Seatbelt (macOS) / ProcessContainer
 * (Windows) with three targets blocked at the syscall level, however the agent
 * phrases the read:
 *
 *   1. the Python env       — config.venvPath (default ~/.piecemaker/venv)
 *   2. the case mapping     — mapping_default.json + any mapping*.json /
 *                             *_sensitive_map.json in the case
 *   3. the central mapping  — ~/.piecemaker/central-mapping.json
 *
 * IMPORTANT LIMITS (kept honest on purpose — mxc self-declares "not a security
 * boundary currently", so the hooks stay as a second layer, never removed):
 *   - This contains only the process we launch through mxc. Files are not
 *     locked at rest.
 *   - `filesystem.deniedPaths` (deny-all-except) works on macOS/Linux. Windows
 *     is allowlist-only: `.venv` and the central mapping are protected by
 *     *omission* (never granted), but `mapping_default.json` lives inside the
 *     case folder the agent must read and cannot be excluded from an
 *     allowlist — it stays hook-only there.
 *
 * The whole thing is optional: when no mxc binary is installed, `isMxcAvailable`
 * returns false and the caller spawns the shell exactly as before.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { caseMappingFile } = require('../piecemaker-plugin/scripts/lib/mapping.cjs');

const MXC_SCHEMA_VERSION = '0.7.0-alpha';
const WORKSPACE_SUBDIR = 'Fichiers convertis PieceMaker';

const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

const PIECEMAKER_HOME = process.env.PIECEMAKER_HOME || path.join(os.homedir(), '.piecemaker');

/** deny-all-except is available on macOS (Seatbelt) and Linux, not on Windows. */
function supportsDeny() {
  return IS_MAC || IS_LINUX;
}

function containmentBackend() {
  if (IS_MAC) return 'seatbelt';
  if (IS_WINDOWS) return 'processcontainer';
  return 'process';
}

function readConfig() {
  try {
    const file = path.join(PIECEMAKER_HOME, 'config.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** Resolve the mxc executor binary, honouring the env override. Null when absent. */
function mxcBinaryPath(config = readConfig()) {
  const candidate = process.env.PIECEMAKER_MXC_PATH || config.mxcPath;
  return candidate && fs.existsSync(candidate) ? candidate : null;
}

/**
 * True when the sandbox should be used: enabled in config, a binary is present,
 * the platform is supported, and no escape hatch is set. `PIECEMAKER_MXC_DISABLE=1`
 * turns it off without touching config (used to recover if a policy ever breaks
 * a session).
 */
function isMxcAvailable(config = readConfig()) {
  if (process.env.PIECEMAKER_MXC_DISABLE === '1') return false;
  if (config.mxcEnabled === false) return false;
  if (!(IS_MAC || IS_WINDOWS || IS_LINUX)) return false;
  return Boolean(mxcBinaryPath(config));
}

function venvPath(config) {
  return config.venvPath || path.join(PIECEMAKER_HOME, 'venv');
}

function centralMappingPath() {
  return path.join(PIECEMAKER_HOME, 'central-mapping.json');
}

/**
 * Every mapping file to deny for a case. The canonical mapping is denied by its
 * resolved path whether or not it exists yet (a Seatbelt rule is path-based, so
 * a file created mid-session is still covered). Existing mapping*.json /
 * *_sensitive_map.json siblings are enumerated too.
 */
function caseMappingPaths(caseRoot) {
  const out = new Set();
  try {
    out.add(caseMappingFile(caseRoot));
  } catch {
    // caseMappingFile can throw on a malformed root — the two dirs below still cover it.
  }
  const dirs = [caseRoot, path.join(caseRoot, WORKSPACE_SUBDIR), path.join(caseRoot, '.piecemaker')];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (/^mapping.*\.json$/i.test(name) || /_sensitive_map\.json$/i.test(name)) {
        out.add(path.join(dir, name));
      }
    }
  }
  return [...out];
}

/**
 * Windows allowlist. mxc has no deniedPaths on Windows, so protection is by
 * omission: grant the roots the shell genuinely needs and never grant
 * PIECEMAKER_HOME, so the venv and the central mapping stay out of reach. The
 * case folder (cwd) must be granted for the agent to read its .md, which is why
 * mapping_default.json inside it cannot be excluded here and stays hook-only.
 */
function buildWindowsAllowlist({ cwd }) {
  const home = os.homedir();
  const readwrite = [cwd, os.tmpdir(), path.join(home, '.claude'), path.join(home, 'AppData')];
  const readonly = [
    process.env.SystemRoot || 'C:\\Windows',
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    path.dirname(process.execPath), // the Node runtime
  ];
  const resolve = (list) => [...new Set(list.filter(Boolean).map((p) => path.resolve(p)))];
  return { readwritePaths: resolve(readwrite), readonlyPaths: resolve(readonly) };
}

function writeTempConfig(config) {
  const dir = path.join(os.tmpdir(), 'piecemaker-mxc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `policy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Compute the deniedPaths (macOS/Linux) for a session. Exported so tests can
 * assert the policy without spawning anything.
 */
function deniedPathsFor({ documentId, config = readConfig(), resolveCaseRoot } = {}) {
  const denied = new Set();
  denied.add(venvPath(config));
  denied.add(centralMappingPath());
  if (documentId && typeof resolveCaseRoot === 'function') {
    let caseRoot = null;
    try {
      caseRoot = resolveCaseRoot(documentId);
    } catch {
      // No active case — the two global paths above are still denied.
    }
    if (caseRoot) for (const p of caseMappingPaths(caseRoot)) denied.add(p);
  }
  return [...denied].filter(Boolean).map((p) => path.resolve(p));
}

/**
 * Build the mxc config for a PTY session and write it to a temp file.
 * Returns { mxcPath, args, configPath, filesystem, cleanup } — spawn
 * `mxcPath` with `args` in place of the bare shell — or null when mxc is
 * unavailable (caller then spawns the shell directly).
 *
 * @param {object}   opts
 * @param {string}   opts.shell           interactive shell to contain (commandLine)
 * @param {string}   opts.cwd             working directory (case root)
 * @param {string}   [opts.documentId]    active document → case mapping paths
 * @param {object}   [opts.env]           env passed through to the shell
 * @param {Function} [opts.resolveCaseRoot] documentId → case root (server's getOutputPath)
 */
function buildSandboxConfig({ shell, cwd, documentId, env, config = readConfig(), resolveCaseRoot } = {}) {
  const mxcPath = mxcBinaryPath(config);
  if (!mxcPath) return null;

  const envArray = Object.entries(env || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);

  const filesystem = supportsDeny()
    ? { deniedPaths: deniedPathsFor({ documentId, config, resolveCaseRoot }) }
    : buildWindowsAllowlist({ cwd });

  const cfg = {
    version: MXC_SCHEMA_VERSION,
    _comment: 'PieceMaker filesystem sandbox for the Claude Code task-pane session — defence-in-depth over the anonymisation hooks.',
    containment: containmentBackend(),
    process: { commandLine: shell, cwd, env: envArray, timeout: 0 },
    filesystem,
    // The sandbox is for the filesystem: Claude needs its API and localhost:43098,
    // so a default-deny network would break the session.
    network: { defaultPolicy: 'allow', allowLocalNetwork: true },
  };
  if (IS_MAC) {
    // exec = sandbox_init + exec in-process, so the shell inherits node-pty's
    // controlling terminal; nestedPty lets interactive child programs open their
    // own PTYs; keychain access is needed for credential helpers.
    cfg.seatbelt = { launchMethod: 'exec', nestedPty: true, keychainAccess: true, guiAccess: false };
  }

  const configPath = writeTempConfig(cfg);
  return {
    mxcPath,
    args: [configPath],
    configPath,
    filesystem,
    cleanup: () => {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // Already gone (temp reaped) — nothing to do.
      }
    },
  };
}

module.exports = {
  MXC_SCHEMA_VERSION,
  isMxcAvailable,
  mxcBinaryPath,
  buildSandboxConfig,
  deniedPathsFor,
  caseMappingPaths,
  centralMappingPath,
  supportsDeny,
  containmentBackend,
};

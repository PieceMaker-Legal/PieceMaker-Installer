/**
 * Step 14 — mxc OS-level filesystem sandbox (best-effort, optional).
 *
 * Builds microsoft/mxc (https://github.com/microsoft/mxc) and records the
 * executor binary so the task-pane Claude Code session can run under Seatbelt
 * (macOS) / ProcessContainer (Windows), with the Python venv and the
 * anonymisation mappings denied at the syscall level. This hardens the
 * PreToolUse hooks, which parse command text and are bypassable (see
 * docs/mxc-sandbox.md).
 *
 * Deliberately best-effort, like the CoreML encoder in step 03: mxc needs the
 * Rust toolchain, self-declares "not a security boundary currently", and its
 * value is defence-in-depth. Any failure falls back cleanly to the hooks and
 * never fails the install — the step is `required: false`. The runtime side
 * (websocket-server/mxc-sandbox.cjs) simply spawns the bare shell when no binary
 * is recorded.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, spinner, columns } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import {
  run,
  runCapture,
  commandExists,
  compareVersions,
  ensureDir,
  HOME_DIR,
  IS_WINDOWS,
  IS_MAC,
} from '../lib/platform.mjs';
import { updateConfig, writeEnv } from '../lib/state.mjs';

export const meta = {
  id: '14-mxc-sandbox',
  label: 'Confinement OS (mxc)',
  description: 'Construit microsoft/mxc pour isoler la session Claude Code (venv + mappings) au niveau système',
  required: false,
};

const MXC_TAG = 'v0.7.0';
const MXC_REPO = 'https://github.com/microsoft/mxc';
const MXC_SRC = path.join(HOME_DIR, 'mxc-src');
const MXC_BIN_DIR = path.join(HOME_DIR, 'mxc');
const BIN_NAME = IS_WINDOWS ? 'wxc-exec.exe' : 'mxc-exec-mac';

function truncate(text) {
  const width = Math.max(20, columns() - 6);
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

/** Prepend ~/.cargo/bin so a freshly installed rustup is visible without a new shell. */
function buildEnv() {
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  return {
    ...process.env,
    [pathKey]: [cargoBin, process.env[pathKey] || ''].filter(Boolean).join(path.delimiter),
  };
}

function cargoVersion(env) {
  const res = runCapture('cargo', ['--version'], { env });
  if (res.code !== 0) return null;
  const m = res.stdout.match(/cargo\s+(\d+\.\d+\.\d+)/);
  return m ? m[1] : 'unknown';
}

/** Recursively find the produced binary under a cargo target/ tree. */
function findBinary(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === BIN_NAME) return full;
    }
  }
  return null;
}

async function ensureRust(env) {
  if (commandExists('cargo', ['--version'])) {
    const v = cargoVersion(env);
    // rust-toolchain.toml in the repo pins 1.93; rustup auto-fetches it at build
    // time, so any rustup-backed cargo is fine. A very old non-rustup cargo will
    // fail the build, which we surface as `partial`, not a crash.
    log.info(`Rust présent (cargo ${v}).`);
    return { ok: true };
  }

  log.warn("Rust (cargo) est introuvable — nécessaire pour construire mxc.");
  const install = await confirm('Installer la chaîne Rust (rustup) maintenant ?', true);
  if (!install) return { ok: false, note: 'Rust non installé — la protection reste assurée par les hooks.' };

  const spin = spinner('Installation de rustup...');
  let code;
  if (IS_WINDOWS) {
    // winget is the least-fragile unattended path on Windows; if absent the
    // step degrades to a manual instruction below.
    code = await run('winget', ['install', '--id', 'Rustlang.Rustup', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'], {
      env,
      onLine: (line) => spin.update(truncate(line)),
    }).catch(() => 1);
  } else {
    code = await run('sh', ['-c', "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"], {
      env,
      onLine: (line) => spin.update(truncate(line)),
    }).catch(() => 1);
  }
  if (code !== 0 || !commandExists('cargo', ['--version'])) {
    spin.fail('Installation de Rust impossible');
    return {
      ok: false,
      note: IS_WINDOWS
        ? 'Installez Rust manuellement (https://rustup.rs) puis relancez cette étape.'
        : 'Installez Rust manuellement (https://rustup.rs) puis relancez cette étape.',
    };
  }
  spin.succeed(`Rust installé (cargo ${cargoVersion(env)}).`);
  return { ok: true };
}

async function fetchSource(env) {
  if (fs.existsSync(path.join(MXC_SRC, '.git'))) {
    const spin = spinner('Mise à jour des sources mxc...');
    await run('git', ['-C', MXC_SRC, 'fetch', '--depth', '1', 'origin', 'tag', MXC_TAG], { env, onLine: (l) => spin.update(truncate(l)) }).catch(() => 1);
    const code = await run('git', ['-C', MXC_SRC, 'checkout', '-f', MXC_TAG], { env, onLine: (l) => spin.update(truncate(l)) }).catch(() => 1);
    if (code === 0) { spin.succeed(`Sources mxc à jour (${MXC_TAG}).`); return { ok: true }; }
    spin.fail('Mise à jour des sources mxc impossible'); // fall through to a clean clone
    try { fs.rmSync(MXC_SRC, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  ensureDir(path.dirname(MXC_SRC));
  const spin = spinner(`Clonage de mxc (${MXC_TAG})...`);
  const code = await run('git', ['clone', '--depth', '1', '--branch', MXC_TAG, MXC_REPO, MXC_SRC], {
    env,
    onLine: (line) => spin.update(truncate(line)),
  }).catch(() => 1);
  if (code !== 0) {
    spin.fail('Clonage de mxc impossible');
    return { ok: false, note: 'Clonage du dépôt mxc impossible (réseau ?). Relancez cette étape.' };
  }
  spin.succeed(`Sources mxc récupérées (${MXC_TAG}).`);
  return { ok: true };
}

async function buildBinary(env) {
  const spin = spinner('Construction de mxc (peut prendre plusieurs minutes)...');
  let code;
  if (IS_WINDOWS) {
    code = await run('cmd', ['/c', 'build.bat'], { cwd: MXC_SRC, env, onLine: (l) => spin.update(truncate(l)) }).catch(() => 1);
  } else {
    // --rust-only : on n'utilise que le binaire natif, pas le SDK Node.
    code = await run('bash', ['build-mac.sh', '--rust-only'], { cwd: MXC_SRC, env, onLine: (l) => spin.update(truncate(l)) }).catch(() => 1);
  }
  if (code !== 0) {
    spin.fail('Construction de mxc échouée');
    return { ok: false, note: `La construction de mxc a échoué (code ${code}). La protection reste assurée par les hooks.` };
  }

  const built = findBinary(path.join(MXC_SRC, 'src', 'target')) || findBinary(MXC_SRC);
  if (!built) {
    spin.fail('Binaire mxc introuvable après construction');
    return { ok: false, note: `Binaire ${BIN_NAME} introuvable après construction. Relancez cette étape.` };
  }

  ensureDir(MXC_BIN_DIR);
  const dest = path.join(MXC_BIN_DIR, BIN_NAME);
  fs.copyFileSync(built, dest);
  try { fs.chmodSync(dest, 0o755); } catch { /* Windows ignore les modes POSIX */ }

  // La macOS bundle un proxy sibling (unix-test-proxy) attendu à côté du binaire.
  const siblingProxy = path.join(path.dirname(built), 'unix-test-proxy');
  if (fs.existsSync(siblingProxy)) {
    try { fs.copyFileSync(siblingProxy, path.join(MXC_BIN_DIR, 'unix-test-proxy')); } catch { /* best-effort */ }
  }

  spin.succeed(`Binaire mxc prêt : ${dest}`);
  return { ok: true, path: dest };
}

/** Prove the sandbox actually denies a file (macOS/Linux). Windows has no deniedPaths. */
function enforcementProof(mxcPath, env) {
  if (IS_WINDOWS) return { supported: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-proof-'));
  const secret = path.join(dir, 'canary.txt');
  const token = 'PIECEMAKER_MXC_CANARY_5R7';
  fs.writeFileSync(secret, token, 'utf8');
  const cfg = {
    version: '0.7.0-alpha',
    containment: IS_MAC ? 'seatbelt' : 'process',
    process: { commandLine: `/bin/cat ${secret}`, cwd: dir, timeout: 10000 },
    filesystem: { deniedPaths: [secret] },
    network: { defaultPolicy: 'allow' },
    ...(IS_MAC ? { seatbelt: { launchMethod: 'exec' } } : {}),
  };
  const cfgPath = path.join(dir, 'policy.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  const res = runCapture(mxcPath, [cfgPath], { env });
  const blocked = !`${res.stdout}\n${res.stderr}`.includes(token);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  return { supported: true, blocked };
}

export async function install(ctx) {
  if (!IS_MAC && !IS_WINDOWS) {
    return { status: 'skipped', note: 'Plateforme non prise en charge par cette étape (macOS/Windows).' };
  }
  if (ctx.dryRun) {
    log.info(`[simulation] clonage/build de mxc (${MXC_TAG}) dans ${MXC_SRC}`);
    log.info(`[simulation] binaire copié vers ${path.join(MXC_BIN_DIR, BIN_NAME)}`);
    log.info('[simulation] config.mxcPath + PIECEMAKER_MXC_PATH enregistrés');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const env = buildEnv();

  if (!commandExists('git', ['--version'])) {
    return { status: 'partial', note: 'git introuvable — installez git puis relancez. Protection assurée par les hooks entretemps.' };
  }

  const rust = await ensureRust(env);
  if (!rust.ok) return { status: 'partial', note: rust.note };

  const src = await fetchSource(env);
  if (!src.ok) return { status: 'partial', note: src.note };

  const build = await buildBinary(env);
  if (!build.ok) return { status: 'partial', note: build.note };

  updateConfig({ mxcPath: build.path, mxcEnabled: true });
  writeEnv({ PIECEMAKER_MXC_PATH: build.path });

  const proof = enforcementProof(build.path, env);
  if (proof.supported && !proof.blocked) {
    log.warn("Le binaire mxc n'a pas bloqué le fichier témoin — confinement désactivé par sécurité (repli hooks).");
    updateConfig({ mxcEnabled: false });
    return { status: 'partial', note: 'mxc construit mais le confinement ne bloque pas — désactivé, protection par hooks. Relancez après diagnostic.' };
  }

  log.ok('Confinement OS actif : la session Claude Code du volet isole le venv et les mappings.');
  log.detail('Défense en profondeur — les hooks restent actifs. Désactivable via PIECEMAKER_MXC_DISABLE=1.');
  return { status: proof.supported ? 'done' : 'done', note: proof.supported ? '' : 'Windows : venv + mapping central protégés par omission ; mapping_default reste couvert par les hooks.' };
}

export async function check(ctx) {
  const config = ctx.config || {};
  const binPath = process.env.PIECEMAKER_MXC_PATH || config.mxcPath || path.join(MXC_BIN_DIR, BIN_NAME);
  if (!binPath || !fs.existsSync(binPath)) {
    return { status: 'failed', note: 'Binaire mxc absent — étape optionnelle ; la protection par hooks reste active.' };
  }
  if (config.mxcEnabled === false) {
    return { status: 'partial', note: 'mxc présent mais désactivé (config.mxcEnabled=false).' };
  }
  const proof = enforcementProof(binPath, buildEnv());
  if (proof.supported && !proof.blocked) {
    return { status: 'partial', note: 'mxc présent mais ne bloque pas le fichier témoin — relancez après diagnostic.' };
  }
  return { status: 'done', note: proof.supported ? '' : 'Windows : confinement par liste blanche (mapping_default reste couvert par les hooks).' };
}

/**
 * Step 02 — Node.js dependencies.
 *
 * Runs `npm install` at the repo root and in mcp-server/. Electron is no
 * longer part of the active dependency graph, so package lifecycle scripts
 * can run normally (notably the native node-pty installation).
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner, columns } from '../lib/ui.mjs';
import { run, npmBin, npmEnv, REPO_ROOT } from '../lib/platform.mjs';

export const meta = {
  id: '02-dependances-node',
  label: 'Dépendances Node.js',
  description: 'Installe les modules npm de la racine et du serveur MCP',
};

function truncate(text) {
  const width = Math.max(20, columns() - 6);
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

function readPackageJson(dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Certaines distributions npm conservent spawn-helper de node-pty en 0644.
// Le module se charge alors normalement mais tout pty.spawn échoue avec
// « posix_spawnp failed ». Réparer le bit exécutable est idempotent.
export function repairNodePtySpawnHelpers(repoRoot = REPO_ROOT, { repair = true } = {}) {
  if (process.platform === 'win32') return { found: 0, repaired: 0, ready: true };
  const prebuilds = path.join(repoRoot, 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuilds)) return { found: 0, repaired: 0, ready: false };

  let found = 0;
  let repaired = 0;
  for (const platformArch of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platformArch, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    found += 1;
    const mode = fs.statSync(helper).mode;
    if (repair && (mode & 0o111) === 0) {
      fs.chmodSync(helper, mode | 0o111);
      repaired += 1;
    }
  }
  const currentArchHelper = path.join(prebuilds, `${process.platform}-${process.arch}`, 'spawn-helper');
  const ready = fs.existsSync(currentArchHelper) && (fs.statSync(currentArchHelper).mode & 0o111) !== 0;
  return { found, repaired, ready };
}

async function npmInstall(dir, label, ctx) {
  const pkg = readPackageJson(dir);
  if (!pkg) {
    log.warn(`${label} : aucun package.json trouvé dans ${dir}, étape ignorée`);
    return { code: 0, skipped: true };
  }

  if (ctx.dryRun) {
    log.info(`[simulation] npm install dans ${dir}`);
    return { code: 0, skipped: true };
  }

  const args = ['install'];

  const spin = spinner(`${label} : npm install...`);
  const code = await run(npmBin('npm'), args, {
    cwd: dir,
    env: npmEnv(),
    onLine: (line) => spin.update(truncate(line)),
  });

  if (code === 0) spin.succeed(`${label} : dépendances installées`);
  else spin.fail(`${label} : npm install a échoué (code ${code})`);

  return { code, skipped: false };
}

export async function install(ctx) {
  const results = [];

  results.push(['racine du projet', await npmInstall(REPO_ROOT, 'Racine', ctx)]);
  results.push(['mcp-server/', await npmInstall(path.join(REPO_ROOT, 'mcp-server'), 'mcp-server', ctx)]);

  if (ctx.dryRun) {
    return { status: 'skipped', note: 'Mode simulation — aucune installation effectuée.' };
  }

  const failed = results.filter(([, r]) => !r.skipped && r.code !== 0);
  if (failed.length) {
    const where = failed.map(([label]) => label).join(', ');
    return {
      status: 'failed',
      note: `npm install a échoué pour : ${where}. Vérifiez votre connexion réseau et relancez cette étape.`,
    };
  }

  const ptyHelpers = repairNodePtySpawnHelpers();
  if (!ptyHelpers.ready) {
    return {
      status: 'failed',
      note: 'node-pty est absent ou incomplet : le terminal intégré du volet Word ne peut pas démarrer.',
    };
  }
  if (ptyHelpers.repaired) log.ok(`node-pty : ${ptyHelpers.repaired} lanceur(s) PTY rendu(s) exécutable(s)`);

  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const rootInstalled = fs.existsSync(path.join(REPO_ROOT, 'node_modules'));
  // mcp-server/ currently declares zero dependencies, so `npm install` there
  // never creates node_modules — package-lock.json is the only reliable trace.
  const mcpInstalled = fs.existsSync(path.join(REPO_ROOT, 'mcp-server', 'node_modules'))
    || fs.existsSync(path.join(REPO_ROOT, 'mcp-server', 'package-lock.json'));
  const ptyReady = repairNodePtySpawnHelpers(REPO_ROOT, { repair: false }).ready;

  if (rootInstalled && mcpInstalled && ptyReady) return { status: 'done', note: '' };
  if (rootInstalled || mcpInstalled) {
    return { status: 'partial', note: ptyReady ? 'Dépendances installées pour un seul des deux projets.' : 'node-pty absent ou incomplet.' };
  }
  return { status: 'failed', note: 'node_modules absent — exécutez cette étape.' };
}

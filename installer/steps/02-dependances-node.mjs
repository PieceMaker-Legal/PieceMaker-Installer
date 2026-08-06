/**
 * Step 02 — Node.js dependencies.
 *
 * Runs `npm install` at the repo root and in mcp-server/. The root
 * package.json still has "postinstall": "electron-builder install-app-deps"
 * (Electron is being dropped from this project) — running that script would
 * try to download Electron's native prebuilt binaries for nothing, so we
 * detect it and pass --ignore-scripts, with a warning explaining why.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner, columns } from '../lib/ui.mjs';
import { run, npmBin, REPO_ROOT } from '../lib/platform.mjs';

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

function hasElectronPostinstall(pkg) {
  const post = pkg?.scripts?.postinstall || '';
  return /electron-builder/.test(post);
}

async function npmInstall(dir, label, ctx) {
  const pkg = readPackageJson(dir);
  if (!pkg) {
    log.warn(`${label} : aucun package.json trouvé dans ${dir}, étape ignorée`);
    return { code: 0, skipped: true };
  }

  const ignoreScripts = hasElectronPostinstall(pkg);
  if (ignoreScripts) {
    log.warn(
      `${label} : "postinstall" appelle electron-builder alors qu'Electron est en cours de retrait du projet.`
    );
    log.detail('npm install sera lancé avec --ignore-scripts pour éviter le téléchargement des binaires Electron.');
  }

  if (ctx.dryRun) {
    log.info(`[simulation] npm install${ignoreScripts ? ' --ignore-scripts' : ''} dans ${dir}`);
    return { code: 0, skipped: true };
  }

  const args = ['install'];
  if (ignoreScripts) args.push('--ignore-scripts');

  const spin = spinner(`${label} : npm install...`);
  const code = await run(npmBin('npm'), args, {
    cwd: dir,
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

  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const rootInstalled = fs.existsSync(path.join(REPO_ROOT, 'node_modules'));
  // mcp-server/ currently declares zero dependencies, so `npm install` there
  // never creates node_modules — package-lock.json is the only reliable trace.
  const mcpInstalled = fs.existsSync(path.join(REPO_ROOT, 'mcp-server', 'node_modules'))
    || fs.existsSync(path.join(REPO_ROOT, 'mcp-server', 'package-lock.json'));

  if (rootInstalled && mcpInstalled) return { status: 'done', note: '' };
  if (rootInstalled || mcpInstalled) {
    return { status: 'partial', note: 'Dépendances installées pour un seul des deux projets.' };
  }
  return { status: 'failed', note: 'node_modules absent — exécutez cette étape.' };
}

/**
 * `piecemaker update` — end-to-end against a throwaway origin repository.
 *
 * The CLI is run from inside a clone so REPO_ROOT resolves to the sandbox and
 * nothing touches the developer's own checkout. PIECEMAKER_HOME and the npm
 * prefix are redirected for the same reason.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} : ${result.stderr}`);
  return result.stdout.trim();
}

/** A bare origin, a work clone that publishes to it, and an installed client. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-update-'));
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const client = path.join(dir, 'client');

  git(dir, ['init', '--bare', '-q', origin]);
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'test']);

  fs.cpSync(path.join(root, 'installer'), path.join(work, 'installer'), { recursive: true });
  // Intégrations factices suffisantes pour prouver que `piecemaker update`
  // reconstruit le mapping central et rejoue l'étape 15, sans toucher au Bureau de
  // la machine qui exécute les tests.
  fs.writeFileSync(path.join(work, 'installer', 'steps', '15-pwa-desktop.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
export const meta = { id: '15-pwa-desktop', label: 'PWA factice', required: false };
export async function install() { return { status: 'done' }; }
export async function check() { return { status: 'done' }; }
export function refreshInstalledDesktopApplication() {
  fs.mkdirSync(process.env.PIECEMAKER_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.PIECEMAKER_HOME, 'pwa-update-test'), 'refreshed\\n');
  return { status: 'done', note: 'PWA factice actualisée.' };
}
`);
  fs.mkdirSync(path.join(work, 'piecemaker-plugin', 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(work, 'piecemaker-plugin', 'scripts', 'lib', 'central-mapping.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
module.exports.syncCentralMapping = () => {
  fs.mkdirSync(process.env.PIECEMAKER_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.PIECEMAKER_HOME, 'central-mapping-update-test'), 'rebuilt\\n');
  return { entities: 1 };
};
`);
  fs.writeFileSync(path.join(work, '.gitignore'), 'package-lock.json\nnode_modules/\noutput/*\n');
  fs.writeFileSync(
    path.join(work, 'package.json'),
    JSON.stringify({ name: 'pm-update-test', version: '1.0.0', private: true }) + '\n'
  );
  fs.writeFileSync(path.join(work, 'deprecated.txt'), 'obsolète\n');
  fs.mkdirSync(path.join(work, 'oldir'));
  fs.writeFileSync(path.join(work, 'oldir', 'gone.txt'), 'obsolète\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'v1']);
  git(work, ['branch', '-M', 'main']);
  git(work, ['push', '-q', 'origin', 'main']);
  git(dir, ['clone', '-q', '--branch', 'main', origin, client]);

  return { dir, work, client };
}

function update(client, home) {
  return spawnSync(process.execPath, [path.join(client, 'installer', 'bin', 'piecemaker.mjs'), 'update'], {
    cwd: client,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      PIECEMAKER_HOME: home,
      // A free port keeps probeServer from finding a real PieceMaker server.
      npm_config_prefix: path.join(home, 'npm'),
    },
  });
}

/** Open the real menu over piped stdin while making readline treat it as a TTY. */
function openInstaller(client, home) {
  const cli = path.join(client, 'installer', 'bin', 'piecemaker.mjs');
  const script = `Object.defineProperty(process.stdin, 'isTTY', { value: true }); await import(${JSON.stringify(pathToFileURL(cli).href)});`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: client,
    input: '7\n',
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      PIECEMAKER_HOME: home,
      npm_config_prefix: path.join(home, 'npm'),
    },
  });
}

test('l’ouverture signale immédiatement une MAJ et simplifie le menu principal', () => {
  const { dir, work, client } = sandbox();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 43990 }));

  fs.writeFileSync(path.join(work, 'NOUVELLE_VERSION.md'), 'nouveau\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'nouvelle version']);
  git(work, ['push', '-q', 'origin', 'main']);

  const opened = openInstaller(client, home);
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stdout, /MAJ disponible/);
  assert.match(opened.stdout, /Mettre à jour PieceMaker — MAJ disponible/);
  assert.doesNotMatch(opened.stdout, /Diagnostic complet/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('la mise à jour supprime les fichiers obsolètes et télécharge les nouveaux', () => {
  const { dir, work, client } = sandbox();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 43991 }));

  // Un fichier utilisateur non versionné ne doit jamais bloquer la mise à jour.
  fs.writeFileSync(path.join(client, 'mes-notes.txt'), 'notes\n');

  const upToDate = update(client, home);
  assert.equal(upToDate.status, 0, upToDate.stderr);
  assert.match(upToDate.stdout, /déjà à jour/);
  assert.match(upToDate.stdout, /Mapping central du proxy reconstruit/);
  assert.equal(fs.readFileSync(path.join(home, 'central-mapping-update-test'), 'utf8'), 'rebuilt\n');
  assert.equal(fs.readFileSync(path.join(home, 'pwa-update-test'), 'utf8'), 'refreshed\n');

  git(work, ['rm', '-q', '-r', 'deprecated.txt', 'oldir']);
  fs.mkdirSync(path.join(work, 'newdir'));
  fs.writeFileSync(path.join(work, 'newdir', 'added.txt'), 'nouveau\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'v2']);
  git(work, ['push', '-q', 'origin', 'main']);
  fs.rmSync(path.join(home, 'pwa-update-test'));

  const applied = update(client, home);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /mis à jour/);
  assert.match(applied.stdout, /Mapping central du proxy reconstruit/);
  assert.equal(fs.readFileSync(path.join(home, 'central-mapping-update-test'), 'utf8'), 'rebuilt\n');
  assert.equal(fs.readFileSync(path.join(home, 'pwa-update-test'), 'utf8'), 'refreshed\n');

  assert.equal(fs.existsSync(path.join(client, 'deprecated.txt')), false, 'fichier obsolète non supprimé');
  assert.equal(fs.existsSync(path.join(client, 'oldir')), false, 'dossier obsolète non supprimé');
  assert.equal(fs.existsSync(path.join(client, 'newdir', 'added.txt')), true, 'nouveau fichier non téléchargé');
  assert.equal(fs.existsSync(path.join(client, 'mes-notes.txt')), true, 'fichier utilisateur supprimé');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('la mise à jour fonctionne sur un HEAD détaché, comme après le script d’amorçage', () => {
  const { dir, work, client } = sandbox();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 43992 }));

  git(client, ['checkout', '-q', '--detach', 'HEAD']);
  assert.equal(git(client, ['branch', '--show-current']), '');

  fs.writeFileSync(path.join(work, 'NOUVEAU.md'), 'contenu\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'v2']);
  git(work, ['push', '-q', 'origin', 'main']);

  const applied = update(client, home);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /mis à jour/);
  assert.equal(fs.existsSync(path.join(client, 'NOUVEAU.md')), true);
  assert.equal(git(client, ['rev-parse', 'HEAD']), git(work, ['rev-parse', 'HEAD']));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('les modifications locales suivies sont remplacées par la version distante', () => {
  const { dir, work, client } = sandbox();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 43993 }));

  fs.appendFileSync(path.join(client, 'deprecated.txt'), 'modification locale\n');
  fs.writeFileSync(path.join(work, 'AUTRE.md'), 'contenu\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'v2']);
  git(work, ['push', '-q', 'origin', 'main']);

  const applied = update(client, home);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /mis à jour/);
  assert.equal(fs.readFileSync(path.join(client, 'deprecated.txt'), 'utf8'), 'obsolète\n');
  assert.equal(fs.existsSync(path.join(client, 'AUTRE.md')), true);
  assert.equal(git(client, ['status', '--porcelain', '--untracked-files=no']), '');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('une modification locale est restaurée même sans nouveau commit distant', () => {
  const { dir, client } = sandbox();
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 43994 }));

  fs.appendFileSync(path.join(client, 'deprecated.txt'), 'modification locale\n');

  const applied = update(client, home);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Restauration de l’installation/);
  assert.match(applied.stdout, /mis à jour/);
  assert.equal(fs.readFileSync(path.join(client, 'deprecated.txt'), 'utf8'), 'obsolète\n');
  assert.equal(git(client, ['status', '--porcelain', '--untracked-files=no']), '');

  fs.rmSync(dir, { recursive: true, force: true });
});

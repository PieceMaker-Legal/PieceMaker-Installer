import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MARKETPLACE_NAME,
  PLUGIN_NAME,
  installedPluginEntry,
  pluginContentFingerprint,
  pluginRefreshStatus,
  readPluginVersion,
} from '../installer/lib/plugin-refresh.mjs';

/**
 * These tests exercise the drift-detection this installer relies on to keep
 * ~/.claude/plugins/ in sync — see the module docstring in
 * installer/lib/plugin-refresh.mjs and the auto-memory "Hooks inertes si
 * plugin cache périmé". A version bump alone is the common case; the
 * "content-drift" case below is the one that previously shipped stale hooks
 * silently (a `claude plugin update` that exits 0 without recopying anything).
 */

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePluginDir(dir, { version = '0.1.0', hookContent = 'console.log("hook v1");' } = {}) {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version }, null, 2),
  );
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'protect-originals.mjs'), hookContent);
}

function writeInstalledPlugins(userHome, entries) {
  const dir = path.join(userHome, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [`${PLUGIN_NAME}@${MARKETPLACE_NAME}`]: entries } }, null, 2),
  );
}

test('readPluginVersion lit la version déclarée dans plugin.json', (t) => {
  const dir = makeTmpDir('pm-plugin-version-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePluginDir(dir, { version: '1.2.3' });
  assert.equal(readPluginVersion(dir), '1.2.3');
  assert.equal(readPluginVersion(path.join(dir, 'introuvable')), null);
});

test('pluginContentFingerprint change quand le contenu d’un hook change, pas sinon', (t) => {
  const dir = makeTmpDir('pm-plugin-fingerprint-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePluginDir(dir, { hookContent: 'v1' });
  const first = pluginContentFingerprint(dir);
  assert.equal(pluginContentFingerprint(dir), first, 'stable pour un contenu inchangé');

  fs.writeFileSync(path.join(dir, 'hooks', 'protect-originals.mjs'), 'v2');
  const second = pluginContentFingerprint(dir);
  assert.notEqual(second, first, 'doit changer quand un fichier surveillé change');

  // Un fichier hors des composants chargés par Claude Code (bookkeeping,
  // fichiers de dev) ne doit jamais influencer l'empreinte.
  fs.writeFileSync(path.join(dir, 'NOTES.txt'), 'brouillon local, non versionné');
  assert.equal(pluginContentFingerprint(dir), second, 'ignore les fichiers hors composants du plugin');
});

test('installedPluginEntry retourne l’entrée scope=user, sinon la première', (t) => {
  const userHome = makeTmpDir('pm-installed-entry-');
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));

  assert.equal(installedPluginEntry(userHome), null, 'rien d’installé => null');

  writeInstalledPlugins(userHome, [
    { scope: 'project', projectPath: '/tmp/a', installPath: '/tmp/a-install', version: '0.1.0' },
    { scope: 'user', installPath: '/tmp/user-install', version: '0.2.0' },
  ]);
  assert.equal(installedPluginEntry(userHome).scope, 'user');
  assert.equal(installedPluginEntry(userHome).version, '0.2.0');

  writeInstalledPlugins(userHome, [
    { scope: 'project', projectPath: '/tmp/a', installPath: '/tmp/a-install', version: '0.1.0' },
  ]);
  assert.equal(installedPluginEntry(userHome).scope, 'project', 'à défaut de scope user, prend la première entrée');
});

function scenario() {
  const root = makeTmpDir('pm-plugin-refresh-');
  const pluginDir = path.join(root, 'repo', 'piecemaker-plugin');
  const userHome = path.join(root, 'home');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  return { root, pluginDir, userHome };
}

test('pluginRefreshStatus: not-installed quand aucune entrée n’existe', (t) => {
  const { root, pluginDir, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePluginDir(pluginDir, { version: '0.2.2' });

  const status = pluginRefreshStatus({ pluginDir, userHome });
  assert.equal(status.reason, 'not-installed');
  assert.equal(status.upToDate, false);
  assert.equal(status.repoVersion, '0.2.2');
});

test('pluginRefreshStatus: missing-cache quand l’installPath enregistré n’existe plus sur disque', (t) => {
  const { root, pluginDir, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePluginDir(pluginDir, { version: '0.2.2' });
  writeInstalledPlugins(userHome, [
    { scope: 'user', installPath: path.join(root, 'cache-disparu'), version: '0.2.2' },
  ]);

  const status = pluginRefreshStatus({ pluginDir, userHome });
  assert.equal(status.reason, 'missing-cache');
  assert.equal(status.upToDate, false);
});

test('pluginRefreshStatus: version-mismatch quand la version installée diffère du dépôt', (t) => {
  const { root, pluginDir, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePluginDir(pluginDir, { version: '0.2.2' });
  const cacheDir = path.join(root, 'cache', '0.2.1');
  writePluginDir(cacheDir, { version: '0.2.1' });
  writeInstalledPlugins(userHome, [{ scope: 'user', installPath: cacheDir, version: '0.2.1' }]);

  const status = pluginRefreshStatus({ pluginDir, userHome });
  assert.equal(status.reason, 'version-mismatch');
  assert.equal(status.upToDate, false);
});

test('pluginRefreshStatus: content-drift quand la version est identique mais le contenu diffère (pas de bump)', (t) => {
  const { root, pluginDir, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePluginDir(pluginDir, { version: '0.2.2', hookContent: 'fix applied' });
  const cacheDir = path.join(root, 'cache', '0.2.2');
  // Même version que le dépôt, mais le hook n'a jamais été recopié — le cas
  // exact qui a laissé tourner un hook cassé sans que rien ne s'en aperçoive.
  writePluginDir(cacheDir, { version: '0.2.2', hookContent: 'stale bug' });
  writeInstalledPlugins(userHome, [{ scope: 'user', installPath: cacheDir, version: '0.2.2' }]);

  const status = pluginRefreshStatus({ pluginDir, userHome });
  assert.equal(status.reason, 'content-drift');
  assert.equal(status.upToDate, false);
  assert.notEqual(status.installedFingerprint, status.repoFingerprint);
});

test('pluginRefreshStatus: up-to-date quand version et contenu correspondent', (t) => {
  const { root, pluginDir, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writePluginDir(pluginDir, { version: '0.2.2', hookContent: 'fix applied' });
  const cacheDir = path.join(root, 'cache', '0.2.2');
  writePluginDir(cacheDir, { version: '0.2.2', hookContent: 'fix applied' });
  writeInstalledPlugins(userHome, [{ scope: 'user', installPath: cacheDir, version: '0.2.2' }]);

  const status = pluginRefreshStatus({ pluginDir, userHome });
  assert.equal(status.reason, 'up-to-date');
  assert.equal(status.upToDate, true);
  assert.equal(status.installedFingerprint, status.repoFingerprint);
});

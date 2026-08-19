import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { refreshClaudePlugin, depositRootClaudeMd, ROOT_CLAUDE_MD } from '../installer/lib/service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'installer', 'bin', 'piecemaker.mjs');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startForeignListener(port) {
  const script = [
    "const net = require('node:net');",
    "const server = net.createServer((socket) => socket.destroy());",
    `server.listen(${port}, '127.0.0.1', () => process.send(process.pid));`,
  ].join('');
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.once('message', () => resolve(child));
    child.once('error', reject);
    child.stderr.once('data', (chunk) => reject(new Error(chunk.toString())));
  });
}

test('stop libère le port même si le PID n’est pas géré par PieceMaker', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-unmanaged-server-'));
  const port = await reservePort();
  let listener;

  try {
    listener = await startForeignListener(port);
    const listenerExit = once(listener, 'exit');
    fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ port })}\n`);

    const result = spawnSync(process.execPath, [cli, 'stop'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', PIECEMAKER_HOME: home },
      timeout: 15_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Serveur arrêté/);
    await listenerExit;
    listener = null;

    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(resolve));
    });
  } finally {
    if (listener && listener.exitCode === null) listener.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * refreshClaudePlugin() must never trust "claude plugin update" exited 0 —
 * that command no-ops (still exit 0) when the plugin's declared version
 * hasn't moved, which is exactly what let a broken hook run silently (see
 * installer/lib/plugin-refresh.mjs). This fake `claude` binary lets the tests
 * below drive both outcomes — "the update actually recopied the cache" and
 * "it exited 0 but didn't" — without touching the real ~/.claude installation.
 */
function installFakeClaude(dir, { convergeOnUpdate }) {
  const script = path.join(dir, 'claude');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -e',
      'if [ "$1" = "--version" ]; then echo "2.0.0 (fake)"; exit 0; fi',
      'if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "update" ]; then exit 0; fi',
      'if [ "$1" = "plugin" ] && [ "$2" = "update" ]; then',
      convergeOnUpdate
        ? '  mkdir -p "$FAKE_CLAUDE_INSTALL_PATH"; cp -R "$FAKE_CLAUDE_SOURCE"/. "$FAKE_CLAUDE_INSTALL_PATH"/; exit 0'
        : '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  fs.chmodSync(script, 0o755);
  return script;
}

function pluginRefreshFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-plugin-refresh-svc-'));
  const pluginDir = path.join(root, 'repo', 'piecemaker-plugin');
  const userHome = path.join(root, 'home');
  const cacheDir = path.join(root, 'cache', '0.2.2');
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'piecemaker', version: '0.2.2' }));
  fs.writeFileSync(path.join(pluginDir, 'hooks', 'protect-originals.mjs'), 'fixed');
  fs.mkdirSync(path.join(userHome, '.claude', 'plugins'), { recursive: true });
  return { root, pluginDir, userHome, cacheDir };
}

function writeInstalledEntry(userHome, installPath, version) {
  fs.writeFileSync(
    path.join(userHome, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'piecemaker@piecemaker': [{ scope: 'user', installPath, version }] } }),
  );
}

test(
  'refreshClaudePlugin ne relance aucune commande quand le cache est déjà à jour',
  { skip: process.platform === 'win32' ? 'fake claude binary is a POSIX shell script' : false },
  (t) => {
    const { root, pluginDir, userHome, cacheDir } = pluginRefreshFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'hooks', 'protect-originals.mjs'), 'fixed');
    writeInstalledEntry(userHome, cacheDir, '0.2.2');

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fake-claude-noop-'));
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
    // Any invocation of this stub other than --version fails the test by
    // exiting non-zero — proving refreshClaudePlugin() short-circuits.
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo ok; exit 0; fi\nexit 1\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
    t.after(() => { process.env.PATH = previousPath; });

    const result = refreshClaudePlugin({ pluginDir, userHome });
    assert.equal(result.alreadyUpToDate, true);
    assert.equal(result.converged, true);
    assert.equal(result.ok, true);
  },
);

test(
  'refreshClaudePlugin détecte la convergence après un rafraîchissement réel',
  { skip: process.platform === 'win32' ? 'fake claude binary is a POSIX shell script' : false },
  (t) => {
    const { root, pluginDir, userHome, cacheDir } = pluginRefreshFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // Cache présent, même version, mais contenu périmé (pas de bump côté
    // "marketplace") — exactement le cas qui laissait tourner un hook cassé.
    fs.mkdirSync(path.join(cacheDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'hooks', 'protect-originals.mjs'), 'stale bug');
    writeInstalledEntry(userHome, cacheDir, '0.2.2');

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fake-claude-converge-'));
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
    installFakeClaude(binDir, { convergeOnUpdate: true });
    const previousPath = process.env.PATH;
    const previousSource = process.env.FAKE_CLAUDE_SOURCE;
    const previousInstall = process.env.FAKE_CLAUDE_INSTALL_PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
    process.env.FAKE_CLAUDE_SOURCE = pluginDir;
    process.env.FAKE_CLAUDE_INSTALL_PATH = cacheDir;
    t.after(() => {
      process.env.PATH = previousPath;
      if (previousSource === undefined) delete process.env.FAKE_CLAUDE_SOURCE; else process.env.FAKE_CLAUDE_SOURCE = previousSource;
      if (previousInstall === undefined) delete process.env.FAKE_CLAUDE_INSTALL_PATH; else process.env.FAKE_CLAUDE_INSTALL_PATH = previousInstall;
    });

    const result = refreshClaudePlugin({ pluginDir, userHome });
    assert.equal(result.alreadyUpToDate, false);
    assert.equal(result.converged, true);
    assert.equal(result.refreshed, true);
    assert.equal(fs.readFileSync(path.join(cacheDir, 'hooks', 'protect-originals.mjs'), 'utf8'), 'fixed');
  },
);

test(
  'refreshClaudePlugin signale un cache toujours périmé quand la commande ne recopie rien',
  { skip: process.platform === 'win32' ? 'fake claude binary is a POSIX shell script' : false },
  (t) => {
    const { root, pluginDir, userHome, cacheDir } = pluginRefreshFixture();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cacheDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'hooks', 'protect-originals.mjs'), 'stale bug');
    writeInstalledEntry(userHome, cacheDir, '0.2.2');

    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fake-claude-stuck-'));
    t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
    // convergeOnUpdate: false — mirrors the real bug: "claude plugin update"
    // exits 0 without recopying anything because the version didn't change.
    installFakeClaude(binDir, { convergeOnUpdate: false });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
    t.after(() => { process.env.PATH = previousPath; });

    const result = refreshClaudePlugin({ pluginDir, userHome });
    assert.equal(result.converged, false);
    assert.equal(result.refreshed, false);
    assert.equal(result.ok, true, 'les commandes ont bien réussi (code 0) — seule la convergence a échoué');
    assert.match(result.reason, /cache Claude Code reste périmé/);
  },
);

test(
  'depositRootClaudeMd ne réécrit jamais un CLAUDE.md racine déjà présent ' +
  '(protège les repères d’architecture d’un clone de développement)',
  () => {
    // REPO_ROOT est figé au chargement du module : ce test s’exécute donc sur
    // le vrai CLAUDE.md racine. Il ne teste que la branche « présent → intact »,
    // sûre car non destructive ; la branche « absent → dépôt » supprimerait le
    // fichier réel et n’est pas exercée ici.
    if (!fs.existsSync(ROOT_CLAUDE_MD)) return; // clone sans CLAUDE.md : rien à garantir
    const before = fs.readFileSync(ROOT_CLAUDE_MD, 'utf8');
    const result = depositRootClaudeMd();
    assert.equal(result.status, 'kept');
    assert.equal(fs.readFileSync(ROOT_CLAUDE_MD, 'utf8'), before, 'le fichier ne doit pas être modifié');
  },
);

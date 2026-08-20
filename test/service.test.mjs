import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { depositRootClaudeMd, ROOT_CLAUDE_MD } from '../installer/lib/service.mjs';

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

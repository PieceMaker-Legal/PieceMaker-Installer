import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

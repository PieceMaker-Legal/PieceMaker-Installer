import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'installer', 'bin', 'piecemaker.mjs');

test('la CLI documente les commandes du serveur et de l’interface web', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /open\s+démarre le serveur/);
  assert.match(result.stdout, /restart\s+redémarre le serveur/);
  assert.match(result.stdout, /chronology\s+affiche la chronologie pseudonymisée/);
  assert.match(result.stdout, /install\s+ouvre le menu/);
  assert.match(result.stdout, /doctor, check/);
});

test('une commande inconnue échoue avec une aide exploitable', () => {
  const result = spawnSync(process.execPath, [cli, 'inconnue'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /commande inconnue/i);
});

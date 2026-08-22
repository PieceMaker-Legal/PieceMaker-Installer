import assert from 'node:assert/strict';
import test from 'node:test';
import { ensurePieceMakerServer } from '../mcp-server/ensure-piecemaker-server.mjs';

test('ne redémarre pas le serveur lorsque /health répond déjà', async () => {
  let starts = 0;
  const result = await ensurePieceMakerServer('https://localhost:43098', {
    fetchImpl: async () => ({ ok: true }),
    startServer: async () => { starts += 1; },
  });
  assert.deepEqual(result, { ready: true, started: false });
  assert.equal(starts, 0);
});

test('démarre automatiquement PieceMaker au premier open_doc', async () => {
  let healthy = false;
  let starts = 0;
  const result = await ensurePieceMakerServer('https://localhost:43098', {
    fetchImpl: async () => ({ ok: healthy }),
    startServer: async () => { starts += 1; healthy = true; },
  });
  assert.deepEqual(result, { ready: true, started: true });
  assert.equal(starts, 1);
});

test('explique explicitement un échec de démarrage automatique', async () => {
  await assert.rejects(
    ensurePieceMakerServer('https://localhost:43098', {
      fetchImpl: async () => { throw new Error('connexion refusée'); },
      startServer: async () => { throw new Error('certificats HTTPS absents'); },
    }),
    /démarrage automatique impossible.*certificats HTTPS absents/i,
  );
});

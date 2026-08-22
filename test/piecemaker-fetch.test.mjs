import assert from 'node:assert/strict';
import test from 'node:test';

import { pieceMakerHttpsAgent } from '../mcp-server/piecemaker-fetch.mjs';

test('le certificat auto-signé n’est toléré que pour HTTPS en loopback', () => {
  const localAgent = pieceMakerHttpsAgent('https://localhost:43098/health');

  assert.ok(localAgent);
  assert.equal(localAgent.options.rejectUnauthorized, false);
  assert.equal(pieceMakerHttpsAgent('https://127.0.0.42:43098/health'), localAgent);
  assert.equal(pieceMakerHttpsAgent('https://[::1]:43098/health'), localAgent);
  assert.equal(pieceMakerHttpsAgent('http://localhost:43098/health'), undefined);
  assert.equal(pieceMakerHttpsAgent('https://piecemaker.example/health'), undefined);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
});

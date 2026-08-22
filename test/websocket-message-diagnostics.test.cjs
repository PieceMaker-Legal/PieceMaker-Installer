'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  describeUnknownWebSocketMessage,
  isWordToolResponse,
} = require('../websocket-server/lib/websocket-message-diagnostics.cjs');

test('reconnaît les réponses Word attendues sans exiger de type WebSocket', () => {
  assert.equal(isWordToolResponse({ requestId: '42', result: { ok: true } }), true);
  assert.equal(isWordToolResponse({ requestId: '43', error: 'échec Word' }), true);
  assert.equal(isWordToolResponse({ requestId: '44' }), false);
});

test('décrit les vrais messages inconnus avec leur type ou leur identifiant', () => {
  assert.deepEqual(
    describeUnknownWebSocketMessage({ type: 'nouveau-message', payload: true }),
    { type: 'nouveau-message', requestId: '(absent)', keys: ['payload', 'type'] }
  );
  assert.deepEqual(
    describeUnknownWebSocketMessage({ requestId: 'orphelin', payload: true }),
    { type: '(absent)', requestId: 'orphelin', keys: ['payload', 'requestId'] }
  );
});

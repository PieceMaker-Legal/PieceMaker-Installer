import assert from 'node:assert/strict';
import test from 'node:test';

import { check, meta } from '../installer/steps/00-identite.mjs';

test('l’identification est une étape dédiée de l’installateur', async () => {
  assert.equal(meta.id, '00-identite');
  assert.match(meta.description, /Signe chaque tâche/);
  assert.deepEqual(await check({ env: { PIECEMAKER_USER_NAME: 'Alice Martin' } }), {
    status: 'done',
    note: 'Alice Martin',
  });
  assert.equal((await check({ env: {} })).status, 'partial');
});

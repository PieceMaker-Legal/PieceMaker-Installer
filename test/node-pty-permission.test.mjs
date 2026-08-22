import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repairNodePtySpawnHelpers } from '../installer/steps/02-dependances-node.mjs';

test('l’installateur répare le lanceur node-pty non exécutable', (t) => {
  if (process.platform === 'win32') return t.skip('mode POSIX absent sous Windows');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-node-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, 'helper', { mode: 0o644 });

  assert.deepEqual(repairNodePtySpawnHelpers(root), { found: 1, repaired: 1, ready: true });
  assert.notEqual(fs.statSync(helper).mode & 0o111, 0);
  assert.deepEqual(repairNodePtySpawnHelpers(root), { found: 1, repaired: 0, ready: true });
});

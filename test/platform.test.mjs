import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { IS_WINDOWS, npmBin, runCapture } from '../installer/lib/platform.mjs';

test('npm utilise le même environnement Node que PieceMaker', (t) => {
  if (IS_WINDOWS) {
    t.skip('le lanceur factice de ce test est spécifique aux systèmes POSIX');
    return;
  }

  const adjacent = path.join(path.dirname(process.execPath), 'npm');
  if (!fs.existsSync(adjacent)) {
    t.skip('cette distribution Node ne fournit pas npm à côté du binaire');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-fake-node-'));
  const fakeNode = path.join(dir, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/sh\nexit 64\n', { mode: 0o755 });

  try {
    assert.equal(npmBin(), adjacent);
    const result = runCapture(npmBin(), ['--version'], {
      env: { ...process.env, PATH: dir },
    });
    assert.equal(result.code, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /^\d+\.\d+\.\d+/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

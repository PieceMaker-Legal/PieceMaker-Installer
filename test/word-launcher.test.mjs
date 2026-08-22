import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { showTaskpaneForDocument } = require('../websocket-server/lib/word-launcher.cjs');

test('le fallback macOS cible le document complet et le bouton du manifeste unique', () => {
  const documentPath = fileURLToPath(import.meta.url);
  let invocation;
  const result = showTaskpaneForDocument(documentPath, {
    platform: 'darwin',
    spawnSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: 'clicked\n', stderr: '' };
    },
  });

  assert.deepEqual(result, { shown: true, method: 'ribbon-applescript' });
  assert.equal(invocation.command, 'osascript');
  assert.deepEqual(invocation.args.slice(-3), ['--', documentPath, 'Ouvrir PieceMaker']);
  assert.match(invocation.args[1], /every document whose full name is targetHfsPath/);
  assert.match(invocation.args[1], /repeat 20 times/);
  assert.match(invocation.args[1], /repeat with ribbonGroup in every group/);
  assert.equal(invocation.options.timeout, 10000);
});

test('le fallback Word ne lance aucune automatisation hors macOS', () => {
  let called = false;
  const result = showTaskpaneForDocument(fileURLToPath(import.meta.url), {
    platform: 'win32',
    spawnSyncImpl() {
      called = true;
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { shown: false, method: 'unsupported' });
  assert.equal(called, false);
});

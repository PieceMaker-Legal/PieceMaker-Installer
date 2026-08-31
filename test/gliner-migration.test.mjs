import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  glinerDownloadQuestion,
  glinerInstallState,
  parseWarmupStatus,
} from '../installer/steps/03-python-gliner.mjs';

const PREFERRED = 'fastino/gliner2.5-multi-v1';
const LEGACY = 'fastino/gliner2-multi-v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('le statut warmup reste lisible même si la commande sort 1 pendant la migration', () => {
  const status = parseWarmupStatus({
    code: 1,
    stdout: JSON.stringify({
      ready: false,
      migration: {
        preferred_model_id: PREFERRED,
        preferred_cached: false,
        cached_legacy_model_ids: [LEGACY],
      },
    }),
  });

  assert.equal(status.ready, false);
  assert.deepEqual(status.migration.cached_legacy_model_ids, [LEGACY]);
});

test('un ancien checkpoint sans GLiNER2.5 impose son remplacement', () => {
  const state = glinerInstallState({
    models: { gliner2: { cached: false } },
    migration: {
      preferred_model_id: PREFERRED,
      preferred_cached: false,
      cached_legacy_model_ids: [LEGACY],
    },
  });

  assert.equal(state.replacementRequired, true);
  assert.equal(state.preferredModelId, PREFERRED);
  assert.deepEqual(state.legacyModels, [LEGACY]);
  assert.match(glinerDownloadQuestion(state), /remplace obligatoirement/);
  assert.match(glinerDownloadQuestion(state), /1,1 Go/);
});

test('GLiNER2.5 en cache satisfait la migration même si l’ancien cache subsiste', () => {
  const state = glinerInstallState({
    models: { gliner2: { cached: true } },
    migration: {
      preferred_model_id: PREFERRED,
      preferred_cached: true,
      cached_legacy_model_ids: [LEGACY],
    },
  });

  assert.equal(state.preferredCached, true);
  assert.equal(state.replacementRequired, false);
});

test('une installation neuve cible directement GLiNER2.5', () => {
  const state = glinerInstallState(null);
  assert.equal(state.preferredModelId, PREFERRED);
  assert.equal(state.preferredCached, false);
  assert.equal(state.replacementRequired, false);
  assert.match(glinerDownloadQuestion(state), /gliner2\.5/i);
});

test('les scanners utilisent AutoExtractor sans téléchargement implicite', () => {
  for (const relative of [
    'websocket-server/scripts/presidio-gliner/presidio-gliner.py',
    'websocket-server/scripts/presidio-gliner/scanner_worker.py',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /from gliner2 import AutoExtractor/);
    assert.match(source, /AutoExtractor\.from_pretrained\([\s\S]*?local_files_only=True/);
    assert.doesNotMatch(source, /from gliner2 import GLiNER2/);
  }
});

test('les deux points d’entrée GLiNER2.5 conservent le découpage Fastino des longs documents', () => {
  for (const relative of [
    'websocket-server/scripts/presidio-gliner/presidio-gliner.py',
    'websocket-server/scripts/presidio-gliner/scanner_worker.py',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(source, /^CHUNK_SIZE\s*=\s*384\b/m, `${relative} doit utiliser des chunks de 384 mots`);
    assert.match(source, /^CHUNK_OVERLAP\s*=\s*64\b/m, `${relative} doit utiliser un recouvrement de 64 mots`);
  }
});

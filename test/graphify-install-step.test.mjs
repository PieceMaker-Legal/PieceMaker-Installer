import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  entityMetadataProbeFixture,
  check,
  graphifyReleaseState,
  graphifyRequirement,
  probeGraphifyEntityMetadata,
  validateEntityMetadataProbeGraph,
} from '../installer/steps/03b-python-graphify.mjs';

test('la livraison Graphify est explicitement bloquée sans tag inventé', () => {
  const release = graphifyReleaseState();
  assert.equal(release.state, 'blocked');
  assert.equal(release.code, 'graphify_fork_tag_unresolved');
  assert.equal(release.tag, null);
  assert.equal(graphifyRequirement(), null);
  assert.doesNotMatch(JSON.stringify(release), /REPLACE_WITH_PUBLISHED_TAG/);
});

test('le diagnostic retourne un état bloqué typé sans venv ni tag publiable', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-doctor-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const result = await check({ config: { graphifyVenvPath: path.join(temporary, 'absent') } });
  assert.equal(result.status, 'partial');
  assert.equal(result.code, 'graphify_fork_tag_unresolved');
  assert.equal(result.blocked.state, 'blocked');
  assert.match(result.note, /probe entity_metadata est impossible/);
});

test('le probe --code-only exige la propagation complète de entity_metadata', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-step-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  let args;
  let options;
  const result = probeGraphifyEntityMetadata('/venv/bin/graphify', {
    temporaryDirectory: temporary,
    runCaptureFn: (_command, receivedArgs, receivedOptions) => {
      args = receivedArgs;
      options = receivedOptions;
      const output = receivedArgs[receivedArgs.indexOf('--out') + 1];
      const fixture = entityMetadataProbeFixture();
      fs.mkdirSync(path.join(output, 'graphify-out'), { recursive: true });
      fs.writeFileSync(path.join(output, 'graphify-out', 'graph.json'), JSON.stringify({
        nodes: [{
          label: fixture.code,
          ...fixture.mapping.entity_metadata[fixture.code],
        }],
      }));
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.ok(args.includes('--code-only'));
  assert.ok(args.includes('--no-cluster'));
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.GRAPHIFY_MODEL, undefined);
});

test('le probe refuse une sortie qui ne propage qu’une partie des métadonnées', () => {
  const fixture = entityMetadataProbeFixture();
  const result = validateEntityMetadataProbeGraph({
    nodes: [{ label: fixture.code, entity_type: 'personne' }],
  }, fixture);
  assert.equal(result.ok, false);
  assert.match(result.reason, /procedural_role/);
});

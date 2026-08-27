const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LEGAL_FINALIZER_VERSION,
  LEGAL_INTEGRATION_VERSION,
  LEGAL_PROMPT_VERSION,
  SemanticRefreshRequiredError,
  buildLegalGraph,
  legalGraphPaths,
  legalGraphStatus,
  queryLegalGraph,
  rematerializeDeterministicLegalGraph,
} = require('../websocket-server/legal-graph.cjs');
const {
  applyDocumentIndexCorrection,
  documentIndexFile,
} = require('../websocket-server/document-index.cjs');
const {
  markFilesAnonymized,
  stateKey,
} = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-etats-graphe-'));
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  const relativePath = 'Assignation.pdf';
  const original = path.join(caseRoot, relativePath);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(original, 'ORIGINAL');
  fs.writeFileSync(path.join(workspace, 'Assignation.md'), 'PERSONNE_PHYSIQUE_01 demande paiement.');
  markFilesAnonymized(caseRoot, [original], '2026-08-27T00:00:00Z');
  writeJson(path.join(workspace, 'mapping_default.json'), {
    mapping: { 'Alice Martin': 'PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Alice Martin'] },
    informations_dossier: {
      parties_clientes: [{
        type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin',
      }],
      parties_adverses: [],
    },
  });
  writeJson(documentIndexFile(caseRoot), {
    version: 2,
    documents: {
      [stateKey(relativePath)]: {
        nature: 'assignation',
        doc_date_iso: '2024-01-02',
        juridiction: 'Tribunal judiciaire de Paris',
        codes: ['PERSONNE_PHYSIQUE_01'],
      },
    },
    overrides: {},
    entityDecisions: {},
    revisions: [],
  });
  return { caseRoot, relativePath, workspace };
}

function attestPrompt(options) {
  const prompt = fs.readFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT);
  fs.writeFileSync(
    options.env.PIECEMAKER_GRAPHIFY_LEGAL_MARKER,
    crypto.createHash('sha256').update(prompt).digest('hex'),
  );
}

function extractionRunner({ observeBuilding = null, fail = false } = {}) {
  return async (_command, args, options) => {
    if (observeBuilding) observeBuilding();
    if (fail) throw new Error('échec Graphify simulé');
    attestPrompt(options);
    const corpus = args[1];
    const sourceFile = fs.readdirSync(corpus).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const output = args[args.indexOf('--out') + 1];
    writeJson(path.join(output, 'graphify-out', 'graph.json'), {
      nodes: [
        { id: 'document_brut', label: 'Document', file_type: 'document', source_file: sourceFile },
        {
          id: 'partie_brute', label: 'PERSONNE_PHYSIQUE_01', file_type: 'concept',
          legal_kind: 'personne', source_file: sourceFile,
        },
        {
          id: 'demande_semantique', label: 'Demande de paiement', file_type: 'concept',
          legal_kind: 'demande', assertion_status: 'ALLEGUE', source_file: sourceFile,
        },
      ],
      edges: [{
        source: 'partie_brute', target: 'demande_semantique', relation: 'demande',
        assertion_status: 'ALLEGUE', source_file: sourceFile,
      }],
      hyperedges: [],
    });
  };
}

test('le manifeste expose tout le cycle missing/building/current/stale/failed sans requête LLM implicite', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const paths = legalGraphPaths(data.caseRoot);

  const missing = await legalGraphStatus(data.caseRoot);
  assert.equal(missing.staticState, 'missing');
  assert.equal(missing.semanticState, 'missing');

  let building;
  const built = await buildLegalGraph(data.caseRoot, {
    command: 'graphify-test',
    runner: extractionRunner({
      observeBuilding: () => { building = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')); },
    }),
  });
  assert.equal(building.semanticState, 'building');
  assert.equal(built.semanticState, 'current');
  const initialManifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  assert.equal(initialManifest.staticState, 'current');
  assert.equal(initialManifest.semanticState, 'current');
  assert.equal(initialManifest.semanticBaseRevision, initialManifest.staticRevision);
  assert.equal(initialManifest.legalPromptVersion, LEGAL_PROMPT_VERSION);
  assert.equal(initialManifest.legalIntegrationVersion, LEGAL_INTEGRATION_VERSION);
  assert.equal(initialManifest.legalFinalizerVersion, LEGAL_FINALIZER_VERSION);

  // Juridiction et champs libres modifient la couche statique mais pas les
  // entrées sémantiques (date/nature identiques).
  const displayMutation = applyDocumentIndexCorrection(data.caseRoot, data.relativePath, {
    nature: 'assignation',
    dateIso: '2024-01-02',
    juridiction: 'Cour d’appel de Paris',
    fields: [{ label: 'Cote', value: 'A-1' }],
  });
  const displayOnly = await rematerializeDeterministicLegalGraph(data.caseRoot, {
    semanticStaleReasons: displayMutation.semanticStaleReasons,
  });
  assert.equal(displayOnly.semanticState, 'current');
  assert.ok(displayOnly.staticRevision > initialManifest.staticRevision);
  assert.equal(displayOnly.semanticBaseRevision, initialManifest.semanticBaseRevision);

  const dateMutation = applyDocumentIndexCorrection(data.caseRoot, data.relativePath, {
    nature: 'assignation',
    dateIso: '2024-02-03',
    juridiction: 'Cour d’appel de Paris',
    fields: [{ label: 'Cote', value: 'A-1' }],
  });
  const stale = await rematerializeDeterministicLegalGraph(data.caseRoot, {
    semanticStaleReasons: dateMutation.semanticStaleReasons,
  });
  assert.equal(stale.semanticState, 'stale');
  assert.deepEqual(stale.semanticStaleReasons, ['date_changed']);

  let queryCalls = 0;
  await assert.rejects(
    queryLegalGraph(data.caseRoot, 'Quelle est la demande ?', {
      runnerQuery: async () => { queryCalls += 1; },
    }),
    (error) => error instanceof SemanticRefreshRequiredError
      && error.code === 'semantic_refresh_required'
      && error.semanticState === 'stale',
  );
  assert.equal(queryCalls, 0);

  await assert.rejects(
    buildLegalGraph(data.caseRoot, {
      force: true,
      command: 'graphify-test',
      runner: extractionRunner({ fail: true }),
    }),
    /échec Graphify simulé/,
  );
  const failed = await legalGraphStatus(data.caseRoot);
  assert.equal(failed.semanticState, 'failed');
  assert.ok(failed.semanticStaleReasons.includes('semantic_build_failed'));

  const refreshedQuery = await queryLegalGraph(data.caseRoot, 'Actualiser puis répondre', {
    refreshSemantic: true,
    command: 'graphify-test',
    runner: extractionRunner(),
    runnerQuery: async () => ({ stdout: 'NODE Demande de paiement [src=piece.md loc= community=]\n' }),
  });
  assert.equal(refreshedQuery.semanticState, 'current');
  assert.deepEqual(refreshedQuery.semanticStaleReasons, []);
  assert.match(refreshedQuery.output, /Demande de paiement/);
});

test('un changement de frontière met le snapshot en quarantaine et bloque toute requête', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const paths = legalGraphPaths(data.caseRoot);
  await buildLegalGraph(data.caseRoot, {
    command: 'graphify-test',
    runner: extractionRunner(),
  });

  const mutation = applyDocumentIndexCorrection(data.caseRoot, data.relativePath, {
    nature: 'assignation',
    dateIso: '2024-01-02',
    juridiction: 'Tribunal judiciaire de Paris',
    fields: [],
    entityDecisions: { additions: [], exclusions: ['PERSONNE_PHYSIQUE_01'] },
  });
  const quarantined = await rematerializeDeterministicLegalGraph(data.caseRoot, {
    semanticStaleReasons: mutation.semanticStaleReasons,
  });

  assert.equal(quarantined.semanticState, 'blocked');
  assert.equal(quarantined.semanticQuarantined, true);
  assert.ok(quarantined.semanticStaleReasons.includes('no_party_documents'));
  const graph = JSON.parse(fs.readFileSync(paths.graph, 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(paths.semanticGraph, 'utf8'));
  assert.ok(!graph.nodes.some((node) => node.id === 'demande_semantique'));
  assert.ok(snapshot.graph.nodes.some((node) => node.id === 'demande_semantique'));
  assert.equal(JSON.parse(fs.readFileSync(paths.manifest, 'utf8')).semanticSnapshot.signature,
    snapshot.signature);

  await assert.rejects(
    queryLegalGraph(data.caseRoot, 'Quelle est la demande ?'),
    (error) => error.code === 'semantic_refresh_required'
      && error.semanticState === 'blocked'
      && error.semanticQuarantined === true,
  );
});

test('le statut détecte un corpus modifié sans lancer Graphify ni masquer un périmètre inchangé', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let extractionCalls = 0;
  const runner = extractionRunner();
  await buildLegalGraph(data.caseRoot, {
    command: 'graphify-test',
    runner: async (...args) => { extractionCalls += 1; return runner(...args); },
  });
  fs.appendFileSync(path.join(data.workspace, 'Assignation.md'), '\nFait nouveau pseudonymisé.');

  const status = await legalGraphStatus(data.caseRoot);

  assert.equal(extractionCalls, 1, 'GET/status ne doit jamais relancer Graphify');
  assert.equal(status.semanticState, 'stale');
  assert.equal(status.semanticQuarantined, false);
  assert.ok(status.semanticStaleReasons.includes('semantic_corpus_changed'));
  const graph = JSON.parse(fs.readFileSync(legalGraphPaths(data.caseRoot).graph, 'utf8'));
  assert.ok(graph.nodes.some((node) => node.id === 'demande_semantique'));
});

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyDocumentIndexCorrection,
  buildChronology,
  documentIndexFile,
  readDocumentIndex,
} = require('../websocket-server/document-index.cjs');
const {
  buildLegalGraph,
  legalGraphPaths,
  rematerializeDeterministicLegalGraph,
} = require('../websocket-server/legal-graph.cjs');
const {
  applyDocumentMetaMutation,
} = require('../websocket-server/admin-routes.cjs');
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
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-corrections-'));
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  const relativePath = 'Assignation Alice.pdf';
  const original = path.join(caseRoot, relativePath);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(original, 'ORIGINAL');
  fs.writeFileSync(path.join(workspace, 'Assignation Alice.md'), 'PERSONNE_PHYSIQUE_01 réclame paiement.');
  markFilesAnonymized(caseRoot, [original], '2026-08-27T00:00:00Z');
  writeJson(path.join(workspace, 'mapping_default.json'), {
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
      'Gamma GmbH': 'GMBH_2',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
      GMBH_2: ['Gamma GmbH'],
    },
    informations_dossier: {
      parties_clientes: [{
        type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin',
      }],
      parties_adverses: [],
    },
  });
  writeJson(documentIndexFile(caseRoot), {
    version: 1,
    documents: {
      [stateKey(relativePath)]: {
        nature: 'assignation',
        nature_confidence: 0.9,
        doc_date: '2 janvier 2024',
        doc_date_iso: '2024-01-02',
        juridiction: 'Tribunal judiciaire de Paris',
        codes: ['PERSONNE_PHYSIQUE_01', 'SAS_1'],
      },
    },
  });
  return { caseRoot, original, relativePath };
}

function attestPrompt(options) {
  const crypto = require('node:crypto');
  const prompt = fs.readFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT);
  fs.writeFileSync(
    options.env.PIECEMAKER_GRAPHIFY_LEGAL_MARKER,
    crypto.createHash('sha256').update(prompt).digest('hex'),
  );
}

test('une correction manuelle reste effective en mode pseudonymisé avec provenance, révisions et décisions locales', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));

  const mutation = applyDocumentIndexCorrection(data.caseRoot, data.relativePath, {
    nature: 'Lettre de Alice Martin',
    dateIso: '2024-02-03',
    juridiction: 'Audience concernant Alice Martin',
    fields: [{ label: 'Contact', value: 'Alice Martin' }],
    entityDecisions: { exclusions: ['SAS_1'], additions: ['GMBH_2'] },
    reason: 'Correction après contrôle de la pièce',
  }, { now: () => new Date('2026-08-27T12:00:00Z') });

  assert.deepEqual(mutation.revisions, [1, 2, 3, 4, 5]);
  assert.deepEqual(mutation.semanticStaleReasons, [
    'nature_changed', 'date_changed', 'document_entities_changed',
  ]);
  const stored = readDocumentIndex(data.caseRoot);
  assert.equal(stored.version, 2);
  assert.equal(stored.revisions.length, 5);
  assert.equal(stored.revisions[0].detectedValue, 'assignation');
  assert.equal(stored.revisions[0].previousEffectiveValue, 'assignation');
  assert.equal(stored.revisions[0].newValue, 'Lettre de Alice Martin');
  assert.equal(stored.revisions[0].source, 'admin_manual');
  assert.equal(stored.revisions[0].semanticImpact, 'refresh_required');

  const chronology = await buildChronology(data.caseRoot, {
    deanonymizeLabels: false,
    includeManualDecisions: true,
  });
  const document = chronology.documents[0];
  assert.equal(document.nature, 'Lettre de PERSONNE_PHYSIQUE_01');
  assert.equal(document.juridiction, 'Audience concernant PERSONNE_PHYSIQUE_01');
  assert.deepEqual(document.fields, [{ label: 'Contact', value: 'PERSONNE_PHYSIQUE_01' }]);
  assert.equal(document.metadata.dateIso.detected, '2024-01-02');
  assert.equal(document.metadata.dateIso.effective, '2024-02-03');
  assert.equal(document.metadata.dateIso.source, 'admin_manual');
  assert.equal(document.editRevision, 5);
  assert.deepEqual(document.detectedCodes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
  assert.deepEqual(document.effectiveCodes, ['GMBH_2', 'PERSONNE_PHYSIQUE_01']);
  assert.deepEqual(document.entityDecisions, { additions: ['GMBH_2'], exclusions: ['SAS_1'] });
  assert.ok(document.qualityFlags.every((flag) => flag.type === 'MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION'));
  assert.doesNotMatch(JSON.stringify(document), /Alice Martin/);

  const rawDetection = await buildChronology(data.caseRoot, {
    deanonymizeLabels: false,
    includeManualDecisions: false,
  });
  assert.equal(rawDetection.documents[0].dateIso, '2024-01-02');
  assert.deepEqual(rawDetection.documents[0].effectiveCodes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
});

test('la rematérialisation réutilise le snapshot et met date, précédence et flags à jour sans Graphify', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const secondRelativePath = 'Note intermédiaire.pdf';
  fs.writeFileSync(path.join(data.caseRoot, secondRelativePath), 'ORIGINAL 2');
  const index = readDocumentIndex(data.caseRoot);
  index.documents[stateKey(secondRelativePath)] = {
    nature: 'note', nature_confidence: 1, doc_date: '1er février 2024',
    doc_date_iso: '2024-02-01', juridiction: null, codes: [], updatedAt: null,
  };
  writeJson(documentIndexFile(data.caseRoot), index);
  let graphifyCalls = 0;
  await buildLegalGraph(data.caseRoot, {
    command: 'graphify-test',
    runner: async (_command, args, options) => {
      graphifyCalls += 1;
      attestPrompt(options);
      const corpus = args[1];
      const sourceFile = fs.readdirSync(corpus).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
      const output = args[args.indexOf('--out') + 1];
      writeJson(path.join(output, 'graphify-out', 'graph.json'), {
        nodes: [{ id: 'document_brut', label: 'Document', file_type: 'document', source_file: sourceFile }],
        edges: [],
        hyperedges: [],
      });
    },
  });

  const mutation = applyDocumentIndexCorrection(data.caseRoot, data.relativePath, {
    nature: 'mise en demeure',
    dateIso: '2024-03-04',
    juridiction: 'Tribunal judiciaire de Paris',
    fields: [{ label: 'Cote', value: 'A-1' }],
  });
  const materialized = await rematerializeDeterministicLegalGraph(data.caseRoot, {
    semanticStaleReasons: mutation.semanticStaleReasons,
  });

  assert.equal(graphifyCalls, 1, 'seule la construction initiale doit invoquer Graphify');
  assert.equal(materialized.semanticState, 'stale');
  const files = legalGraphPaths(data.caseRoot);
  const graph = JSON.parse(fs.readFileSync(files.graph, 'utf8'));
  const node = graph.nodes.find((entry) => entry.document_key === stateKey(data.relativePath));
  assert.equal(node.date_iso, '2024-03-04');
  assert.equal(node.nature, 'mise en demeure');
  assert.equal(node.juridiction, 'Tribunal judiciaire de Paris');
  assert.equal(node.edit_revision, 4);
  assert.ok(node.quality_flags.some((flag) => flag.field === 'dateIso'));
  assert.ok(graph.edges.some((edge) =>
    edge.relation === 'precede'
    && edge.source === `piece_${stateKey(secondRelativePath)}`
    && edge.target === `piece_${stateKey(data.relativePath)}`));
  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
  assert.equal(manifest.staticState, 'current');
  assert.equal(manifest.semanticState, 'stale');
  assert.ok(manifest.semanticSnapshot);
});

test('la couture admin persiste, rematérialise puis écrit un historique ciblé', async () => {
  const calls = [];
  const result = await applyDocumentMetaMutation({
    legalCase: { root: '/dossier', casesRoot: '/', caseName: 'dossier' },
    relativePath: 'Pièce.pdf',
    correction: { dateIso: '2024-02-02' },
    homeDir: '/historique',
    envFile: '/repo/.env',
    applyCorrection: () => {
      calls.push('persist');
      return {
        documentKey: 'a'.repeat(64), override: {}, entityDecisions: {},
        revisions: [1], editRevision: 1, semanticStaleReasons: ['date_changed'],
      };
    },
    rematerialize: async (_root, options) => {
      calls.push(`graph:${options.semanticStaleReasons[0]}`);
      return {
        graphFile: '/dossier/.piecemaker/graphify/legal/graphify-out/graph.json',
        staticRevision: 1,
        semanticState: 'stale',
        semanticStaleReasons: options.semanticStaleReasons,
      };
    },
    createHistoryCommit: async (options) => {
      calls.push(`history:${options.paths[0]}`);
      return { created: true, commit: 'abc123' };
    },
  });
  assert.deepEqual(calls, [
    'persist',
    'graph:date_changed',
    'history:.piecemaker/document-index.json',
  ]);
  assert.equal(result.history.hash, 'abc123');
});

test('le pipeline Python préserve décisions et révisions lors du rechargement avant rescan', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-index-python-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const index = path.join(temporary, 'document-index.json');
  const original = path.join(temporary, 'Pièce.pdf');
  fs.writeFileSync(original, 'ORIGINAL');
  const key = stateKey('Pièce.pdf');
  writeJson(index, {
    version: 2,
    documents: { [key]: { nature: 'assignation' } },
    overrides: { [key]: { nature: 'requête' } },
    entityDecisions: { [key]: { additions: ['SAS_1'], exclusions: [] } },
    revisions: [{ revision: 1, documentKey: key, field: 'nature' }],
  });
  const script = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("pipeline",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'record={"source":sys.argv[4],"entities":{},"document_meta":{"nature":"conclusions"}}',
    'module.write_document_index(module.Path(sys.argv[2]),sys.argv[3],[record],{"mapping":{}})',
    'print(json.dumps(module.load_document_index(module.Path(sys.argv[2]))))',
  ].join(';');
  const output = execFileSync('python3', [
    '-c', script,
    path.join(__dirname, '..', 'websocket-server', 'scripts', 'convert_and_scan_pipeline.py'),
    index,
    temporary,
    original,
  ], { encoding: 'utf8' });
  const loaded = JSON.parse(output);
  assert.deepEqual(loaded.entityDecisions, {
    [key]: { additions: ['SAS_1'], exclusions: [] },
  });
  assert.equal(loaded.revisions[0].revision, 1);
  assert.equal(loaded.documents[key].nature, 'conclusions');
  assert.equal(loaded.version, 2);
});

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLegalGraph,
  deanonymizeLegalGraphForAdmin,
  legalGraphPaths,
  legalGraphStatus,
  legalTopology,
  queryLegalGraph,
  renderLegalGraphViewer,
} = require('../websocket-server/legal-graph.cjs');
const {
  buildChronology,
  documentIndexFile,
  writeDocumentIndexOverride,
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
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-contrat-graphify-'));
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  const assignation = path.join(caseRoot, 'Assignation Alice.pdf');
  const note = path.join(caseRoot, 'Note non scannée.pdf');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(assignation, 'ORIGINAL');
  fs.writeFileSync(note, 'ORIGINAL');
  fs.writeFileSync(path.join(workspace, 'Assignation Alice.md'), [
    '# Assignation',
    'Alice Martin demande la condamnation de BETA SAS.',
  ].join('\n'));

  const mapping = {
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
    },
    informations_dossier: {
      parties_clientes: [{
        type: 'personne_physique',
        position: 'demandeur',
        nom: 'Alice Martin',
      }],
      parties_adverses: [{
        type: 'societe',
        position: 'defendeur',
        societe_nom: 'BETA SAS',
      }],
    },
  };
  writeJson(path.join(workspace, 'mapping_default.json'), mapping);
  writeJson(documentIndexFile(caseRoot), {
    version: 1,
    documents: {
      [stateKey('Assignation Alice.pdf')]: {
        nature: 'assignation',
        nature_confidence: 0.96,
        doc_date: '2 janvier 2024',
        doc_date_iso: '2024-01-02',
        juridiction: 'Tribunal judiciaire de Paris',
        codes: ['PERSONNE_PHYSIQUE_01', 'SAS_1'],
        updatedAt: '2026-08-25T00:00:00Z',
      },
    },
  });
  markFilesAnonymized(caseRoot, [assignation], '2026-08-25T00:00:00Z');
  return { assignation, caseRoot, mapping, note, workspace };
}

function attestPrompt(options) {
  const prompt = fs.readFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT);
  const digest = crypto.createHash('sha256').update(prompt).digest('hex');
  fs.writeFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_MARKER, digest);
}

function rawLegalGraph(sourceFile) {
  return {
    input_tokens: 120,
    output_tokens: 40,
    nodes: [
      {
        id: 'document_brut',
        label: 'Libellé Graphify remplacé par PieceMaker',
        file_type: 'document',
        legal_kind: 'document',
        source_file: sourceFile,
      },
      {
        id: 'partie_cliente',
        label: 'PERSONNE_PHYSIQUE_01',
        file_type: 'concept',
        legal_kind: 'personne',
        source_file: sourceFile,
      },
      {
        id: 'demande_principale',
        label: 'Demande principale',
        file_type: 'concept',
        legal_kind: 'demande',
        assertion_status: 'ALLEGUE',
        source_file: sourceFile,
      },
    ],
    edges: [{
      source: 'partie_cliente',
      target: 'demande_principale',
      relation: 'demande_reparation',
      confidence: 'EXTRACTED',
      confidence_score: 1,
      assertion_status: 'ALLEGUE',
      source_file: sourceFile,
    }],
    hyperedges: [],
  };
}

test('contrat de réponse : la chronologie conserve sa frise, ses corrections et son graphe de repli', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  writeDocumentIndexOverride(data.caseRoot, 'Note non scannée.pdf', {
    nature: 'note cabinet',
    dateIso: '2024-01-01',
    juridiction: 'Cabinet',
    fields: [{ label: 'Cote', value: 'N-1' }],
  });

  const chronology = await buildChronology(data.caseRoot, { deanonymize: true });

  for (const key of ['generatedAt', 'deanonymized', 'mapping', 'stats', 'documents', 'entities', 'graph']) {
    assert.ok(Object.hasOwn(chronology, key), `champ de chronologie manquant : ${key}`);
  }
  assert.equal(chronology.deanonymized, true);
  assert.deepEqual(chronology.stats, {
    documents: 2,
    indexed: 1,
    dated: 2,
    entities: 2,
    span: { from: '2024-01-01', to: '2024-01-02' },
  });
  assert.deepEqual(chronology.documents.map((document) => document.name), [
    'Note non scannée.pdf',
    'Assignation Alice.pdf',
  ]);

  const note = chronology.documents[0];
  assert.equal(note.indexed, false);
  assert.equal(note.scanned, false);
  assert.equal(note.edited, true);
  assert.equal(note.nature, 'note cabinet');
  assert.equal(note.dateIso, '2024-01-01');
  assert.equal(note.juridiction, 'Cabinet');
  assert.deepEqual(note.fields, [{ label: 'Cote', value: 'N-1' }]);

  const assignation = chronology.documents[1];
  assert.equal(assignation.indexed, true);
  assert.equal(assignation.scanned, true);
  assert.equal(assignation.natureConfidence, 0.96);
  assert.deepEqual(assignation.codes.map(({ code, category, label }) => ({ code, category, label })), [
    { code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Alice Martin' },
    { code: 'SAS_1', category: 'societe', label: 'BETA SAS' },
  ]);
  assert.equal(chronology.entities.find((entity) => entity.code === 'PERSONNE_PHYSIQUE_01').documentCount, 1);
  assert.deepEqual(
    {
      engine: chronology.graph.engine,
      source: chronology.graph.source,
      llm: chronology.graph.llm,
      status: chronology.graph.status,
    },
    { engine: 'index-fallback', source: 'gliner', llm: false, status: 'ready' },
  );
  assert.ok(Array.isArray(chronology.graph.nodes));
  assert.ok(Array.isArray(chronology.graph.edges));
});

test('contrat Graphify : build et query conservent la CLI, le cache et le graphe persisté', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let extractionCalls = 0;

  const runner = async (command, args, options) => {
    extractionCalls += 1;
    assert.equal(command, 'graphify-test');
    assert.equal(args[0], 'extract');
    assert.equal(args[args.indexOf('--mode') + 1], 'deep');
    assert.ok(args.includes('--no-cluster'));
    assert.equal(args[args.indexOf('--entity-map-labels') + 1], 'canonical');
    assert.equal(args[args.indexOf('--max-concurrency') + 1], '1');
    attestPrompt(options);

    const corpus = args[1];
    const sourceFile = fs.readdirSync(corpus).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    assert.ok(sourceFile, 'la pièce pseudonymisée doit être transmise à Graphify');
    const privateInput = fs.readFileSync(path.join(corpus, sourceFile), 'utf8')
      + fs.readFileSync(args[args.indexOf('--entity-map') + 1], 'utf8');
    assert.match(privateInput, /PERSONNE_PHYSIQUE_01/);
    assert.doesNotMatch(privateInput, /Alice Martin|BETA SAS|Assignation Alice/);

    const output = args[args.indexOf('--out') + 1];
    writeJson(path.join(output, 'graphify-out', 'graph.json'), rawLegalGraph(sourceFile));
    return { stdout: '' };
  };

  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  assert.equal(built.cacheHit, false);
  assert.equal(built.graphFile, legalGraphPaths(data.caseRoot).graph);
  assert.equal(built.manifestFile, legalGraphPaths(data.caseRoot).manifest);
  assert.equal(built.graph.directed, false);
  assert.equal(built.graph.multigraph, false);
  assert.deepEqual(
    {
      engine: built.graph.graph.engine,
      source: built.graph.graph.source,
      edgeDirection: built.graph.graph.edgeDirection,
    },
    { engine: 'graphify', source: 'piecemaker-legal', edgeDirection: 'source_to_target' },
  );
  assert.ok(Array.isArray(built.graph.nodes));
  assert.ok(Array.isArray(built.graph.edges));
  assert.ok(Array.isArray(built.graph.hyperedges));
  assert.equal(built.graph.piecemaker.confidentiality, 'pseudonymisee');
  assert.equal(built.graph.piecemaker.documents, 2);
  assert.equal(built.graph.piecemaker.analyzableDocuments, 1);
  assert.doesNotMatch(fs.readFileSync(built.graphFile, 'utf8'), /Alice Martin|BETA SAS|Assignation Alice/);

  const queryRunner = async (command, args, options) => {
    assert.equal(command, 'graphify-test');
    assert.deepEqual(args.slice(0, 2), ['query', 'Quelle est la demande ?']);
    assert.equal(args[args.indexOf('--graph') + 1], built.graphFile);
    assert.equal(args[args.indexOf('--budget') + 1], '2500');
    assert.equal(options.env.GRAPHIFY_QUERY_LOG_DISABLE, '1');
    return { stdout: 'NODE Demande principale [src=piece.md loc= community=]\n' };
  };
  const queried = await queryLegalGraph(data.caseRoot, 'Quelle est la demande ?', {
    budget: 2500,
    command: 'graphify-test',
    runner,
    runnerQuery: queryRunner,
  });
  assert.equal(extractionCalls, 1, 'la requête doit réutiliser le graphe à signature identique');
  assert.equal(queried.graphFile, built.graphFile);
  assert.match(queried.output, /PIECEMAKER_LEGAL_METADATA/);
  assert.match(queried.output, /LEGAL_NODE id=demande_principale/);
});

test('contrat viewer : PieceMaker délègue à cluster-only puis localise le HTML officiel', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let temporaryGraph = '';
  const graph = {
    directed: false,
    multigraph: false,
    nodes: [{ id: 'partie', label: 'PERSONNE_PHYSIQUE_01' }],
    edges: [],
    hyperedges: [],
  };
  const cabinetGraph = deanonymizeLegalGraphForAdmin(graph, data.mapping);
  assert.equal(cabinetGraph.nodes[0].label, 'Alice Martin');
  assert.equal(graph.nodes[0].label, 'PERSONNE_PHYSIQUE_01', 'la vue cabinet ne mute jamais le graphe source');

  const html = await renderLegalGraphViewer(cabinetGraph, {
    command: 'graphify-test',
    runner: async (command, args, options) => {
      assert.equal(command, 'graphify-test');
      assert.equal(args[0], 'cluster-only');
      assert.ok(args.includes('--no-label'));
      temporaryGraph = args[args.indexOf('--graph') + 1];
      assert.equal(options.cwd, path.dirname(path.dirname(temporaryGraph)));
      assert.match(fs.readFileSync(temporaryGraph, 'utf8'), /Alice Martin/);
      fs.writeFileSync(path.join(path.dirname(temporaryGraph), 'graph.html'), [
        '<!doctype html>',
        '<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"></script>',
        '<div id="graph"></div><script>new vis.Network(document.getElementById("graph"), {}, {});</script>',
      ].join('\n'));
    },
  });
  assert.match(html, /src="\/admin\/vendor\/vis-network\.min\.js"/);
  assert.doesNotMatch(html, /unpkg\.com/);
  assert.equal(fs.existsSync(temporaryGraph), false, 'la vue claire temporaire doit être supprimée');
});

test('contrat de travail en cours : le statut expose registryStatus et Data Room reste prioritaire', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));

  const status = await legalGraphStatus(data.caseRoot);
  assert.equal(status.exists, false);
  assert.equal(status.stale, true);
  assert.equal(status.registry.status, 'ready');
  assert.equal(status.registryStatus, status.registry.status);
  assert.equal(status.graphFile, legalGraphPaths(data.caseRoot).graph);

  const topology = legalTopology(data.caseRoot, {
    documents: [{
      id: '02_DATA_ROOM/Annexe.pdf',
      path: '02_DATA_ROOM/Annexe.pdf',
      scanned: false,
      codes: [],
    }],
  }, data.mapping);
  assert.equal(topology.documents.length, 1);
  assert.equal(topology.documents[0].graphPriority, true);
  assert.deepEqual(topology.documents[0].partyCodes, []);
  assert.deepEqual(topology.excludedDocuments, []);
});

test('contrat admin : la frise garde ses éditions, ses exports et la bascule vers le viewer', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'admin', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin', 'index.html'), 'utf8');

  assert.match(app, /data-chrono-view="timeline">Frise/);
  assert.match(app, /data-chrono-view="graph">Graphe des liens/);
  assert.match(app, /timeline\.hidden = wantGraph/);
  assert.match(app, /graph\.hidden = !wantGraph/);
  assert.match(app, /frame\.setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.match(app, /frame\.srcdoc = graphData\.viewerHtml/);
  assert.match(app, /openChronologyVerifyDialog/);
  assert.match(app, /\/api\/admin\/repository\/document-meta/);
  assert.match(app, /\/api\/admin\/repository\/document-entities/);
  assert.match(app, /api\('\/api\/admin\/mapping', \{/);
  assert.match(app, /repository\/chronology\/export/);
  for (const id of [
    'chronologyExportPdf',
    'chronologyExportDocx',
    'chronologyVerifyDialog',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

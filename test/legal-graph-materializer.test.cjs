const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLegalGraph,
  legalGraphPaths,
  materializeLegalGraph,
  readPersistedLegalSemanticSnapshot,
} = require('../websocket-server/legal-graph.cjs');
const {
  normalizeGraphifySemanticSnapshot,
} = require('../websocket-server/legal-graph-materializer.cjs');
const {
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

function mappingDocument() {
  return {
    exists: true,
    mapping: { 'Alice Martin': 'PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Alice Martin'] },
    informations_dossier: {
      parties_clientes: [{
        type: 'personne_physique',
        position: 'demandeur',
        nom: 'Alice Martin',
      }],
      parties_adverses: [],
    },
  };
}

function topologyFixture() {
  const includedKey = 'a'.repeat(64);
  const excludedKey = 'b'.repeat(64);
  const included = {
    key: includedKey,
    file: `${includedKey}.md`,
    label: 'PIECE_AAAAAAAAAAAA — assignation — 2024-01-02',
    nature: 'assignation',
    dateIso: '2024-01-02',
    codes: ['PERSONNE_PHYSIQUE_01'],
    partyCodes: ['PERSONNE_PHYSIQUE_01'],
    graphPriority: false,
    resource: false,
    scanned: true,
    analyzable: true,
    semanticEligible: true,
    semanticScope: 'included',
    semanticReason: null,
  };
  const excluded = {
    key: excludedKey,
    file: `${excludedKey}.md`,
    label: 'PIECE_BBBBBBBBBBBB — note — 2024-01-03',
    nature: 'note',
    dateIso: '2024-01-03',
    codes: [],
    partyCodes: [],
    graphPriority: false,
    resource: false,
    scanned: false,
    analyzable: false,
    semanticEligible: false,
    semanticScope: 'excluded',
    semanticReason: 'aucune_partie_selectionnee',
  };
  return {
    documentRecords: [included, excluded],
    documents: [included],
    semanticDocuments: [included],
    registry: {
      status: 'ready',
      parties: [{
        code: 'PERSONNE_PHYSIQUE_01',
        entityType: 'personne',
        side: 'client',
        position: 'demandeur',
      }],
    },
    excludedDocuments: [{ key: excludedKey, reason: 'aucune_partie_selectionnee' }],
    unavailableDocuments: [],
  };
}

function semanticFixture(topology) {
  const sourceFile = topology.semanticDocuments[0].file;
  return {
    directed: false,
    multigraph: false,
    nodes: [
      {
        id: 'document_graphify',
        label: 'Document Graphify',
        file_type: 'document',
        source_file: `/tmp/corpus/${sourceFile}`,
        file_path: '/Users/cabinet/Dossier/Assignation Alice.pdf',
      },
      {
        id: 'partie_graphify',
        label: 'PERSONNE_PHYSIQUE_01',
        file_type: 'concept',
        legal_kind: 'personne',
        source_file: sourceFile,
      },
      {
        id: 'fait_graphify',
        label: 'Demande en paiement',
        file_type: 'concept',
        legal_kind: 'demande',
        assertion_status: 'ALLEGUE',
        source_file: sourceFile,
      },
    ],
    links: [{
      source: 'partie_graphify',
      target: 'fait_graphify',
      relation: 'demande',
      source_file: sourceFile,
    }],
    hyperedges: [{
      id: 'hyper_demande',
      nodes: ['document_graphify', 'partie_graphify', 'fait_graphify'],
      relation: 'demande',
      source_file: sourceFile,
    }],
    input_tokens: 123,
    output_tokens: 45,
  };
}

test('le matérialiseur fusionne le snapshot Graphify et toute la couche documentaire de façon idempotente', () => {
  const topology = topologyFixture();
  const mapping = mappingDocument();
  const semantic = semanticFixture(topology);

  const first = materializeLegalGraph(semantic, topology, mapping, {
    requireSemanticSnapshot: true,
  });
  const second = materializeLegalGraph(first.semanticSnapshot, topology, mapping, {
    requireSemanticSnapshot: true,
  });

  assert.deepEqual(second.graph, first.graph);
  assert.equal(first.semanticAvailable, true);
  assert.equal(first.graph.nodes.filter((node) => node.file_type === 'document').length, 2);
  assert.ok(first.graph.nodes.some((node) => node.id === 'fait_graphify'));
  const canonicalParty = first.graph.nodes.find((node) =>
    node.label === 'PERSONNE_PHYSIQUE_01' && node.is_key_party === true);
  assert.ok(canonicalParty);
  assert.ok(first.graph.edges.some((edge) =>
    edge.source === canonicalParty.id
    && edge.target === 'fait_graphify'
    && edge.relation === 'demande'));
  assert.deepEqual(first.graph.hyperedges[0].nodes, [
    `piece_${topology.semanticDocuments[0].key}`,
    canonicalParty.id,
    'fait_graphify',
  ]);
  assert.equal(first.semanticSnapshot.nodes[0].source_file, topology.semanticDocuments[0].file);
  assert.equal(Object.hasOwn(first.semanticSnapshot.nodes[0], 'file_path'), false);
  assert.doesNotMatch(JSON.stringify(first.semanticSnapshot), /Assignation Alice|\/Users\/cabinet/);
});

test('sans snapshot valide, le matérialiseur conserve un graphe Graphify-compatible déterministe', () => {
  const topology = topologyFixture();
  const materialized = materializeLegalGraph(null, topology, mappingDocument());

  assert.equal(materialized.semanticAvailable, false);
  assert.equal(materialized.semanticSnapshot, null);
  assert.equal(materialized.graph.directed, false);
  assert.equal(materialized.graph.multigraph, false);
  assert.ok(Array.isArray(materialized.graph.nodes));
  assert.ok(Array.isArray(materialized.graph.edges));
  assert.ok(Array.isArray(materialized.graph.hyperedges));
  assert.equal(materialized.graph.input_tokens, 0);
  assert.equal(materialized.graph.output_tokens, 0);
  assert.equal(materialized.graph.nodes.filter((node) => node.file_type === 'document').length, 2);
  assert.ok(materialized.graph.edges.some((edge) => edge.relation === 'mentionne'));
});

test('le snapshot refuse une entité claire avant toute persistance', () => {
  assert.throws(() => normalizeGraphifySemanticSnapshot({
    nodes: [{ id: 'fuite', label: 'Alice Martin' }],
    edges: [],
    hyperedges: [],
  }, {
    forbiddenClearTexts: ['Alice Martin'],
  }), /snapshot sémantique contient une entité non pseudonymisée/);
});

function buildFixture({ scanned }) {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-materializer-'));
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  const original = path.join(caseRoot, 'Assignation Alice.pdf');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(original, 'ORIGINAL');
  if (scanned) {
    fs.writeFileSync(path.join(workspace, 'Assignation Alice.md'), 'PERSONNE_PHYSIQUE_01 demande paiement.');
    markFilesAnonymized(caseRoot, [original], '2026-08-27T00:00:00Z');
  }
  writeJson(path.join(workspace, 'mapping_default.json'), mappingDocument());
  writeJson(documentIndexFile(caseRoot), {
    version: 1,
    documents: {
      [stateKey('Assignation Alice.pdf')]: {
        nature: 'assignation',
        doc_date_iso: '2024-01-02',
        codes: ['PERSONNE_PHYSIQUE_01'],
      },
    },
  });
  return { caseRoot };
}

test('buildLegalGraph matérialise sans lancer Graphify quand aucune pièce sémantique n’est disponible', async (t) => {
  const fixture = buildFixture({ scanned: false });
  t.after(() => fs.rmSync(fixture.caseRoot, { recursive: true, force: true }));
  let called = false;

  const built = await buildLegalGraph(fixture.caseRoot, {
    command: 'graphify-interdit',
    runner: async () => { called = true; throw new Error('Graphify ne doit pas être appelé'); },
  });

  const paths = legalGraphPaths(fixture.caseRoot);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  assert.equal(called, false);
  assert.equal(built.graphFile, paths.graph);
  assert.equal(built.semanticSnapshotFile, null);
  assert.equal(manifest.llm, false);
  assert.equal(manifest.semanticSnapshot, null);
  assert.equal(fs.existsSync(paths.semanticGraph), false);
  assert.ok(built.graph.nodes.some((node) => node.file_type === 'document'));
});

test('buildLegalGraph garde le snapshot pseudonymisé séparé du graphe final historique', async (t) => {
  const fixture = buildFixture({ scanned: true });
  t.after(() => fs.rmSync(fixture.caseRoot, { recursive: true, force: true }));

  const built = await buildLegalGraph(fixture.caseRoot, {
    command: 'graphify-test',
    runner: async (_command, args, options) => {
      const prompt = fs.readFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT);
      const crypto = require('node:crypto');
      fs.writeFileSync(
        options.env.PIECEMAKER_GRAPHIFY_LEGAL_MARKER,
        crypto.createHash('sha256').update(prompt).digest('hex'),
      );
      const output = args[args.indexOf('--out') + 1];
      const corpus = args[1];
      const sourceFile = fs.readdirSync(corpus).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
      const topology = topologyFixture();
      const raw = semanticFixture(topology);
      for (const record of [...raw.nodes, ...raw.links, ...raw.hyperedges]) {
        record.source_file = record.source_file ? sourceFile : record.source_file;
      }
      writeJson(path.join(output, 'graphify-out', 'graph.json'), raw);
    },
  });

  const paths = legalGraphPaths(fixture.caseRoot);
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
  const stored = readPersistedLegalSemanticSnapshot(fixture.caseRoot, {
    signature: manifest.signature,
  });
  assert.equal(built.graphFile, paths.graph);
  assert.equal(built.semanticSnapshotFile, paths.semanticGraph);
  assert.equal(manifest.llm, true);
  assert.equal(manifest.semanticSnapshot.file, 'semantic-snapshot/graph.json');
  assert.ok(stored);
  assert.equal(stored.signature, manifest.signature);
  assert.ok(stored.graph.nodes.some((node) => node.id === 'fait_graphify'));
  assert.doesNotMatch(fs.readFileSync(paths.semanticGraph, 'utf8'), /Alice Martin|Assignation Alice|\/Users\/cabinet/);
  assert.doesNotMatch(fs.readFileSync(paths.graph, 'utf8'), /Alice Martin|Assignation Alice|\/Users\/cabinet/);
});

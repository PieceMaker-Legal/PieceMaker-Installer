const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  loadAdminLegalChronology,
  refreshAdminLegalGraph,
} = require('../websocket-server/admin-routes.cjs');

const DOCUMENT_KEY = 'a'.repeat(64);

function graphFixture() {
  return {
    directed: false,
    multigraph: false,
    graph: { engine: 'graphify', source: 'piecemaker-legal' },
    nodes: [
      {
        id: `piece_${DOCUMENT_KEY}`,
        file_type: 'document',
        legal_kind: 'document',
        document_key: DOCUMENT_KEY,
        source_file: `${DOCUMENT_KEY}.md`,
        date_iso: '2024-01-02',
        nature: 'assignation',
        effective_codes: ['PERSONNE_PHYSIQUE_01'],
        quality_flags: [{ type: 'SEMANTIC_LAYER_STALE_AFTER_EDIT' }],
      },
      {
        id: 'partie',
        file_type: 'concept',
        legal_kind: 'personne',
        label: 'PERSONNE_PHYSIQUE_01',
      },
    ],
    edges: [{ source: `piece_${DOCUMENT_KEY}`, target: 'partie', relation: 'mentionne' }],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  };
}

test('le GET admin synchronise et projette en clair sans construction sémantique', async () => {
  const graph = graphFixture();
  let graphAvailable = false;
  let rematerializations = 0;
  let chronologyOptions;
  let renderedGraph;
  const chronology = await loadAdminLegalChronology({
    caseRoot: '/dossier-test',
    readStatus: async () => ({
      exists: false,
      graphFile: '/graphe-test.json',
      staticState: 'missing',
      semanticState: 'missing',
      staticRevision: 0,
      semanticStaleReasons: [],
      semanticQuarantined: false,
      registryStatus: 'ready',
    }),
    rematerialize: async () => {
      rematerializations += 1;
      graphAvailable = true;
      return {
        graph,
        graphFile: '/graphe-test.json',
        generatedAt: '2026-08-27T10:00:00.000Z',
        staticState: 'current',
        semanticState: 'stale',
        staticRevision: 9,
        semanticBaseRevision: 8,
        semanticStaleReasons: ['date_changed'],
        semanticQuarantined: true,
        registry: { status: 'ready' },
      };
    },
    readGraph: () => graphAvailable ? graph : null,
    buildLocalChronology: async (_caseRoot, options) => {
      chronologyOptions = options;
      return {
        generatedAt: '2026-08-27T09:00:00.000Z',
        deanonymized: true,
        mapping: { exists: true, entries: 1 },
        documents: [{
          documentKey: DOCUMENT_KEY,
          id: 'Assignation Alice.pdf',
          path: 'Assignation Alice.pdf',
          name: 'Assignation Alice.pdf',
          indexed: true,
          scanned: true,
          codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Alice Martin' }],
        }],
      };
    },
    readMapping: () => ({
      exists: true,
      mapping: { 'Alice Martin': 'PERSONNE_PHYSIQUE_01' },
      reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Alice Martin'] },
    }),
    renderViewer: async (cabinetGraph) => {
      renderedGraph = cabinetGraph;
      return '<!doctype html><div>graphe</div>';
    },
  });

  assert.equal(rematerializations, 1);
  assert.deepEqual(chronologyOptions, {
    deanonymizeLabels: true,
    includeManualDecisions: true,
  });
  assert.equal(chronology.deanonymized, true);
  assert.equal(chronology.graphRevision, 9);
  assert.equal(chronology.graphStatus.semanticState, 'stale');
  assert.equal(chronology.graphStatus.semanticQuarantined, true);
  assert.equal(chronology.graph.status, 'stale');
  assert.equal(chronology.graph.viewerHtml, '<!doctype html><div>graphe</div>');
  assert.equal(renderedGraph.nodes.find((node) => node.id === 'partie').label, 'Alice Martin');
  assert.equal(graph.nodes.find((node) => node.id === 'partie').label, 'PERSONNE_PHYSIQUE_01');
});

test('l’actualisation admin emprunte uniquement le build explicite refreshSemantic', async () => {
  const calls = [];
  const status = await refreshAdminLegalGraph({
    caseRoot: '/dossier-test',
    build: async (...args) => calls.push(args),
    readStatus: async () => ({ semanticState: 'current', staticRevision: 12 }),
  });

  assert.deepEqual(calls, [[
    '/dossier-test',
    { refreshSemantic: true, force: true },
  ]]);
  assert.deepEqual(status, { semanticState: 'current', staticRevision: 12 });
});

test('les routes distinguent lecture, refresh LLM et décisions locales', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'websocket-server', 'admin-routes.cjs'), 'utf8');
  const chronologyRoute = source.match(/router\.get\('\/repository\/chronology'[\s\S]*?\n  \}\);/)?.[0] || '';
  const exportRoute = source.match(/router\.get\('\/repository\/chronology\/export'[\s\S]*?\n  \}\);/)?.[0] || '';

  assert.match(chronologyRoute, /loadAdminLegalChronology/);
  assert.doesNotMatch(chronologyRoute, /buildLegalGraph|refreshSemantic|req\.query\.deanonymize/);
  assert.match(source, /router\.post\('\/repository\/legal-graph\/refresh'/);
  assert.match(source, /refreshAdminLegalGraph/);
  assert.match(source, /router\.put\('\/repository\/document-entities'/);
  assert.match(source, /existingOverride/);
  assert.match(source, /rematerializeDeterministicLegalGraph\(legalCase\.root\)/);
  assert.match(exportRoute, /loadAdminLegalChronology/);
  assert.match(exportRoute, /renderViewer: null/);
  assert.doesNotMatch(exportRoute, /buildChronology\(/);
});

test('les gestes d’entité distinguent la pièce du mapping global', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'websocket-server', 'admin-routes.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'admin', 'app.js'), 'utf8');
  const entityRoute = source.match(/router\.put\('\/repository\/document-entities'[\s\S]*?\n  \}\);/)?.[0] || '';

  assert.match(entityRoute, /existingOverride/);
  assert.match(entityRoute, /entityDecisions/);
  assert.doesNotMatch(entityRoute, /writeCaseMapping|saveCaseMapping|rebuildCaseMapping/);
  assert.match(app, /Écarter de cette pièce/);
  assert.match(app, /Ajouter à cette pièce/);
  assert.match(app, /Supprimer partout/);
  assert.match(app, /api\('\/api\/admin\/mapping'/);
  assert.match(app, /api\('\/api\/admin\/repository\/document-entities'/);
});

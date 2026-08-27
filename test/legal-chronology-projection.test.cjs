const assert = require('node:assert/strict');
const test = require('node:test');

const {
  chronologyFromLegalGraph,
} = require('../websocket-server/legal-chronology.cjs');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const LOCAL_ONLY = 'd'.repeat(64);

function mappingDocument() {
  return {
    exists: true,
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
    },
  };
}

function compositeGraph() {
  return {
    directed: false,
    multigraph: false,
    graph: { engine: 'graphify', source: 'piecemaker-legal' },
    nodes: [
      {
        id: `piece_${A}`,
        file_type: 'document',
        legal_kind: 'document',
        document_key: A,
        source_file: `${A}.md`,
        label: 'PIECE_AAAAAAAAAAAA',
        metadata: {
          nature: { detected: 'courrier', effective: 'assignation', source: 'admin_manual' },
          dateIso: { detected: '2024-02-04', effective: '2024-02-03', source: 'admin_manual' },
          juridiction: {
            detected: null,
            effective: 'Tribunal saisi par PERSONNE_PHYSIQUE_01',
            source: 'admin_manual',
          },
          fields: {
            detected: [],
            effective: [{ label: 'Demandeur', value: 'PERSONNE_PHYSIQUE_01' }],
            source: 'admin_manual',
          },
        },
        editRevision: 17,
        effectiveCodes: ['PERSONNE_PHYSIQUE_01', 'SAS_1'],
        detectedCodes: ['PERSONNE_PHYSIQUE_01'],
        qualityFlags: [{
          type: 'MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION',
          field: 'dateIso',
          detectedValue: '2024-02-04',
          effectiveValue: '2024-02-03',
        }],
        entityDecisions: { additions: ['SAS_1'], exclusions: [] },
        semantic_scope: 'included',
      },
      {
        id: `piece_${B}`,
        file_type: 'document',
        legal_kind: 'document',
        document_key: B,
        source_file: `${B}.md`,
        label: 'PIECE_BBBBBBBBBBBB',
        nature: 'contrat',
        date_iso: '2024-01-01',
        effective_codes: ['SAS_1'],
        semantic_scope: 'unavailable',
        semantic_reason: 'piece_non_analysee',
        review_required: true,
        review_reasons: ['piece_non_analysee'],
      },
      {
        id: `piece_${C}`,
        file_type: 'document',
        legal_kind: 'document',
        document_key: C,
        source_file: `${C}.md`,
        label: 'PIECE_CCCCCCCCCCCC',
        nature: 'note',
        date_iso: null,
        effective_codes: [],
        semantic_scope: 'excluded',
      },
      {
        id: 'partie_alice',
        file_type: 'concept',
        legal_kind: 'personne',
        label: 'PERSONNE_PHYSIQUE_01',
      },
      {
        id: 'partie_beta',
        file_type: 'concept',
        legal_kind: 'personne',
        label: 'SAS_1',
      },
      {
        id: 'demande',
        file_type: 'concept',
        legal_kind: 'demande',
        label: 'Demande de PERSONNE_PHYSIQUE_01',
        citation: 'Demande formée par PERSONNE_PHYSIQUE_01',
        source_file: `${A}.md`,
      },
    ],
    edges: [{
      source: `piece_${A}`,
      target: 'partie_alice',
      relation: 'mentionne',
      context: 'PERSONNE_PHYSIQUE_01 saisit le tribunal',
    }],
    hyperedges: [],
    input_tokens: 100,
    output_tokens: 20,
    piecemaker: {
      semanticLegalNodes: 1,
      qualityFlags: [{
        type: 'NON_PARTY_IDENTITY_ATTEMPT',
        code: 'SAS_1',
        reasons: ['type_identitaire'],
      }],
      selectedPartiesWithoutMention: ['SAS_1'],
    },
  };
}

function localChronology() {
  return {
    generatedAt: '2026-08-27T10:00:00.000Z',
    deanonymized: false,
    mapping: { exists: true, entries: 2 },
    documents: [
      {
        documentKey: A,
        id: 'Assignation Alice.pdf',
        path: 'Assignation Alice.pdf',
        name: 'Assignation Alice.pdf',
        preview: 'aperçu local',
        protected: true,
        scanned: true,
        indexed: true,
        nature: 'ancienne nature',
        dateIso: '2020-01-01',
        codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: null }],
      },
      {
        documentKey: B,
        id: 'Contrat.pdf',
        path: 'Contrat.pdf',
        name: 'Contrat.pdf',
        protected: false,
        scanned: false,
        indexed: true,
        dateIso: '2030-01-01',
        codes: [],
      },
      {
        documentKey: C,
        id: 'Note sans date.pdf',
        path: 'Note sans date.pdf',
        name: 'Note sans date.pdf',
        protected: true,
        scanned: true,
        indexed: false,
        dateIso: '2031-01-01',
        codes: [],
      },
      {
        documentKey: LOCAL_ONLY,
        id: 'Locale orpheline.pdf',
        path: 'Locale orpheline.pdf',
        name: 'Locale orpheline.pdf',
        indexed: true,
        dateIso: '2023-01-01',
        codes: [],
      },
    ],
  };
}

test('la chronologie est la projection ordonnée des nœuds documentaires du graphe', () => {
  const graph = compositeGraph();
  const originalGraph = structuredClone(graph);
  const chronology = chronologyFromLegalGraph(
    graph,
    localChronology(),
    mappingDocument(),
    {
      deanonymize: false,
      graphRevision: 42,
      graphStatus: {
        staticState: 'current',
        semanticState: 'stale',
        semanticStaleReasons: ['date_changed'],
      },
    },
  );

  assert.deepEqual(graph, originalGraph, 'la projection ne mute jamais le graphe persisté');
  assert.deepEqual(
    chronology.documents.map((document) => document.documentKey),
    [B, A, C],
    'une pièce locale absente du graphe ne devient pas un second modèle chronologique',
  );
  assert.deepEqual(chronology.datedDocuments.map((document) => document.documentKey), [B, A]);
  assert.deepEqual(chronology.undatedDocuments.map((document) => document.documentKey), [C]);
  assert.deepEqual(chronology.stats, {
    documents: 3,
    indexed: 2,
    dated: 2,
    entities: 2,
    span: { from: '2024-01-01', to: '2024-02-03' },
  });

  const assignation = chronology.documents[1];
  assert.equal(assignation.name, 'Assignation Alice.pdf');
  assert.equal(assignation.path, 'Assignation Alice.pdf');
  assert.equal(assignation.preview, 'aperçu local');
  assert.equal(assignation.protected, true);
  assert.equal(assignation.nature, 'assignation');
  assert.equal(assignation.dateIso, '2024-02-03');
  assert.equal(assignation.juridiction, 'Tribunal saisi par PERSONNE_PHYSIQUE_01');
  assert.deepEqual(assignation.fields, [{ label: 'Demandeur', value: 'PERSONNE_PHYSIQUE_01' }]);
  assert.equal(assignation.editRevision, 17);
  assert.equal(assignation.edited, true);
  assert.deepEqual(assignation.entityDecisions, { additions: ['SAS_1'], exclusions: [] });
  assert.equal(assignation.metadata.dateIso.detected, '2024-02-04');
  assert.deepEqual(assignation.codes.map((entry) => entry.label), [null, null]);
  assert.deepEqual(assignation.detectedCodes.map((entry) => entry.code), ['PERSONNE_PHYSIQUE_01']);

  assert.equal(chronology.graphRevision, 42);
  assert.equal(chronology.graphStatus.semanticState, 'stale');
  assert.equal(chronology.graph.status, 'stale');
  assert.equal(chronology.graph.revision, 42);
  assert.equal(chronology.graph.engine, 'graphify');
  assert.equal(chronology.graph.source, 'piecemaker-legal');
  assert.equal(chronology.graph.llm, true);
  assert.equal(chronology.graph.directed, false);
  assert.ok(Array.isArray(chronology.graph.nodes));
  assert.ok(Array.isArray(chronology.graph.edges));
  assert.ok(Array.isArray(chronology.graph.hyperedges));
});

test('la ré-identification touche seulement la vue cabinet en mémoire', () => {
  const graph = compositeGraph();
  const chronology = chronologyFromLegalGraph(graph, localChronology(), {
    mappingDocument: mappingDocument(),
    deanonymize: true,
  });

  const assignation = chronology.documents.find((document) => document.documentKey === A);
  assert.equal(chronology.deanonymized, true);
  assert.deepEqual(assignation.codes.map((entry) => entry.label), ['Alice Martin', 'BETA SAS']);
  assert.equal(assignation.juridiction, 'Tribunal saisi par Alice Martin');
  assert.deepEqual(assignation.fields, [{ label: 'Demandeur', value: 'Alice Martin' }]);
  assert.equal(assignation.metadata.juridiction.effective, 'Tribunal saisi par Alice Martin');
  assert.equal(chronology.graph.nodes.find((node) => node.id === 'partie_alice').label, 'Alice Martin');
  assert.equal(chronology.graph.nodes.find((node) => node.id === 'demande').label, 'Demande de Alice Martin');
  assert.equal(chronology.graph.nodes.find((node) => node.id === 'demande').citation, 'Demande formée par Alice Martin');
  assert.equal(chronology.graph.edges[0].context, 'Alice Martin saisit le tribunal');
  assert.equal(chronology.graph.piecemaker.qualityFlags[0].code, 'BETA SAS');
  assert.deepEqual(chronology.graph.piecemaker.selectedPartiesWithoutMention, ['BETA SAS']);
  assert.equal(graph.nodes.find((node) => node.id === 'partie_alice').label, 'PERSONNE_PHYSIQUE_01');
});

test('le repli de migration conserve le contrat historique avant toute matérialisation', () => {
  const source = localChronology();
  const chronology = chronologyFromLegalGraph(null, source, {
    mappingDocument: mappingDocument(),
    deanonymize: false,
  });

  assert.equal(chronology.documents.length, 4);
  assert.equal(chronology.graph.status, 'empty');
  assert.equal(chronology.graphStatus.staticState, 'missing');
  assert.deepEqual(
    ['generatedAt', 'deanonymized', 'mapping', 'stats', 'documents', 'entities', 'graph']
      .filter((key) => !Object.hasOwn(chronology, key)),
    [],
  );
});

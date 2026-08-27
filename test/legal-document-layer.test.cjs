const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildChronology,
} = require('../websocket-server/document-index.cjs');
const {
  finalizeLegalGraph,
  legalTopology,
} = require('../websocket-server/legal-graph.cjs');
const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

function registreParties() {
  return {
    exists: true,
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'Témoin tiers': 'PERSONNE_PHYSIQUE_99',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      PERSONNE_PHYSIQUE_99: ['Témoin tiers'],
    },
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

function documentChronologie(pathname, {
  codes = [],
  dateIso = null,
  nature = null,
  resource = false,
  scanned = false,
} = {}) {
  return {
    documentKey: stateKey(pathname),
    id: pathname,
    path: pathname,
    name: path.basename(pathname),
    codes,
    dateIso,
    nature,
    resource,
    scanned,
  };
}

test('la chronologie expose la clé pseudonyme stable de chaque original', async (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-document-key-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(caseRoot, 'Pièce nouvelle.pdf'), 'ORIGINAL');

  const chronology = await buildChronology(caseRoot, { deanonymize: false });

  assert.equal(chronology.documents.length, 1);
  assert.equal(chronology.documents[0].documentKey, stateKey('Pièce nouvelle.pdf'));
});

test('la couche déterministe matérialise tous les originaux et leurs périmètres sémantiques', (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-document-layer-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Incluse.md'), 'PERSONNE_PHYSIQUE_01 invoque un contrat.');
  fs.writeFileSync(path.join(workspace, 'Exclue.md'), 'PERSONNE_PHYSIQUE_99 est un tiers.');
  fs.writeFileSync(path.join(workspace, 'Prioritaire.md'), 'Correspondance utile au dossier.');

  const codePartie = [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne' }];
  const codeTiers = [{ code: 'PERSONNE_PHYSIQUE_99', category: 'personne' }];
  const chronology = {
    documents: [
      documentChronologie('Incluse.pdf', {
        codes: codePartie, dateIso: '2024-01-01', nature: 'contrat', scanned: true,
      }),
      documentChronologie('Exclue.pdf', {
        codes: codeTiers, dateIso: '2024-01-02', nature: 'note', scanned: true,
      }),
      documentChronologie('Non scannée.pdf', {
        codes: codePartie, dateIso: '2024-01-03', scanned: false,
      }),
      documentChronologie('01_CORRESPONDANCE/Prioritaire.pdf', {
        dateIso: '2024-01-04', scanned: true,
      }),
      documentChronologie('Ressource publique.pdf', {
        codes: codePartie, dateIso: '2024-01-05', resource: true,
      }),
    ],
  };
  const mapping = registreParties();
  const topology = legalTopology(caseRoot, chronology, mapping);

  assert.equal(topology.documentRecords.length, 5);
  assert.deepEqual(
    topology.documentRecords.map((document) => document.semanticScope),
    ['included', 'excluded', 'unavailable', 'included', 'excluded'],
  );
  assert.equal(topology.documentRecords[1].semanticReason, 'aucune_partie_selectionnee');
  assert.equal(topology.documentRecords[2].semanticReason, 'piece_non_analysee');
  assert.equal(topology.documentRecords[3].graphPriority, true);
  assert.equal(topology.documentRecords[4].semanticReason, 'piece_ressource');
  assert.equal(topology.documents.length, 3);
  assert.equal(topology.semanticDocuments.length, 2);

  const incluse = topology.documentRecords[0];
  const exclue = topology.documentRecords[1];
  const prioritaire = topology.documentRecords[3];
  const raw = {
    nodes: [
      {
        id: 'document_graphify_instable',
        label: 'Libellé Graphify',
        file_type: 'document',
        legal_kind: 'document',
        source_file: incluse.file,
      },
      {
        id: 'document_prioritaire_instable',
        label: 'Prioritaire Graphify',
        file_type: 'document',
        legal_kind: 'document',
        source_file: prioritaire.file,
      },
      {
        id: 'fait_contrat',
        label: 'Contrat invoqué',
        file_type: 'concept',
        legal_kind: 'fait',
        source_file: incluse.file,
      },
      {
        id: 'tiers_interdit',
        label: 'PERSONNE_PHYSIQUE_99',
        file_type: 'concept',
        legal_kind: 'personne',
        source_file: incluse.file,
      },
      {
        id: 'concept_exclu_du_corpus',
        label: 'Concept qui ne doit pas survivre',
        file_type: 'concept',
        legal_kind: 'fait',
        source_file: exclue.file,
      },
    ],
    edges: [{
      source: 'document_graphify_instable',
      target: 'fait_contrat',
      relation: 'documente',
      source_file: incluse.file,
    }],
    hyperedges: [],
  };

  const graph = finalizeLegalGraph(raw, topology, mapping);
  const documentNodes = graph.nodes.filter((node) => node.file_type === 'document');
  assert.equal(documentNodes.length, 5);
  assert.ok(!graph.nodes.some((node) => node.id === 'document_graphify_instable'));
  assert.ok(!graph.nodes.some((node) => node.id === 'tiers_interdit'));
  assert.ok(!graph.nodes.some((node) => node.id === 'concept_exclu_du_corpus'));

  for (const document of topology.documentRecords) {
    const node = documentNodes.find((entry) => entry.document_key === document.key);
    assert.ok(node, `nœud absent pour ${document.key}`);
    assert.equal(node.id, `piece_${document.key}`);
    assert.equal(node.source_file, `${document.key}.md`);
    assert.equal(node.semantic_scope, document.semanticScope);
    assert.equal(node.semantic_reason, document.semanticReason);
  }

  const unavailableNode = documentNodes.find((node) =>
    node.document_key === topology.documentRecords[2].key);
  assert.equal(unavailableNode.review_required, true);
  assert.ok(unavailableNode.review_reasons.includes('piece_non_analysee'));
  const partieNode = graph.nodes.find((node) => node.label === 'PERSONNE_PHYSIQUE_01');
  assert.ok(graph.edges.some((edge) =>
    edge.source === unavailableNode.id
    && edge.target === partieNode.id
    && edge.relation === 'mentionne'));

  assert.ok(graph.edges.some((edge) =>
    edge.source === `piece_${incluse.key}`
    && edge.target === 'fait_contrat'
    && edge.relation === 'documente'));
  assert.deepEqual(graph.piecemaker.documentScopes, {
    included: 2,
    excluded: 2,
    unavailable: 1,
  });

  const serialized = JSON.stringify(graph);
  for (const clearValue of [
    'Incluse.pdf', 'Exclue.pdf', 'Non scannée.pdf',
    'Prioritaire.pdf', 'Ressource publique.pdf', 'Alice Martin', 'Témoin tiers',
  ]) {
    assert.equal(serialized.includes(clearValue), false, `valeur claire persistée : ${clearValue}`);
  }
});

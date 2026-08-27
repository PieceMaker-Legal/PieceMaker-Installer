const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  LEGAL_FINALIZER_VERSION,
  LEGAL_INTEGRATION_VERSION,
  LEGAL_PROMPT_VERSION,
  finalizeLegalGraph,
} = require('../websocket-server/legal-graph.cjs');
const {
  buildLegalIdentityBoundary,
  canonicalPartyId,
} = require('../websocket-server/legal-identity-boundary.cjs');

const SOURCE = `${'a'.repeat(64)}.md`;
const SOURCE_TWO = `${'b'.repeat(64)}.md`;

function mappingFixture() {
  return {
    mapping: {
      'Partie physique': 'P1',
      'Partie société': 'S1',
      'Personne tierce': 'PHYS_X',
      'Dirigeant tiers': 'DIR_X',
      'Société française': 'FRCO_X',
      'Société étrangère': 'FOREIGN_X',
      'Identité cabinet': 'CUSTOM_X',
      'Autre pièce': 'OTHER_DOC_X',
      'Code physique opaque': 'P2',
      'Code société opaque': 'S2',
      'Adresse de notification': 'ADRESSE_X',
    },
    reverse_mapping: {
      P1: ['Partie physique'],
      S1: ['Partie société'],
      PHYS_X: ['Personne tierce'],
      DIR_X: ['Dirigeant tiers'],
      FRCO_X: ['Société française'],
      FOREIGN_X: ['Société étrangère'],
      CUSTOM_X: ['Identité cabinet'],
      OTHER_DOC_X: ['Autre pièce'],
      P2: ['Code physique opaque'],
      S2: ['Code société opaque'],
      ADRESSE_X: ['Adresse de notification'],
    },
    extracted_data: {
      personnes_physiques: { P1: {}, PHYS_X: {}, P2: {} },
      societes: { S1: {}, FRCO_X: {}, FOREIGN_X: {}, S2: {} },
    },
    entity_metadata: {
      DIR_X: { entity_type: 'dirigeant' },
      CUSTOM_X: { category: 'company' },
      OTHER_DOC_X: { type: 'personne_morale' },
    },
  };
}

function topologyFixture() {
  const document = {
    key: 'a'.repeat(64),
    file: SOURCE,
    label: 'PIECE_AAAAAAAAAAAA',
    nature: 'assignation',
    dateIso: '2024-01-02',
    codes: ['P1', 'S1', 'PHYS_X', 'DIR_X', 'FRCO_X', 'FOREIGN_X', 'CUSTOM_X'],
    partyCodes: ['P1', 'S1'],
    graphPriority: false,
    resource: false,
    scanned: true,
    analyzable: true,
    semanticEligible: true,
    semanticScope: 'included',
    semanticReason: null,
  };
  const secondDocument = {
    ...document,
    key: 'b'.repeat(64),
    file: SOURCE_TWO,
    label: 'PIECE_BBBBBBBBBBBB',
    codes: ['P1'],
    partyCodes: ['P1'],
  };
  return {
    documentRecords: [document, secondDocument],
    documents: [document, secondDocument],
    semanticDocuments: [document, secondDocument],
    registry: {
      status: 'ready',
      parties: [
        { code: 'P1', entityType: 'personne', side: 'client', position: 'demandeur' },
        { code: 'S1', entityType: 'societe', side: 'adversaire', position: 'defendeur' },
      ],
    },
    excludedDocuments: [],
    unavailableDocuments: [],
  };
}

function adversarialRawGraph() {
  const identityNodes = [
    { id: 'physique_exacte', label: 'PHYS_X', legal_kind: 'fait' },
    { id: 'dirigeant_kind_invalide', label: 'DIR_X', legal_kind: 'Personne' },
    { id: 'societe_francaise', label: 'Société FRCO_X', legal_kind: 'fait' },
    { id: 'societe_etrangere', label: 'FOREIGN_X company', legal_kind: 'preuve' },
    { id: 'code_cabinet', label: 'CUSTOM_X', legal_kind: null },
    { id: 'code_p2_opaque', label: 'P2', legal_kind: 'fait' },
    { id: 'code_s2_opaque', label: 'S2', legal_kind: 'preuve' },
    { id: 'prefixe_temoin', label: 'Témoin PHYS_X', legal_kind: 'fait' },
    { id: 'suffixe_temoin', label: 'PHYS_X témoin', legal_kind: 'fait' },
    { id: 'type_identite_invalide', label: 'Tiers sans code', legal_kind: 'Personne' },
    {
      id: 'roles_forges',
      label: 'Fait avec rôle forgé',
      legal_kind: 'fait',
      entity_type: 'personne',
      side: 'client',
      procedural_role: 'demandeur',
      is_key_party: true,
    },
  ].map((node) => ({
    file_type: 'concept',
    source_file: SOURCE,
    ...node,
  }));
  return {
    input_tokens: 100,
    output_tokens: 50,
    nodes: [
      {
        id: 'document_brut',
        label: 'Document Graphify',
        file_type: 'document',
        legal_kind: 'document',
        source_file: SOURCE,
      },
      // Doublons et métadonnées volontairement fausses : le registre gagne.
      {
        id: 'partie_p1_a', label: 'P1', file_type: 'concept', legal_kind: 'personne',
        source_file: SOURCE, entity_type: 'societe', side: 'adversaire',
        procedural_role: 'defendeur', is_key_party: false,
      },
      {
        id: 'partie_p1_b', label: 'P1', file_type: 'code', legal_kind: 'Personne',
        source_file: SOURCE,
      },
      {
        id: 'partie_s1', label: 'S1', file_type: 'concept', legal_kind: 'fait',
        source_file: SOURCE, entity_type: 'personne', side: 'client',
        procedural_role: 'demandeur', is_key_party: false,
      },
      {
        id: 'fait_contextuel',
        label: 'Fait rapporté par plusieurs tiers',
        file_type: 'concept',
        legal_kind: 'fait',
        assertion_status: 'ALLEGUE',
        source_file: SOURCE,
        context_entity_codes: [
          'PHYS_X', 'DIR_X', 'FRCO_X', 'FOREIGN_X', 'CUSTOM_X',
          'P1', 'UNKNOWN_X', 'OTHER_DOC_X', 'PHYS_X',
        ],
        unexpected_model_property: 'ne doit pas survivre',
      },
      {
        id: 'preuve_valide',
        label: 'Preuve documentaire',
        file_type: 'concept',
        legal_kind: 'preuve',
        source_file: SOURCE,
      },
      {
        id: 'fait_autre_piece',
        label: 'Fait de la seconde pièce',
        file_type: 'concept',
        legal_kind: 'fait',
        source_file: SOURCE_TWO,
      },
      ...identityNodes,
    ],
    edges: [
      { source: 'partie_p1_a', target: 'fait_contextuel', relation: 'allegue', source_file: SOURCE },
      { source: 'P1', target: 'preuve_valide', relation: 'prouve', source_file: SOURCE },
      { source: 'fait_contextuel', target: 'partie_s1', relation: 'conteste', source_file: SOURCE },
      { source: 'P1', target: 'fait_autre_piece', relation: 'allegue', source_file: SOURCE_TWO },
      // S1 n'est pas dans parties_explicites de cette seconde pièce.
      { source: 'partie_s1', target: 'fait_autre_piece', relation: 'conteste', source_file: SOURCE_TWO },
      // Le tiers est connecté à une vraie partie : la connexité ne doit pas le sauver.
      { source: 'partie_p1_b', target: 'physique_exacte', relation: 'mentionne', source_file: SOURCE },
      { source: 'PHYS_X', target: 'fait_contextuel', relation: 'allegue', source_file: SOURCE },
    ],
    hyperedges: [
      {
        id: 'question_valide',
        label: 'Question entre partie, pièce et fait',
        nodes: ['document_brut', 'partie_p1_b', 'fait_contextuel'],
        relation: 'forme_question_juridique',
        confidence: 'INFERRED',
        confidence_score: 0.75,
        source_file: SOURCE,
        unexpected_model_property: 'supprimée',
      },
      {
        id: 'question_decoy',
        label: 'Question avec identité tierce',
        nodes: ['partie_p1_a', 'physique_exacte', 'fait_contextuel'],
        relation: 'forme_question_juridique',
        source_file: SOURCE,
      },
      {
        id: 'question_endpoint_direct',
        label: 'Question avec code tiers direct',
        nodes: ['partie_p1_a', 'PHYS_X', 'fait_contextuel'],
        relation: 'forme_question_juridique',
        source_file: SOURCE,
      },
    ],
  };
}

test('le prompt pose parties_explicites comme frontière autoritative sans ancien ordre contradictoire', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'websocket-server', 'legal-graph-prompt.txt'), 'utf8');
  assert.equal(LEGAL_PROMPT_VERSION, 3);
  assert.equal(LEGAL_INTEGRATION_VERSION, 3);
  assert.equal(LEGAL_FINALIZER_VERSION, 3);
  assert.match(prompt, /PÉRIMÈTRE AUTORITATIF DES PARTIES/);
  assert.match(prompt, /Seuls les\s+codes EXACTEMENT énumérés/);
  assert.match(prompt, /tiers\s+contextuel/);
  assert.match(prompt, /Ne produis jamais les propriétés `entity_type`, `side`, `procedural_role` ou\s+`is_key_party`/);
  assert.match(prompt, /Relie le document uniquement aux codes de `parties_explicites` réellement/);
  assert.doesNotMatch(prompt, /Relie le document à chaque personne explicitement mentionnée/);
  assert.doesNotMatch(prompt, /conserve le concept avec assertion_status="A_VERIFIER"/);
});

test('un code de mapping non identitaire ne franchit pas la frontière des parties', () => {
  const boundary = buildLegalIdentityBoundary(mappingFixture(), topologyFixture());
  assert.equal(boundary.mappedCodes.has('ADRESSE_X'), true);
  assert.equal(boundary.identityCodes.has('ADRESSE_X'), false);
});

test('le finalizer canonise les seules parties et rejette toutes les identités tierces adversariales', () => {
  const graph = finalizeLegalGraph(adversarialRawGraph(), topologyFixture(), mappingFixture());
  const parties = graph.nodes.filter((node) => node.is_key_party === true);
  assert.equal(parties.length, 2);
  assert.deepEqual(parties.map((node) => node.label).sort(), ['P1', 'S1']);

  const p1 = parties.find((node) => node.label === 'P1');
  const s1 = parties.find((node) => node.label === 'S1');
  assert.equal(p1.id, canonicalPartyId('P1'));
  assert.equal(s1.id, canonicalPartyId('S1'));
  assert.deepEqual(
    { entityType: p1.entity_type, side: p1.side, role: p1.procedural_role, key: p1.is_key_party },
    { entityType: 'personne', side: 'client', role: 'demandeur', key: true },
  );
  assert.deepEqual(
    { entityType: s1.entity_type, side: s1.side, role: s1.procedural_role, key: s1.is_key_party },
    { entityType: 'societe', side: 'adversaire', role: 'defendeur', key: true },
  );
  for (const rawId of ['partie_p1_a', 'partie_p1_b', 'partie_s1']) {
    assert.ok(!graph.nodes.some((node) => node.id === rawId));
  }

  const rejectedIds = [
    'physique_exacte', 'dirigeant_kind_invalide', 'societe_francaise',
    'societe_etrangere', 'code_cabinet', 'prefixe_temoin', 'suffixe_temoin',
    'code_p2_opaque', 'code_s2_opaque', 'type_identite_invalide', 'roles_forges',
  ];
  for (const id of rejectedIds) assert.ok(!graph.nodes.some((node) => node.id === id), id);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  assert.ok(graph.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  assert.ok(graph.hyperedges.every((entry) => entry.nodes.every((id) => nodeIds.has(id))));
  assert.ok(!graph.edges.some((edge) => rejectedIds.includes(edge.source) || rejectedIds.includes(edge.target)));
  assert.ok(!graph.hyperedges.some((entry) => entry.id !== 'question_valide'));
  assert.deepEqual(graph.hyperedges[0].nodes, [
    `piece_${'a'.repeat(64)}`,
    p1.id,
    'fait_contextuel',
  ]);
  assert.ok(graph.edges.some((edge) => edge.source === p1.id && edge.target === 'fait_contextuel'));
  assert.ok(graph.edges.some((edge) => edge.source === p1.id && edge.target === 'preuve_valide'));
  assert.ok(graph.edges.some((edge) => edge.source === 'fait_contextuel' && edge.target === s1.id));
  assert.ok(graph.edges.some((edge) => edge.source === p1.id && edge.target === 'fait_autre_piece'));
  assert.ok(!graph.edges.some((edge) => edge.source === s1.id && edge.target === 'fait_autre_piece'));

  const contextNode = graph.nodes.find((node) => node.id === 'fait_contextuel');
  assert.deepEqual(contextNode.context_entity_codes, [
    'CUSTOM_X', 'DIR_X', 'FOREIGN_X', 'FRCO_X', 'PHYS_X',
  ]);
  assert.equal(Object.hasOwn(contextNode, 'unexpected_model_property'), false);
  assert.equal(Object.hasOwn(graph.hyperedges[0], 'unexpected_model_property'), false);
  assert.ok(graph.nodes.filter((node) => !node.is_key_party)
    .every((node) => !['entity_type', 'side', 'procedural_role', 'is_key_party']
      .some((field) => Object.hasOwn(node, field))));

  const flags = graph.piecemaker.qualityFlags;
  assert.ok(flags.length >= rejectedIds.length);
  assert.ok(flags.every((flag) => flag.type === 'NON_PARTY_IDENTITY_ATTEMPT'));
  assert.ok(flags.every((flag) => /^NODE_[A-F0-9]{16}$/.test(flag.node_ref)));
  for (const code of ['PHYS_X', 'DIR_X', 'FRCO_X', 'FOREIGN_X', 'CUSTOM_X', 'P2', 'S2']) {
    assert.ok(flags.some((flag) => flag.code === code), `flag absent pour ${code}`);
  }
  const serialized = JSON.stringify(graph);
  for (const clearName of Object.keys(mappingFixture().mapping)) {
    assert.doesNotMatch(serialized, new RegExp(clearName));
  }
});

test('le finalizer échoue sur un identifiant brut ambigu ou un identifiant canonique usurpé', () => {
  const topology = topologyFixture();
  const mapping = mappingFixture();
  assert.throws(() => finalizeLegalGraph({
    nodes: [
      { id: 'meme_id', label: 'P1', file_type: 'concept', source_file: SOURCE },
      { id: 'meme_id', label: 'S1', file_type: 'concept', source_file: SOURCE },
    ],
    edges: [],
    hyperedges: [],
  }, topology, mapping), /identifiant ambigu/);

  assert.throws(() => finalizeLegalGraph({
    nodes: [{
      id: canonicalPartyId('P1'),
      label: 'Fait usurpant une partie',
      file_type: 'concept',
      legal_kind: 'fait',
      source_file: SOURCE,
    }],
    edges: [],
    hyperedges: [],
  }, topology, mapping), /réutiliser un identifiant déterministe/);
});

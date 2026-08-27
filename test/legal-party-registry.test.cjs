const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLegalPartyRegistry,
  partyCodeForSelection,
  partyRelationForPosition,
  serializeSafePartyRegistry,
} = require('../websocket-server/legal-party-registry.cjs');

const CLIENT_CODE = 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01';
const ADVERSE_CODE = 'PERS_MORALE_01';

function identityAssignment(code) {
  return [{ field: 'identite', code, original_code: code, category: '', principal: '', variants: ['x'] }];
}

function baseMappingDocument(overrides = {}) {
  return {
    mapping: {
      'Alice Martin': CLIENT_CODE,
      'BETA SAS': ADVERSE_CODE,
    },
    reverse_mapping: {
      [CLIENT_CODE]: ['Alice Martin'],
      [ADVERSE_CODE]: ['BETA SAS'],
    },
    extracted_data: {
      personnes_physiques: { [CLIENT_CODE]: { original: 'Alice Martin', code: CLIENT_CODE, variants: ['Alice Martin'] } },
      societes: { [ADVERSE_CODE]: { original: 'BETA SAS', code: ADVERSE_CODE, variants: ['BETA SAS'] } },
    },
    informations_dossier: {
      parties_clientes: [],
      parties_adverses: [],
    },
    ...overrides,
  };
}

function clientParty(overrides = {}) {
  return {
    type: 'personne_physique',
    position: 'demandeur',
    position_libelle: '',
    nom: 'Alice Martin',
    mapping_assignments: identityAssignment(CLIENT_CODE),
    ...overrides,
  };
}

function adverseParty(overrides = {}) {
  return {
    type: 'societe',
    position: 'defendeur',
    position_libelle: '',
    societe_nom: 'BETA SAS',
    mapping_assignments: identityAssignment(ADVERSE_CODE),
    ...overrides,
  };
}

test('ready : demandeur cliente + défendeur adverse valides', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty()],
      parties_adverses: [adverseParty()],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'ready');
  assert.equal(registry.parties.length, 2);
  const client = registry.parties.find((p) => p.side === 'client');
  const adverse = registry.parties.find((p) => p.side === 'adversaire');
  assert.deepEqual(client, {
    code: CLIENT_CODE, entityType: 'personne', side: 'client', position: 'demandeur', positionLibelle: '',
  });
  assert.deepEqual(adverse, {
    code: ADVERSE_CODE, entityType: 'societe', side: 'adversaire', position: 'defendeur', positionLibelle: '',
  });
});

test('mapping_missing : pas de mapping du tout', () => {
  assert.deepEqual(buildLegalPartyRegistry(null), { status: 'mapping_missing' });
  assert.deepEqual(buildLegalPartyRegistry({}), { status: 'mapping_missing' });
  assert.deepEqual(buildLegalPartyRegistry({ mapping: {}, reverse_mapping: {} }), { status: 'mapping_missing' });
});

test('parties_required : mapping présent, aucune partie sélectionnée', () => {
  const doc = baseMappingDocument();
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'parties_required');
  assert.equal(registry.parties, undefined);
});

test('party_selection_invalid : le code d\'identité n\'existe plus dans le mapping', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty({ mapping_assignments: identityAssignment('CODE_INCONNU_99'), nom: '' })],
      parties_adverses: [],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'party_selection_invalid');
  assert.equal(registry.errors.length, 1);
  assert.match(registry.errors[0], /n'existe plus dans le mapping/);
});

test('conflit : deux parties revendiquent le même code avec des côtés/positions incompatibles', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty()],
      // Même code que la partie cliente, mais côté adverse : incompatible.
      parties_adverses: [clientParty({ position: 'defendeur' })],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'party_selection_invalid');
  assert.ok(registry.errors.some((message) => message.includes('revendiqué par des parties incompatibles')));
});

test('incohérence de type : une personne physique pointe vers un code société', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      // personne_physique mais son identité pointe vers le code société.
      parties_clientes: [clientParty({ mapping_assignments: identityAssignment(ADVERSE_CODE), nom: '' })],
      parties_adverses: [],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'party_selection_invalid');
  assert.ok(registry.errors.some((message) => message.includes('incompatible avec le type de partie')));
});

test('repli : correspondance exacte du nom quand aucune affectation identite', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty({ mapping_assignments: [] })],
      parties_adverses: [adverseParty({ mapping_assignments: [] })],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'ready');
  assert.equal(registry.parties.find((p) => p.side === 'client').code, CLIENT_CODE);
  assert.equal(registry.parties.find((p) => p.side === 'adversaire').code, ADVERSE_CODE);
});

test('partie sans identité exploitable', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty({ mapping_assignments: [], nom: '' })],
      parties_adverses: [],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'party_selection_invalid');
  assert.ok(registry.errors.some((message) => message.includes('aucune identité exploitable')));
});

test('serializeSafePartyRegistry : forme attendue, sans nom ni position_libelle', () => {
  const doc = baseMappingDocument({
    informations_dossier: {
      parties_clientes: [clientParty({ position: 'autre', position_libelle: 'Curateur' })],
      parties_adverses: [adverseParty()],
    },
  });
  const registry = buildLegalPartyRegistry(doc);
  assert.equal(registry.status, 'ready');
  const safe = serializeSafePartyRegistry(registry);
  assert.deepEqual(safe, {
    schema_version: 1,
    mapping: { [CLIENT_CODE]: CLIENT_CODE, [ADVERSE_CODE]: ADVERSE_CODE },
    entity_metadata: {
      [CLIENT_CODE]: { entity_type: 'personne', procedural_role: 'autre', side: 'client', is_key_party: true },
      [ADVERSE_CODE]: { entity_type: 'societe', procedural_role: 'defendeur', side: 'adversaire', is_key_party: true },
    },
  });
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /Alice Martin/);
  assert.doesNotMatch(serialized, /BETA SAS/);
  assert.doesNotMatch(serialized, /Curateur/);
});

test('serializeSafePartyRegistry : projection vide pour un registre non ready', () => {
  assert.deepEqual(serializeSafePartyRegistry({ status: 'parties_required' }), {
    schema_version: 1, mapping: {}, entity_metadata: {},
  });
});

test('partyRelationForPosition : relations déterministes', () => {
  assert.equal(partyRelationForPosition('demandeur'), 'a_pour_demandeur');
  assert.equal(partyRelationForPosition('defendeur'), 'a_pour_defendeur');
  assert.equal(partyRelationForPosition('appelant'), 'a_pour_partie');
  assert.equal(partyRelationForPosition('intime'), 'a_pour_partie');
  assert.equal(partyRelationForPosition('autre'), 'a_pour_partie');
});

test('partyCodeForSelection : résout une partie isolée ou renvoie null', () => {
  const doc = baseMappingDocument();
  assert.equal(partyCodeForSelection(clientParty(), doc), CLIENT_CODE);
  assert.equal(partyCodeForSelection(clientParty({ mapping_assignments: identityAssignment('INCONNU') }), doc), null);
  assert.equal(partyCodeForSelection(null, doc), null);
  assert.equal(partyCodeForSelection(clientParty(), null), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MappingValidationError,
  applyProcedureParties,
  buildMappingDocument,
  groupMappingByCode,
  principalPartyOptions,
  procedureSummary,
} from '../admin/mapping-model.mjs';

test('le mapping plat est affiché sur une seule ligne par nom anonymisé', () => {
  const groups = groupMappingByCode({
    'M. Gilly': 'PERSONNE_PHYSIQUE_01',
    'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
    'Société Alpha': 'PERSONNE_MORALE_01',
  }, {
    PERSONNE_PHYSIQUE_01: ['Bernard Gilly', 'M. Gilly'],
    PERSONNE_MORALE_01: ['Société Alpha'],
  });

  assert.deepEqual(groups, [
    {
      code: 'PERSONNE_PHYSIQUE_01',
      principal: 'Bernard Gilly',
      variants: ['M. Gilly'],
    },
    {
      code: 'PERSONNE_MORALE_01',
      principal: 'Société Alpha',
      variants: [],
    },
  ]);
});

test('un variant principal obsolète ne remplace pas les variants réellement mappés', () => {
  const [group] = groupMappingByCode({
    'BERNARD GILLY': 'PERSONNE_PHYSIQUE_01',
    'M. Gilly': 'PERSONNE_PHYSIQUE_01',
  }, {
    PERSONNE_PHYSIQUE_01: ['Ancien nom'],
  });

  assert.equal(group.principal, 'BERNARD GILLY');
  assert.deepEqual(group.variants, ['M. Gilly']);
});

test('la validation accepte plusieurs variants qui partagent le même code', () => {
  const document = buildMappingDocument([{
    code: 'PERSONNE_PHYSIQUE_01',
    principal: 'Bernard Gilly',
    variants: ['M. Gilly', 'GILLY', 'Bernard Gilly'],
  }]);

  assert.deepEqual(document, {
    mapping: {
      'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
      'M. Gilly': 'PERSONNE_PHYSIQUE_01',
      GILLY: 'PERSONNE_PHYSIQUE_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Bernard Gilly', 'M. Gilly', 'GILLY'],
    },
  });
});

test('le premier variant du reverse mapping reste celui utilisé au revert', () => {
  const source = {
    mapping: {
      'M. Gilly': 'PERSONNE_PHYSIQUE_01',
      'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Bernard Gilly', 'M. Gilly'],
    },
  };

  assert.deepEqual(buildMappingDocument(groupMappingByCode(source.mapping, source.reverse_mapping)), source);
});

test('un vrai conflit reste refusé si un variant appartient à deux codes', () => {
  assert.throws(() => buildMappingDocument([
    { code: 'PERSONNE_PHYSIQUE_01', principal: 'Bernard Gilly', variants: ['M. Gilly'] },
    { code: 'PERSONNE_PHYSIQUE_02', principal: 'Claire Gilly', variants: ['M. Gilly'] },
  ]), (error) => {
    assert.ok(error instanceof MappingValidationError);
    assert.match(error.message, /M\. Gilly.*PERSONNE_PHYSIQUE_01/);
    assert.equal(error.rowIndex, 1);
    assert.equal(error.field, 'variant');
    return true;
  });
});

test('les parties de la procédure renomment tous les variants et leurs détails sensibles', () => {
  const source = {
    mapping: {
      'Claire Reynaud': 'PERSONNE_PHYSIQUE_01',
      'Mme Reynaud': 'PERSONNE_PHYSIQUE_01',
      'Société Alpha': 'PERSONNE_MORALE_01',
      '123 456 789': 'SIREN_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Claire Reynaud', 'Mme Reynaud'],
      PERSONNE_MORALE_01: ['Société Alpha'],
      SIREN_01: ['123 456 789'],
    },
  };

  const assigned = applyProcedureParties(source, {}, {
    parties_clientes: [{
      type: 'personne_physique', position: 'demandeur', civilite: 'Mme', nom: 'Claire Reynaud',
    }],
    parties_adverses: [{
      type: 'societe', position: 'defendeur', societe_nom: 'Société Alpha', forme_sociale: 'SAS', siren: '123 456 789',
    }],
  });

  assert.equal(assigned.mapping['Claire Reynaud'], 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01');
  assert.equal(assigned.mapping['Mme Reynaud'], 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01');
  assert.equal(assigned.mapping['Société Alpha'], 'ADVERSAIRE_DEFENDEUR_PERSONNE_MORALE_01');
  assert.equal(assigned.mapping['123 456 789'], 'SIREN_ADVERSAIRE_DEFENDEUR_01');
  assert.deepEqual(assigned.reverse_mapping.CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01, ['Claire Reynaud', 'Mme Reynaud']);
  assert.equal(assigned.informations_dossier.parties_clientes[0].mapping_assignments[0].original_code, 'PERSONNE_PHYSIQUE_01');
});

test('une identité saisie manuellement rejoint le mapping et reste éditable', () => {
  const first = applyProcedureParties({ mapping: {}, reverse_mapping: {} }, {}, {
    parties_clientes: [{ type: 'personne_physique', position: 'appelant', nom: 'Alice Martin' }],
    parties_adverses: [],
  });
  assert.equal(first.mapping['Alice Martin'], 'CLIENT_APPELANT_PERSONNE_PHYSIQUE_01');

  const second = applyProcedureParties(first, first.informations_dossier, {
    parties_clientes: [{ type: 'personne_physique', position: 'intime', nom: 'Alice Martin' }],
    parties_adverses: [],
  });
  assert.equal(second.mapping['Alice Martin'], 'CLIENT_INTIME_PERSONNE_PHYSIQUE_01');
  assert.equal(Object.keys(second.mapping).length, 1);
});

test('les combos ne proposent que les variants principaux du bon type', () => {
  const mapping = {
    'Claire Reynaud': 'PERSONNE_PHYSIQUE_01',
    'Mme Reynaud': 'PERSONNE_PHYSIQUE_01',
    Alpha: 'PERSONNE_MORALE_01',
    Paris: 'ADRESSE_01',
  };
  const reverse = {
    PERSONNE_PHYSIQUE_01: ['Claire Reynaud', 'Mme Reynaud'],
    PERSONNE_MORALE_01: ['Alpha'],
    ADRESSE_01: ['Paris'],
  };
  assert.deepEqual(principalPartyOptions(mapping, reverse, 'personne_physique'), [
    { code: 'PERSONNE_PHYSIQUE_01', principal: 'Claire Reynaud' },
  ]);
  assert.deepEqual(principalPartyOptions(mapping, reverse, 'societe'), [
    { code: 'PERSONNE_MORALE_01', principal: 'Alpha' },
  ]);
});

test('la synthèse ne montre que la civilité et le nom des parties', () => {
  assert.deepEqual(procedureSummary({
    parties_clientes: [{ type: 'personne_physique', civilite: 'Mme', nom: 'Claire Reynaud', adresse: 'Secret' }],
    parties_adverses: [{ type: 'societe', forme_sociale: 'SARL', societe_nom: 'Alpha', siren: '123456789' }],
  }), {
    client: ['Mme Claire Reynaud'],
    adverse: ['SARL Alpha'],
  });
});

test('plusieurs clients et plusieurs adversaires sont numérotés indépendamment', () => {
  const assigned = applyProcedureParties({ mapping: {}, reverse_mapping: {} }, {}, {
    parties_clientes: [
      { type: 'personne_physique', position: 'demandeur', nom: 'Claire Reynaud' },
      { type: 'societe', position: 'demandeur', societe_nom: 'Alpha SAS' },
    ],
    parties_adverses: [
      { type: 'personne_physique', position: 'defendeur', nom: 'Paul Martin' },
      { type: 'societe', position: 'defendeur', societe_nom: 'Beta SARL' },
    ],
  });

  assert.equal(assigned.mapping['Claire Reynaud'], 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01');
  assert.equal(assigned.mapping['Alpha SAS'], 'CLIENT_DEMANDEUR_PERSONNE_MORALE_02');
  assert.equal(assigned.mapping['Paul Martin'], 'ADVERSAIRE_DEFENDEUR_PERSONNE_PHYSIQUE_01');
  assert.equal(assigned.mapping['Beta SARL'], 'ADVERSAIRE_DEFENDEUR_PERSONNE_MORALE_02');
  assert.equal(assigned.informations_dossier.parties_clientes.length, 2);
  assert.equal(assigned.informations_dossier.parties_adverses.length, 2);
});

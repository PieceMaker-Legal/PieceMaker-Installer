import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MappingValidationError,
  buildMappingDocument,
  groupMappingByCode,
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

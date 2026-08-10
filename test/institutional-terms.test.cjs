const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Fichier de termes isolé : chaque test le pointe ailleurs pour rester hermétique
// et ne jamais dépendre de la liste réelle de la machine de développement.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-terms-'));
const termsFile = path.join(workspace, 'institutional-terms.json');
process.env.PIECEMAKER_INSTITUTIONAL_TERMS = termsFile;

const {
  isInstitutionalEntity,
  readInstitutionalTerms,
  writeInstitutionalTerms,
} = require('../piecemaker-plugin/scripts/lib/institutional-terms.cjs');
const { normalizeMappingDocument, applyMapping } = require('../piecemaker-plugin/scripts/lib/mapping.cjs');

function seed(terms) {
  writeInstitutionalTerms(terms);
}

test('un terme est détecté quelles que soient la casse, les accents et la géographie', () => {
  seed(['Tribunal de Commerce', "Cour d'appel", 'Cour de Cassation', 'RCS', 'BODACC']);
  for (const entity of [
    'Tribunal de Commerce de Nanterre',
    'tribunal de commerce',
    'TRIBUNAL DE COMMERCE DE PARIS',
    'cour d’appel de Versailles',
    'Cour de cassation, chambre commerciale',
    'RCS de Paris',
    'bodacc',
  ]) {
    assert.equal(isInstitutionalEntity(entity), true, entity);
  }
});

test('les parties au litige ne sont jamais prises pour des institutions', () => {
  seed(['Tribunal de Commerce', 'RCS']);
  for (const entity of ['Bernard Gilly', 'URGOT SA', 'discommerce', 'Trib']) {
    assert.equal(isInstitutionalEntity(entity), false, entity);
  }
});

test('la liste est dédupliquée, nettoyée et triée à l’écriture', () => {
  const { terms } = writeInstitutionalTerms(['  RCS ', 'rcs', 'BODACC', 'Tribunal de Commerce', '']);
  assert.deepEqual(terms, ['BODACC', 'RCS', 'Tribunal de Commerce']);
  assert.deepEqual(readInstitutionalTerms().terms, terms);
});

test('sans fichier de termes, aucune entité n’est bannie', () => {
  fs.rmSync(termsFile, { force: true });
  assert.equal(isInstitutionalEntity('Tribunal de Commerce de Nanterre'), false);
});

test('normalizeMappingDocument écarte les entités institutionnelles des deux sens', () => {
  seed(['Tribunal de Commerce', 'Cour de Cassation', 'RCS', 'BODACC']);
  const normalized = normalizeMappingDocument({
    mapping: {
      'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
      'URGOT SA': 'PERSONNE_MORALE_01',
      'Tribunal de Commerce de Nanterre': 'PERSONNE_MORALE_02',
      'RCS Paris': 'AUTRE_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Bernard Gilly'],
      PERSONNE_MORALE_01: ['URGOT SA'],
      PERSONNE_MORALE_02: ['Tribunal de Commerce de Nanterre'],
      AUTRE_01: ['RCS Paris'],
    },
    extracted_data: {
      societes: { PERSONNE_MORALE_02: { original: 'Tribunal de Commerce de Nanterre', code: 'PERSONNE_MORALE_02', variants: ['Tribunal de Commerce de Nanterre'] } },
    },
  });
  assert.deepEqual(Object.keys(normalized.mapping).sort(), ['Bernard Gilly', 'URGOT SA']);
  assert.deepEqual(Object.keys(normalized.reverse_mapping).sort(), ['PERSONNE_MORALE_01', 'PERSONNE_PHYSIQUE_01']);
  assert.deepEqual(Object.keys(normalized.extracted_data.societes || {}), []);

  const text = 'Bernard Gilly, gérant d’URGOT SA, saisit le Tribunal de Commerce de Nanterre. RCS Paris.';
  const anonymized = applyMapping(text, normalized.mapping);
  assert.match(anonymized, /Tribunal de Commerce de Nanterre/);
  assert.match(anonymized, /RCS Paris/);
  assert.doesNotMatch(anonymized, /Bernard Gilly/);
  assert.doesNotMatch(anonymized, /URGOT SA/);
});

test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

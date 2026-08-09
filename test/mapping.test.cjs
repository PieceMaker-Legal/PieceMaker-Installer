const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyMapping,
  readCaseMapping,
  resolveCaseMapping,
  revertMapping,
} = require('../piecemaker-plugin/scripts/lib/mapping.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-mapping-test-'));
  const casesRoot = path.join(root, 'PieceMaker');
  const caseRoot = path.join(casesRoot, 'Dossier Alpha');
  fs.mkdirSync(caseRoot, { recursive: true });
  return { root, casesRoot, caseRoot };
}

test('une entité contenue dans une autre ne la corrompt jamais', () => {
  const mapping = {
    Dupont: 'PERSONNE_PHYSIQUE_02',
    'Jean Dupont-Martin': 'PERSONNE_PHYSIQUE_01',
  };
  const coded = applyMapping('Maître Jean Dupont-Martin assiste M. Dupont.', mapping);
  assert.equal(coded, 'Maître PERSONNE_PHYSIQUE_01 assiste M. PERSONNE_PHYSIQUE_02.');
});

test('l’application du mapping est idempotente', () => {
  const mapping = { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01' };
  const once = applyMapping('Note de Bernard Gilly.', mapping);
  assert.equal(applyMapping(once, mapping), once);
});

test('un mapping tolère les espaces et les variantes typographiques de l’original', () => {
  // L'entité vient du Markdown converti : coupée par un retour à la ligne et
  // écrite avec une apostrophe droite, alors que le document porte la courbe.
  const mapping = { "Société d'Urgot": 'SOCIETE_SA_01' };
  assert.equal(applyMapping('La Société\nd’Urgot conteste.', mapping), 'La SOCIETE_SA_01 conteste.');
});

test('la dé-anonymisation rend l’orthographe canonique sans confondre les codes voisins', () => {
  const reverse = {
    PERSONNE_PHYSIQUE_1: ['Alice Martin', 'A. Martin'],
    PERSONNE_PHYSIQUE_12: ['Bob Durand'],
  };
  assert.equal(
    revertMapping('PERSONNE_PHYSIQUE_12 écrit à PERSONNE_PHYSIQUE_1.', reverse),
    'Bob Durand écrit à Alice Martin.'
  );
});

test('l’aller-retour restitue le texte de départ', () => {
  const mapping = { 'Tribunal de commerce': 'PERSONNE_MORALE_01', 'CAITLYN SA': 'SOCIETE_SA_02' };
  const reverse = { PERSONNE_MORALE_01: ['Tribunal de commerce'], SOCIETE_SA_02: ['CAITLYN SA'] };
  const source = 'Le Tribunal de commerce a condamné CAITLYN SA.';
  assert.equal(revertMapping(applyMapping(source, mapping), reverse), source);
});

test('un mapping vide ou un texte hors dossier laisse le contenu intact', () => {
  assert.equal(applyMapping('Rien à coder.', {}), 'Rien à coder.');
  assert.equal(revertMapping('Rien à rétablir.', {}), 'Rien à rétablir.');
});

test('le sens inverse est reconstruit quand le fichier ne porte que le sens direct', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(data.caseRoot, 'mapping_dossier.json'),
    JSON.stringify({ mapping: { 'Claire Reynaud': 'PERSONNE_PHYSIQUE_06' } })
  );

  const mapping = readCaseMapping(data.caseRoot);
  assert.equal(mapping.exists, true);
  assert.deepEqual(mapping.reverse_mapping.PERSONNE_PHYSIQUE_06, ['Claire Reynaud']);
});

test('le mapping se résout depuis un chemin de fichier comme depuis un répertoire de travail', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(data.caseRoot, 'mapping_dossier.json'),
    JSON.stringify({ mapping: { 'Laurent Dumas': 'PERSONNE_PHYSIQUE_04' } })
  );

  const fromFile = resolveCaseMapping(data.casesRoot, path.join(data.caseRoot, 'sous-dossier', 'note.md'));
  assert.equal(fromFile.caseName, 'Dossier Alpha');
  assert.equal(fromFile.mapping['Laurent Dumas'], 'PERSONNE_PHYSIQUE_04');
  assert.equal(resolveCaseMapping(data.casesRoot, data.caseRoot).caseName, 'Dossier Alpha');

  // Hors racine, ou dans un dossier sans mapping : les hooks n'ont rien à faire.
  assert.equal(resolveCaseMapping(data.casesRoot, os.tmpdir()), null);
  fs.mkdirSync(path.join(data.casesRoot, 'Dossier Beta'));
  assert.equal(resolveCaseMapping(data.casesRoot, path.join(data.casesRoot, 'Dossier Beta', 'x.md')), null);
});

test('aucun plafond de taille : une entité est substituée où qu’elle se trouve', () => {
  const mapping = {
    'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
    'URGOT SA': 'SOCIETE_SA_02',
  };
  // Bien au-delà des 2 Mo qui abandonnaient autrefois la substitution et
  // rendaient le texte tel quel — donc avec les vrais noms.
  const filler = 'Le contrat court sur de nombreuses pages sans entité.\n'.repeat(60000);
  const text = `Bernard Gilly signe.\n${filler}Pour le compte d’URGOT SA.\n`;
  assert.ok(text.length > 3 * 1024 * 1024, 'le cas de test doit dépasser l’ancien plafond');

  const coded = applyMapping(text, mapping);
  assert.ok(!coded.includes('Bernard Gilly'), 'aucun nom en tête');
  assert.ok(!coded.includes('URGOT SA'), 'aucun nom en queue');
  assert.match(coded, /PERSONNE_PHYSIQUE_01 signe\./);
  assert.ok(coded.trimEnd().endsWith('Pour le compte d’SOCIETE_SA_02.'));

  const restored = revertMapping(coded, {
    PERSONNE_PHYSIQUE_01: ['Bernard Gilly'],
    SOCIETE_SA_02: ['URGOT SA'],
  });
  assert.equal(restored, text, 'l’aller-retour reste exact quelle que soit la taille');
});

test('le pré-filtre n’écarte jamais une entité réellement présente', () => {
  // Chaque cas piège l'index de mots : ponctuation en tête, variante Unicode,
  // casse, espaces multiples et retour à la ligne au milieu de l'entité.
  const mapping = {
    'S.A.R.L. Dupont': 'SOCIETE_SARL_01',
    'Kreos‑A': 'PERSONNE_MORALE_02',
    'Board of Directors': 'PERSONNE_MORALE_03',
    'Élodie Motté': 'PERSONNE_PHYSIQUE_04',
  };
  const text = [
    'La S.A.R.L. Dupont comparaît.',
    'Kreos‐A est intervenue.',            // U+2010 face au U+2011 du mapping
    'Le board\nof  directors a statué.',  // casse, retour à la ligne, double espace
    'élodie motté est citée.',
  ].join('\n');

  const coded = applyMapping(text, mapping);
  for (const entity of ['S.A.R.L. Dupont', 'Kreos‐A', 'board\nof  directors', 'élodie motté']) {
    assert.ok(!coded.includes(entity), `entité laissée en clair : ${entity}`);
  }
  for (const code of Object.values(mapping)) {
    assert.match(coded, new RegExp(code));
  }
});

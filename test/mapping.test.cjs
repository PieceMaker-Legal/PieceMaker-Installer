const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyMapping,
  readCaseMapping,
  resolveCaseMapping,
  resolveMappedPath,
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

test('la résolution d’un chemin conserve en priorité un fichier littéralement codé', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-resolve-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coded = path.join(root, 'Projet_SOCIETE_01.docx');
  const real = path.join(root, 'Projet_Alpha.docx');
  fs.writeFileSync(coded, 'coded');
  fs.writeFileSync(real, 'real');

  assert.equal(
    resolveMappedPath(coded, { Alpha: 'SOCIETE_01' }, { SOCIETE_01: ['Alpha'] }, root),
    coded
  );
});

test('la résolution d’un chemin utilise la variante canonique quand elle existe', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-resolve-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = path.join(root, 'Projet_Alpha Conseil.docx');
  const coded = path.join(root, 'Projet_SOCIETE_01.docx');
  fs.writeFileSync(real, 'real');

  assert.equal(
    resolveMappedPath(
      coded,
      { 'Alpha Conseil': 'SOCIETE_01' },
      { SOCIETE_01: ['Alpha Conseil'] },
      root
    ),
    real
  );
});

test('la résolution retrouve l’unique variante de nom qui produit le chemin codé', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-resolve-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realDir = path.join(root, 'Dossier Alpha');
  const real = path.join(realDir, '26_Lettre_par_Alpha_SA.md');
  const coded = path.join(root, 'Dossier SOCIETE_01', '26_Lettre_par_SOCIETE_01_SA.md');
  fs.mkdirSync(realDir);
  fs.writeFileSync(real, 'real');
  const mapping = { 'Alpha Conseil': 'SOCIETE_01', Alpha: 'SOCIETE_01' };
  const reverse = { SOCIETE_01: ['Alpha Conseil', 'Alpha'] };

  assert.equal(resolveMappedPath(coded, mapping, reverse, root), real);
});

test('la résolution refuse de choisir entre deux variantes de fichier ambiguës', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-resolve-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coded = path.join(root, 'Note_SOCIETE_01.md');
  fs.writeFileSync(path.join(root, 'Note_Alpha.md'), 'one');
  fs.writeFileSync(path.join(root, 'Note_A. Conseil.md'), 'two');
  const mapping = { 'Alpha Conseil': 'SOCIETE_01', Alpha: 'SOCIETE_01', 'A. Conseil': 'SOCIETE_01' };
  const reverse = { SOCIETE_01: ['Alpha Conseil', 'Alpha', 'A. Conseil'] };

  assert.equal(resolveMappedPath(coded, mapping, reverse, root), coded);
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

test('les orthographes piégeuses sont substituées comme les autres', () => {
  // Ponctuation en tête, variante Unicode du trait d'union, casse, espaces
  // multiples et retour à la ligne au milieu de l'entité.
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

test('une entité ≥ 3 caractères est codée même soudée à d’autres caractères (noms de fichiers)', () => {
  // Le cas réel de la fuite : le nom des parties survit dans les noms de fichiers,
  // collé à une lettre (« d'ZORLON » → « dZORLON ») ou soudé par un underscore.
  const mapping = { ZORLON: 'SOCIETE_01' };
  const text = 'Fichier 01_Kbis_dZORLON_SA.pdf, puis ZORLON_SA et xZORLONx.';
  const coded = applyMapping(text, mapping);
  assert.ok(!/ZORLON/.test(coded), `nom laissé en clair : ${coded}`);
  assert.equal(coded, 'Fichier 01_Kbis_dSOCIETE_01_SA.pdf, puis SOCIETE_01_SA et xSOCIETE_01x.');
});

test('le masquage empêche une entité de réécrire l’intérieur d’un code déjà posé', () => {
  // « Moral » est une sous-chaîne de « PERSONNE_MORALE_01 » : sans masquage, la
  // substitution en sous-chaîne corromprait le code et perdrait l’idempotence.
  const mapping = { Moral: 'PERSONNE_MORALE_01', 'Jean Moral': 'PERSONNE_PHYSIQUE_01' };
  const text = 'PERSONNE_MORALE_01 concerne Jean Moral et M. Moral.';
  const coded = applyMapping(text, mapping);
  assert.equal(coded, 'PERSONNE_MORALE_01 concerne PERSONNE_PHYSIQUE_01 et M. PERSONNE_MORALE_01.');
  assert.equal(applyMapping(coded, mapping), coded, 'idempotent malgré la sous-chaîne');
});

test('un acronyme de 2 lettres : underscore délimiteur, casse respectée, jamais dans un mot ni un code', () => {
  const mapping = { US: 'PAYS_01' };
  assert.equal(applyMapping('US_SA', mapping), 'PAYS_01_SA');        // l’underscore délimite
  assert.equal(applyMapping('US puis us', mapping), 'PAYS_01 puis us'); // casse respectée
  assert.equal(applyMapping('business', mapping), 'business');        // pas au milieu d’un mot
  // Le code déjà présent contient « US » : le masquage l’épargne.
  assert.equal(applyMapping('ETAT_US_01', { US: 'ETAT_US_01' }), 'ETAT_US_01');
});

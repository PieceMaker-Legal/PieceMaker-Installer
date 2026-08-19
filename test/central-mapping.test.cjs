const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Home hermétique AVANT de require le module (il fige HOME_DIR au chargement).
const CENTRAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-central-home-'));
process.env.PIECEMAKER_HOME = CENTRAL_HOME;

const {
  buildCentralDocument,
  readCentralMapping,
  syncCentralMapping,
  centralMappingFile,
} = require('../piecemaker-plugin/scripts/lib/central-mapping.cjs');
const { writeCaseMapping } = require('../websocket-server/originals-pipeline.cjs');
const { applyMapping, revertMapping } = require('../piecemaker-plugin/scripts/lib/substitution.cjs');

/** Crée un dossier de cas avec un mapping écrit sur disque. */
function makeCase(root, name, mapping, reverse) {
  const caseRoot = path.join(root, name);
  fs.mkdirSync(caseRoot, { recursive: true });
  writeCaseMapping(caseRoot, { mapping, reverse_mapping: reverse });
  return caseRoot;
}

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-central-cases-'));
}

test('deux dossiers avec le même code local voient l’un renuméroté (dé-conflit)', () => {
  const root = fixtureRoot();
  const a = makeCase(root, 'Dossier A', { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Jean Dupont'] });
  const b = makeCase(root, 'Dossier B', { 'Marie Martin': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Marie Martin'] });
  const config = { caseFolders: [a, b] };

  const doc = buildCentralDocument(config, readCentralMapping());

  // Deux entités distinctes ne partagent jamais un code.
  assert.equal(doc.mapping['Jean Dupont'] !== doc.mapping['Marie Martin'], true);
  // Chaque code renvoie vers la bonne personne, et à la seule bonne personne.
  assert.equal(doc.reverse_mapping[doc.mapping['Jean Dupont']][0], 'Jean Dupont');
  assert.equal(doc.reverse_mapping[doc.mapping['Marie Martin']][0], 'Marie Martin');
  // Le premier dossier (tri alpha) garde le code local, le second est renuméroté.
  assert.equal(doc.mapping['Jean Dupont'], 'PERSONNE_PHYSIQUE_01');
  assert.match(doc.mapping['Marie Martin'], /^PERSONNE_PHYSIQUE_\d+$/);
});

test('aller-retour correct sur un texte mêlant les deux dossiers', () => {
  const root = fixtureRoot();
  const a = makeCase(root, 'Dossier A', { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Jean Dupont'] });
  const b = makeCase(root, 'Dossier B', { 'Marie Martin': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Marie Martin'] });
  const doc = buildCentralDocument({ caseFolders: [a, b] }, readCentralMapping());

  const clear = 'Jean Dupont a écrit à Marie Martin.';
  const coded = applyMapping(clear, doc.mapping);
  assert.equal(coded.includes('Jean Dupont'), false);
  assert.equal(coded.includes('Marie Martin'), false);
  // Les deux personnes portent des codes différents dans le texte codé.
  assert.notEqual(doc.mapping['Jean Dupont'], doc.mapping['Marie Martin']);
  assert.equal(revertMapping(coded, doc.reverse_mapping), clear);
});

test('les attributions sont stables : un rebuild ne renumérote pas', () => {
  const root = fixtureRoot();
  const a = makeCase(root, 'Dossier A', { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Jean Dupont'] });
  const b = makeCase(root, 'Dossier B', { 'Marie Martin': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Marie Martin'] });
  const config = { caseFolders: [a, b] };

  const first = buildCentralDocument(config, readCentralMapping());
  // On persiste, puis on rebuild en repartant du fichier écrit.
  syncCentralMapping(config);
  const second = buildCentralDocument(config, readCentralMapping());

  assert.deepEqual(second.mapping, first.mapping);
  assert.deepEqual(second.assignments, first.assignments);
});

test('ajouter un troisième dossier ne renumérote pas les existants', () => {
  const root = fixtureRoot();
  const a = makeCase(root, 'Dossier A', { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Jean Dupont'] });
  const b = makeCase(root, 'Dossier B', { 'Marie Martin': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Marie Martin'] });
  syncCentralMapping({ caseFolders: [a, b] });
  const before = readCentralMapping();

  const c = makeCase(root, 'Dossier C', { 'Paul Durand': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Paul Durand'] });
  const after = buildCentralDocument({ caseFolders: [a, b, c] }, before);

  assert.equal(after.mapping['Jean Dupont'], before.mapping['Jean Dupont']);
  assert.equal(after.mapping['Marie Martin'], before.mapping['Marie Martin']);
  // Le nouveau ne réutilise aucun code déjà pris.
  const taken = new Set([before.mapping['Jean Dupont'], before.mapping['Marie Martin']]);
  assert.equal(taken.has(after.mapping['Paul Durand']), false);
});

test('plusieurs orthographes d’une même personne partagent le code global', () => {
  const root = fixtureRoot();
  const a = makeCase(
    root,
    'Dossier A',
    { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01', 'M. Gilly': 'PERSONNE_PHYSIQUE_01' },
    { PERSONNE_PHYSIQUE_01: ['Bernard Gilly', 'M. Gilly'] }
  );
  const doc = buildCentralDocument({ caseFolders: [a] }, readCentralMapping());
  assert.equal(doc.mapping['Bernard Gilly'], doc.mapping['M. Gilly']);
  assert.equal(doc.reverse_mapping[doc.mapping['Bernard Gilly']][0], 'Bernard Gilly');
});

test('syncCentralMapping écrit un fichier 0600 avec le moteur copié', () => {
  const root = fixtureRoot();
  const a = makeCase(root, 'Dossier A', { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' }, { PERSONNE_PHYSIQUE_01: ['Jean Dupont'] });
  const saved = syncCentralMapping({ caseFolders: [a] });
  assert.ok(saved);
  const stat = fs.statSync(centralMappingFile());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(fs.existsSync(path.join(CENTRAL_HOME, 'lib', 'substitution.cjs')));
});

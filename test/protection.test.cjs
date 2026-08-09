const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isMappingFile,
  isProtectedFile,
  locateCase,
  markdownCounterpart,
  readProtection,
  writeProtection,
} = require('../piecemaker-plugin/scripts/lib/protection.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-protection-test-'));
  const casesRoot = path.join(root, 'PieceMaker');
  const caseRoot = path.join(casesRoot, 'Dossier Alpha');
  fs.mkdirSync(path.join(caseRoot, 'annexes'), { recursive: true });
  fs.writeFileSync(path.join(caseRoot, 'contrat.pdf'), 'ORIGINAL');
  fs.writeFileSync(path.join(caseRoot, 'contrat.md'), '# Contrat\n');
  fs.writeFileSync(path.join(caseRoot, 'mapping_dossier.json'), '{}\n');
  fs.writeFileSync(path.join(caseRoot, 'annexes', 'pièce jointe.docx'), 'ORIGINAL');
  return { root, casesRoot, caseRoot };
}

test('tout ce qui n’est ni Markdown ni JSON est protégé par défaut', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  assert.equal(isProtectedFile(path.join(data.caseRoot, 'contrat.pdf'), data.caseRoot), true);
  // Un sous-dossier ne change rien : la protection suit le fichier.
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot), true);
  // Les surfaces que les hooks anonymisent à la lecture restent accessibles.
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'contrat.md'), data.caseRoot), false);
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'mapping_dossier.json'), data.caseRoot), false);
  // Hors du dossier, rien à protéger.
  assert.equal(isProtectedFile(path.join(data.casesRoot, 'ailleurs.pdf'), data.caseRoot), false);
});

test('le mapping et les scans PII sont reconnus où qu’ils soient rangés', () => {
  assert.equal(isMappingFile('mapping_dossier.json'), true);
  assert.equal(isMappingFile('/dossier/annexes/mapping_default.json'), true);
  assert.equal(isMappingFile('contrat_sensitive_map.json'), true);
  // Un JSON ordinaire du dossier reste lisible.
  assert.equal(isMappingFile('metadata.json'), false);
  assert.equal(isMappingFile('remapping.json'), false);
  assert.equal(isMappingFile(''), false);
});

test('une exception enregistrée libère exactement une pièce', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  writeProtection(data.caseRoot, { unprotected: ['annexes/pièce jointe.docx'] });
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot), false);
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'contrat.pdf'), data.caseRoot), true);

  // Une pièce déposée après coup n'hérite d'aucune exception : elle est
  // protégée sans que personne ait à repasser dans l'administration.
  fs.writeFileSync(path.join(data.caseRoot, 'nouvelle.pdf'), 'ORIGINAL');
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'nouvelle.pdf'), data.caseRoot), true);
});

test('la liste d’exceptions rejette les chemins qui sortent du dossier', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  writeProtection(data.caseRoot, { unprotected: ['../voisin.pdf', '/etc/passwd', 'contrat.pdf', ''] });
  assert.deepEqual([...readProtection(data.caseRoot).unprotected], ['contrat.pdf']);
});

test('un fichier de protection absent ou corrompu ne libère rien', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  assert.equal(readProtection(data.caseRoot).exists, false);
  fs.mkdirSync(path.join(data.caseRoot, '.piecemaker'), { recursive: true });
  fs.writeFileSync(path.join(data.caseRoot, '.piecemaker', 'protection.json'), '{ pas du json');
  const state = readProtection(data.caseRoot);
  assert.equal(state.exists, false);
  assert.equal(state.unprotected.size, 0);
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'contrat.pdf'), data.caseRoot), true);
});

test('le refus renvoie vers le Markdown converti, où qu’il ait été écrit', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Le pipeline écrit le Markdown à la racine du dossier, même pour une pièce
  // rangée dans un sous-dossier.
  fs.writeFileSync(path.join(data.caseRoot, 'pièce jointe.md'), '# Annexe\n');
  const found = markdownCounterpart(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot);
  assert.equal(found.exists, true);
  assert.equal(path.basename(found.path), 'pièce jointe.md');

  const missing = markdownCounterpart(path.join(data.caseRoot, 'jamais-converti.pdf'), data.caseRoot);
  assert.equal(missing.exists, false);
  assert.equal(missing.path, path.join(data.caseRoot, 'jamais-converti.md'));
});

test('chaque enfant direct de la racine est un dossier juridique, et rien d’autre', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const located = locateCase(data.casesRoot, path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'));
  assert.equal(located.caseName, 'Dossier Alpha');
  assert.equal(located.relative, 'annexes/pièce jointe.docx');

  assert.equal(locateCase(data.casesRoot, data.casesRoot), null);
  assert.equal(locateCase(data.casesRoot, os.tmpdir()), null);
  assert.equal(locateCase(data.casesRoot, path.join(data.casesRoot, '.cache', 'x.pdf')), null);
});

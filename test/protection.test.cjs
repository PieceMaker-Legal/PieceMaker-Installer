const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isMappingFile,
  isProtectedFile,
  isResourceFile,
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

test('une copie extraite …-ooxml sous le workspace est un espace de travail', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const ooxmlDir = path.join(data.caseRoot, 'Fichiers convertis PieceMaker', 'doc-ooxml');
  fs.mkdirSync(path.join(ooxmlDir, 'word'), { recursive: true });
  fs.writeFileSync(path.join(ooxmlDir, '[Content_Types].xml'), '<Types/>');
  fs.writeFileSync(path.join(ooxmlDir, 'word', 'document.xml'), '<w:document/>');
  fs.writeFileSync(path.join(ooxmlDir, 'word', 'media.png'), 'PNG');

  // Les parties du .docx extrait sont accessibles sans inscription d'exception.
  assert.equal(isProtectedFile(path.join(ooxmlDir, '[Content_Types].xml'), data.caseRoot), false);
  assert.equal(isProtectedFile(path.join(ooxmlDir, 'word', 'document.xml'), data.caseRoot), false);
  assert.equal(isProtectedFile(path.join(ooxmlDir, 'word', 'media.png'), data.caseRoot), false);

  // Le .docx original, hors du sous-dossier -ooxml, reste protégé.
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot), true);
  // Un fichier isolé nommé …-ooxml sous le workspace (pas un dossier) reste protégé.
  const bare = path.join(data.caseRoot, 'Fichiers convertis PieceMaker', 'contrat-ooxml.pdf');
  fs.writeFileSync(bare, 'ORIGINAL');
  assert.equal(isProtectedFile(bare, data.caseRoot), true);
  // Un dossier -ooxml hors du workspace ne bénéficie pas de la règle.
  const stray = path.join(data.caseRoot, 'doc-ooxml', 'word', 'document.xml');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, '<w:document/>');
  assert.equal(isProtectedFile(stray, data.caseRoot), true);
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

test('une ressource est accessible à l’IA et distincte de l’espace de travail', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  writeProtection(data.caseRoot, { unprotected: [], resources: ['contrat.pdf'] });
  // Une ressource n'est pas protégée (l'IA l'ouvre telle quelle)…
  assert.equal(isProtectedFile(path.join(data.caseRoot, 'contrat.pdf'), data.caseRoot), false);
  // …et se reconnaît comme ressource, contrairement à une pièce d'espace de travail.
  assert.equal(isResourceFile(path.join(data.caseRoot, 'contrat.pdf'), data.caseRoot), true);
  assert.equal(isResourceFile(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot), false);
});

test('écrire une seule liste préserve l’autre, et les deux listes s’excluent', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  writeProtection(data.caseRoot, { unprotected: ['contrat.pdf'], resources: ['annexes/pièce jointe.docx'] });
  // Réécrire `unprotected` seul ne doit pas effacer les ressources.
  writeProtection(data.caseRoot, { unprotected: ['contrat.pdf'] });
  assert.deepEqual([...readProtection(data.caseRoot).resources], ['annexes/pièce jointe.docx']);

  // Une même pièce ne peut être dans les deux listes : `resources` l'emporte.
  writeProtection(data.caseRoot, { unprotected: ['contrat.pdf'], resources: ['contrat.pdf'] });
  const state = readProtection(data.caseRoot);
  assert.deepEqual([...state.resources], ['contrat.pdf']);
  assert.deepEqual([...state.unprotected], []);
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

  // Emplacement courant : le pipeline écrit le Markdown dans le sous-dossier
  // `Fichiers convertis PieceMaker/`.
  const workspaceDir = path.join(data.caseRoot, 'Fichiers convertis PieceMaker');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'pièce jointe.md'), '# Annexe\n');
  const found = markdownCounterpart(path.join(data.caseRoot, 'annexes', 'pièce jointe.docx'), data.caseRoot);
  assert.equal(found.exists, true);
  assert.equal(found.path, path.join(workspaceDir, 'pièce jointe.md'));

  // Compatibilité : un Markdown resté à la racine par une version antérieure
  // reste retrouvé.
  fs.writeFileSync(path.join(data.caseRoot, 'ancienne pièce.md'), '# Ancienne\n');
  const legacy = markdownCounterpart(path.join(data.caseRoot, 'ancienne pièce.pdf'), data.caseRoot);
  assert.equal(legacy.exists, true);
  assert.equal(legacy.path, path.join(data.caseRoot, 'ancienne pièce.md'));

  // À défaut, on pointe vers l'emplacement *attendu* — le sous-dossier.
  const missing = markdownCounterpart(path.join(data.caseRoot, 'jamais-converti.pdf'), data.caseRoot);
  assert.equal(missing.exists, false);
  assert.equal(missing.path, path.join(workspaceDir, 'jamais-converti.md'));
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

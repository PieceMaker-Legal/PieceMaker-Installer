const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  classify,
  convertToPdf,
  findSoffice,
  isSpreadsheet,
  outputExtension,
  sanitizeForWinAnsi,
  sofficeArgs,
} = require('../websocket-server/lib/office-to-pdf.cjs');
const {
  detectStampImage,
  stampDataUrl,
  stampedPiecesDirectory,
} = require('../websocket-server/lib/stamping.cjs');

function hasPdfLib() {
  try {
    require.resolve('pdf-lib');
    return true;
  } catch {
    return false;
  }
}

test('chaque extension est routée vers le bon moteur de conversion', () => {
  assert.equal(classify('dossier/pièce.PDF'), 'pdf');
  assert.equal(classify('bilan.xlsx'), 'office');
  assert.equal(classify('bilan.xls'), 'office');
  assert.equal(classify('tableau.ods'), 'office');
  assert.equal(classify('conclusions.docx'), 'office');
  assert.equal(classify('scan.png'), 'image');
  assert.equal(classify('note.txt'), 'text');
  assert.equal(classify('archive.zip'), 'unsupported');
  assert.equal(classify(''), 'unsupported');

  assert.ok(isSpreadsheet('comptes.xlsm'));
  assert.ok(!isSpreadsheet('courrier.docx'));
});

test('chaque dossier juridique reçoit son propre sous-dossier de pièces tamponnées', () => {
  assert.equal(
    stampedPiecesDirectory(path.join('dossiers', 'Martin')),
    path.join('dossiers', 'Martin', 'Pièces tamponnées'),
  );
});

test('le format réel du tampon est détecté même si son nom historique finit par .png', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.deepEqual(detectStampImage(png), { format: 'png', mimeType: 'image/png' });
  assert.deepEqual(detectStampImage(jpeg), { format: 'jpeg', mimeType: 'image/jpeg' });
  assert.match(stampDataUrl(jpeg), /^data:image\/jpeg;base64,/);
  assert.throws(() => detectStampImage(Buffer.from('GIF89a')), /PNG ou JPEG/);
});

test('LibreOffice est appelé avec un profil isolé, sinon il refuse de convertir quand une instance est ouverte', () => {
  const args = sofficeArgs('/pieces/bilan.xlsx', '/tmp/out', '/tmp/profil');
  assert.equal(args[0], '-env:UserInstallation=file:///tmp/profil');
  assert.deepEqual(args.slice(1), [
    '--headless',
    '--norestore',
    '--convert-to', 'pdf',
    '--outdir', '/tmp/out',
    '/pieces/bilan.xlsx',
  ]);
});

test('sofficeArgs cible le filtre DOCX nommé quand on demande un export Word', () => {
  const args = sofficeArgs('/pieces/bilan.xlsx', '/tmp/out', '/tmp/profil', 'docx');
  assert.deepEqual(args.slice(1), [
    '--headless',
    '--norestore',
    '--convert-to', 'docx:MS Word 2007 XML',
    '--outdir', '/tmp/out',
    '/pieces/bilan.xlsx',
  ]);
});

test('outputExtension isole l’extension avant le filtre LibreOffice explicite', () => {
  assert.equal(outputExtension('pdf'), 'pdf');
  assert.equal(outputExtension('docx'), 'docx');
  assert.equal(outputExtension('docx:MS Word 2007 XML'), 'docx');
});

test('un classeur Excel sans LibreOffice échoue avec une consigne d’installation', async (t) => {
  if (findSoffice()) return t.skip('LibreOffice est installé sur cette machine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-conv-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'bilan.xlsx');
  fs.writeFileSync(source, 'PK');

  await assert.rejects(
    () => convertToPdf(source, path.join(dir, 'work')),
    (error) => /Excel/.test(error.message) && /LibreOffice/.test(error.message)
  );
});

test('le texte est ramené à ce que pdf-lib sait encoder', () => {
  assert.equal(sanitizeForWinAnsi('Créance — 12 €'), 'Créance — 12 €');
  assert.equal(sanitizeForWinAnsi('espace insécable'), 'espace insécable');
  assert.equal(sanitizeForWinAnsi('emoji 🙂'), 'emoji ??');
});

test('un fichier texte devient un PDF sans dépendance externe', async (t) => {
  if (!hasPdfLib()) return t.skip('pdf-lib non installé (npm install)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-conv-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'note.txt');
  fs.writeFileSync(source, 'Pièce n°1 — note de synthèse\n'.repeat(200), 'utf8');

  const result = await convertToPdf(source, path.join(dir, 'work'));
  assert.equal(result.converted, true);
  assert.match(result.engine, /pdf-lib/);
  assert.equal(fs.readFileSync(result.pdfPath).subarray(0, 5).toString(), '%PDF-');
});

test('un PDF déjà au bon format n’est pas reconverti', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-conv-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'assignation.pdf');
  fs.writeFileSync(source, '%PDF-1.4');

  const result = await convertToPdf(source, path.join(dir, 'work'));
  assert.deepEqual(result, { pdfPath: source, engine: 'aucune', converted: false });
});

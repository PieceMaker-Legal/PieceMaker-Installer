const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  caseMappingFile,
  getJob,
  listOriginals,
  readCaseMapping,
  rebuildCaseMapping,
  saveCaseMapping,
  startOriginalsJob,
  writeCaseMapping,
} = require('../websocket-server/originals-pipeline.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-originals-test-'));
  const casesRoot = path.join(root, 'PieceMaker');
  const caseRoot = path.join(casesRoot, 'Dossier Alpha');
  const originals = path.join(caseRoot, 'pièces originales');
  fs.mkdirSync(originals, { recursive: true });
  fs.writeFileSync(path.join(originals, 'contrat.pdf'), 'ORIGINAL');
  fs.writeFileSync(path.join(originals, 'annexe.docx'), 'ORIGINAL');
  fs.writeFileSync(path.join(originals, 'notes.md'), '# Notes déposées\n');
  fs.writeFileSync(path.join(caseRoot, 'contrat.md'), '# Contrat\n');
  return { root, casesRoot, caseRoot, originals };
}

function writeScan(caseRoot, stem, entities) {
  fs.writeFileSync(
    path.join(caseRoot, `${stem}_sensitive_map.json`),
    `${JSON.stringify({ source_file: `${stem}.md`, entities, summary: {} }, null, 2)}\n`
  );
}

test('le cadre des pièces originales liste tout sauf le Markdown, avec ses deux états', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', { PERSON: [{ text: 'Jean Dupont', start: 0, end: 11, score: 0.9 }] });

  const originals = await listOriginals(data.caseRoot);
  assert.deepEqual(originals.map((file) => file.name), ['annexe.docx', 'contrat.pdf']);
  const contrat = originals.find((file) => file.name === 'contrat.pdf');
  assert.equal(contrat.converted, true);
  assert.equal(contrat.scanned, true);
  const annexe = originals.find((file) => file.name === 'annexe.docx');
  assert.equal(annexe.converted, false);
  assert.equal(annexe.scanned, false);
});

test('le mapping est reconstruit depuis les scans PII sans réutiliser un code', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', {
    PERSON: [
      { text: 'Jean Dupont', score: 0.9 },
      { text: 'Jean Dupont', score: 0.8 },
      { text: 'Marie Martin', score: 0.9 },
    ],
    ORGANIZATION: [{ text: 'Société Alpha', score: 0.9 }],
  });

  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.total, 3);
  assert.equal(rebuilt.added, 3);
  assert.equal(rebuilt.mapping['Jean Dupont'], 'PERSON_01');
  assert.equal(rebuilt.mapping['Marie Martin'], 'PERSON_02');
  assert.equal(rebuilt.mapping['Société Alpha'], 'ORGANIZATION_01');
  assert.deepEqual(rebuilt.reverse_mapping.PERSON_01, ['Jean Dupont']);
  assert.equal(new Set(Object.values(rebuilt.mapping)).size, 3);

  const onDisk = JSON.parse(fs.readFileSync(caseMappingFile(data.caseRoot), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.mapping), ['Société Alpha', 'Marie Martin', 'Jean Dupont']);
});

test('un second scan complète le mapping sans renuméroter les codes déjà attribués', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', { PERSON: [{ text: 'Jean Dupont', score: 0.9 }] });
  await rebuildCaseMapping(data.caseRoot);

  writeScan(data.caseRoot, 'annexe', { PERSON: [{ text: 'Jean Dupont', score: 0.9 }, { text: 'Paul Durand', score: 0.9 }] });
  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.added, 1);
  assert.equal(rebuilt.mapping['Jean Dupont'], 'PERSON_01');
  assert.equal(rebuilt.mapping['Paul Durand'], 'PERSON_02');
});

test('une entrée supprimée à la main n’est pas réintroduite par le scan suivant', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', {
    PERSON: [{ text: 'Jean Dupont', score: 0.9 }],
    LOCATION: [{ text: 'Cour de cassation', score: 0.4 }],
  });
  await rebuildCaseMapping(data.caseRoot);

  saveCaseMapping(data.caseRoot, { mapping: { 'Jean Dupont': 'PERSON_01' } });
  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.added, 0);
  assert.deepEqual(Object.keys(rebuilt.mapping), ['Jean Dupont']);

  // Réintroduite volontairement, la donnée n'est plus considérée comme écartée.
  saveCaseMapping(data.caseRoot, { mapping: { 'Jean Dupont': 'PERSON_01', 'Cour de cassation': 'LOCATION_01' } });
  assert.deepEqual(readCaseMapping(data.caseRoot).ignored, []);
});

test('un mapping écrit à la main sans sens inverse reste exploitable', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_dossier.json'), `${JSON.stringify({ mapping: { Martin: 'PERSONNE_01' } })}\n`);

  const mapping = readCaseMapping(data.caseRoot);
  assert.equal(mapping.exists, true);
  assert.deepEqual(mapping.reverse_mapping, { PERSONNE_01: ['Martin'] });

  const saved = writeCaseMapping(data.caseRoot, mapping);
  assert.equal(path.basename(saved.file), 'mapping_dossier.json');
});

test('un traitement refuse une pièce hors du dossier et une action inconnue', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await assert.rejects(
    startOriginalsJob({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'exfiltrer', files: [] }),
    /Action inconnue/
  );
  await assert.rejects(
    startOriginalsJob({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['../../secret.pdf'] }),
    /Aucune pièce originale à traiter/
  );
  assert.equal(getJob('inexistant'), null);
});

test('le traitement d’une pièce absente échoue sans créer de travail', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  process.env.PYTHON_PATH = process.execPath;
  t.after(() => { delete process.env.PYTHON_PATH; });

  const job = await startOriginalsJob({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'convert',
    files: ['contrat.pdf'],
  });
  assert.equal(job.state, 'running');
  assert.equal(job.total, 1);
  assert.deepEqual(job.files, ['contrat.pdf']);

  // Node exécuté à la place de Python échoue : le travail doit finir en erreur,
  // jamais rester bloqué en « running ».
  for (let attempt = 0; attempt < 60 && getJob(job.id).state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const finished = getJob(job.id);
  assert.equal(finished.state, 'error');
  assert.match(finished.error, /smart_converter\.py/);
});

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
  sessionArtifactPaths,
  startOriginalsJob,
  writeCaseMapping,
} = require('../websocket-server/originals-pipeline.cjs');
const {
  createCommit,
  listHistory,
  resolveCase,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');

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

/** Les travaux sont suivis dans une table partagée : un test ne doit pas en
 *  laisser un en cours, le suivant refuserait de démarrer sur le même dossier. */
async function waitForJob(jobId) {
  // Très généreux à dessein. `node --test` lance les fichiers en parallèle et
  // `commits.test.cjs` sature la machine de processus git : un simple spawn a
  // été mesuré à 25 s dans ces conditions. Un travail qui n'a pas fini bloque
  // en plus tous les suivants sur le même dossier (« Un traitement est déjà en
  // cours »), donc abandonner trop tôt fait échouer trois tests d'un coup.
  for (let attempt = 0; attempt < 1200 && getJob(jobId)?.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getJob(jobId);
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
  // Les chemins sont relatifs au dossier juridique : une pièce n'a plus à vivre
  // dans un sous-dossier dédié pour être recensée.
  assert.deepEqual(originals.map((file) => file.path), [
    'pièces originales/annexe.docx',
    'pièces originales/contrat.pdf',
  ]);
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
  assert.equal(rebuilt.mapping['Jean Dupont'], 'PERSONNE_PHYSIQUE_01');
  assert.equal(rebuilt.mapping['Marie Martin'], 'PERSONNE_PHYSIQUE_02');
  assert.equal(rebuilt.mapping['Société Alpha'], 'PERSONNE_MORALE_01');
  assert.deepEqual(rebuilt.reverse_mapping.PERSONNE_PHYSIQUE_01, ['Jean Dupont']);
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
  assert.equal(rebuilt.mapping['Jean Dupont'], 'PERSONNE_PHYSIQUE_01');
  assert.equal(rebuilt.mapping['Paul Durand'], 'PERSONNE_PHYSIQUE_02');
});

test('une entrée supprimée à la main n’est pas réintroduite par le scan suivant', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', {
    PERSON: [{ text: 'Jean Dupont', score: 0.9 }],
    LOCATION: [{ text: 'Cour de cassation', score: 0.4 }],
  });
  await rebuildCaseMapping(data.caseRoot);

  saveCaseMapping(data.caseRoot, { mapping: { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01' } });
  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.added, 0);
  assert.deepEqual(Object.keys(rebuilt.mapping), ['Jean Dupont']);

  // Réintroduite volontairement, la donnée n'est plus considérée comme écartée.
  saveCaseMapping(data.caseRoot, { mapping: { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01', 'Cour de cassation': 'ADRESSE_01' } });
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

test('les artefacts d’un lot excluent les fichiers modifiés par une autre session', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'annexe.md'), '# Annexe convertie\n');
  fs.writeFileSync(path.join(data.caseRoot, 'annexe_sensitive_map.json'), '{"entities":{}}\n');
  fs.writeFileSync(path.join(data.caseRoot, 'autre-session.md'), '# Concurrent\n');
  writeCaseMapping(data.caseRoot, { mapping: { Martin: 'PERSONNE_PHYSIQUE_01' } });

  const legalCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const source = path.join(data.originals, 'annexe.docx');
  assert.deepEqual(
    await sessionArtifactPaths(legalCase, [source], 'convert'),
    ['annexe.md'],
  );
  assert.deepEqual(
    await sessionArtifactPaths(legalCase, [source], 'anonymize'),
    ['annexe_sensitive_map.json', 'annexe.md', 'mapping_dossier.json'],
  );
});

test('une conversion admin crée un commit ciblé et laisse les changements concurrents locaux', async (t) => {
  const data = fixture();
  const homeDir = path.join(data.root, 'home', '.piecemaker');
  const fakeConverter = path.join(data.root, 'fake-converter.cjs');
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
  });
  fs.writeFileSync(fakeConverter, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const input = process.argv[2];",
    "const output = process.argv[process.argv.indexOf('-o') + 1];",
    "fs.writeFileSync(path.join(output, `${path.basename(input, path.extname(input))}.md`), '# Conversion admin\\n');",
  ].join('\n'));
  process.env.PYTHON_PATH = process.execPath;
  process.env.SMART_CONVERTER_PATH = fakeConverter;

  const concurrentPath = path.join(data.caseRoot, 'autre-session.json');
  fs.writeFileSync(concurrentPath, '{"version":1}\n');
  await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir, label: 'État initial' });
  fs.writeFileSync(concurrentPath, '{"version":2}\n');

  const annexe = (await listOriginals(data.caseRoot)).find((file) => file.name === 'annexe.docx');
  const started = await startOriginalsJob({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir,
    action: 'convert',
    files: [annexe.path],
  });
  const finished = await waitForJob(started.id);
  assert.equal(finished.state, 'done', finished.error);
  assert.equal(finished.result.commit.created, true);
  assert.deepEqual(finished.result.commit.files.map((file) => file.path), ['annexe.md']);
  assert.match((await listHistory(data.casesRoot, homeDir, { caseName: 'Dossier Alpha' }))[0].subject, /Conversion de 1 pièce/);

  const pending = await worktreeDetails(data.casesRoot, homeDir, 'Dossier Alpha', 'autre-session.json');
  assert.equal(pending.filesCount, 1);
  assert.equal(pending.selectedFile.path, 'autre-session.json');
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
    /Aucune pièce à traiter/
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
    files: ['pièces originales/contrat.pdf'],
  });
  assert.equal(job.state, 'running');
  assert.equal(job.total, 1);
  assert.deepEqual(job.files, ['pièces originales/contrat.pdf']);

  // Node exécuté à la place de Python échoue : le travail doit finir en erreur,
  // jamais rester bloqué en « running ».
  const finished = await waitForJob(job.id);
  assert.equal(finished.state, 'error');
  assert.match(finished.error, /smart_converter\.py/);
});

test('les écritures d’une même personne partagent un code et gardent leurs variants', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  // Mapping tel que le produit le pipeline Python : variants dans extracted_data.
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_dossier.json'), `${JSON.stringify({
    mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'] },
    extracted_data: {
      personnes_physiques: {
        PERSONNE_PHYSIQUE_01: { original: 'Bernard Gilly', code: 'PERSONNE_PHYSIQUE_01', variants: ['Bernard Gilly'], score: 0.9 },
      },
    },
  }, null, 2)}\n`);
  writeScan(data.caseRoot, 'contrat', {
    PERSON: [{ text: 'M. Gilly', score: 0.9 }, { text: 'Claire Vasseur', score: 0.9 }, { text: 'Mme Vasseur', score: 0.8 }],
  });

  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.mapping['M. Gilly'], 'PERSONNE_PHYSIQUE_01', 'une variante rejoint le code déjà attribué');
  assert.equal(rebuilt.mapping['Mme Vasseur'], rebuilt.mapping['Claire Vasseur']);
  assert.equal(rebuilt.mapping['Claire Vasseur'], 'PERSONNE_PHYSIQUE_02');
  assert.equal(new Set(Object.values(rebuilt.mapping)).size, 2);

  const onDisk = JSON.parse(fs.readFileSync(caseMappingFile(data.caseRoot), 'utf8'));
  assert.deepEqual(onDisk.extracted_data.personnes_physiques.PERSONNE_PHYSIQUE_01.variants, ['Bernard Gilly', 'M. Gilly']);

  // L'éditeur n'envoie que le mapping : les variants ne doivent pas disparaître.
  saveCaseMapping(data.caseRoot, { mapping: rebuilt.mapping, reverse_mapping: rebuilt.reverse_mapping });
  const afterEdit = JSON.parse(fs.readFileSync(caseMappingFile(data.caseRoot), 'utf8'));
  assert.deepEqual(afterEdit.extracted_data.personnes_physiques.PERSONNE_PHYSIQUE_01.variants, ['Bernard Gilly', 'M. Gilly']);
});

test('le mapping du dossier l’emporte sur un mapping_default.json laissé par le pipeline', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_default.json'), `${JSON.stringify({ mapping: { Egaré: 'AUTRE_01' } })}\n`);
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_dossier.json'), `${JSON.stringify({ mapping: { Martin: 'PERSONNE_PHYSIQUE_01' } })}\n`);

  assert.equal(path.basename(caseMappingFile(data.caseRoot)), 'mapping_dossier.json');
  assert.deepEqual(Object.keys(readCaseMapping(data.caseRoot).mapping), ['Martin']);
});

test('sans sélection, un traitement ne refait que les pièces incomplètes', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  process.env.PYTHON_PATH = process.execPath;
  t.after(() => { delete process.env.PYTHON_PATH; });
  // contrat.pdf a son Markdown et son scan ; annexe.docx n'a rien.
  writeScan(data.caseRoot, 'contrat', { PERSON: [{ text: 'Jean Dupont', score: 0.9 }] });

  const job = await startOriginalsJob({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });
  assert.deepEqual(job.files, ['pièces originales/annexe.docx'], 'la pièce déjà scannée est laissée de côté');
  assert.equal(job.skipped, 1);
  await waitForJob(job.id);
});

test('un dossier déjà à jour rend un travail terminé sans lancer GLiNER', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  // Python remplacé par un binaire qui échouerait : rien ne doit être lancé.
  process.env.PYTHON_PATH = path.join(data.root, 'python-inexistant');
  t.after(() => { delete process.env.PYTHON_PATH; });
  fs.writeFileSync(path.join(data.caseRoot, 'annexe.md'), '# Annexe\n');
  writeScan(data.caseRoot, 'contrat', { PERSON: [{ text: 'Jean Dupont', score: 0.9 }] });
  writeScan(data.caseRoot, 'annexe', { PERSON: [{ text: 'Jean Dupont', score: 0.9 }] });

  const job = await startOriginalsJob({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });
  assert.equal(job.state, 'done');
  assert.equal(job.result.upToDate, true);
  assert.equal(job.result.skipped, 2);
  assert.deepEqual(job.files, []);

  // Une sélection explicite vaut demande de retraitement, elle relance le script.
  const forced = await startOriginalsJob({
    casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize', files: ['pièces originales/contrat.pdf'],
  });
  assert.equal(forced.state, 'running');
  assert.deepEqual(forced.files, ['pièces originales/contrat.pdf']);
  await waitForJob(forced.id);
});

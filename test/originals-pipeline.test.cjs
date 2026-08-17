const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.PIECEMAKER_USER_NAME = 'Utilisateur Test';

const {
  cancelOriginalsJob,
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
const {
  anonymizationStateFile,
  markFilesAnonymized,
} = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

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
  // Généreux à dessein : `node --test` lance les fichiers en parallèle et
  // `commits.test.cjs` sature la machine de processus git. Le budget a déjà été
  // dépassé une fois (61 s mesurées pour 2,5 s isolé), d'où la limite de
  // parallélisme posée dans `package.json` — celle-ci ramène le même travail à
  // 16 s. Le budget de 60 s a malgré tout été redépassé une fois de plus, sur le
  // seul `spawn` : il est porté à 5 min, un travail réellement bloqué étant
  // désormais lisible via `describeJob` plutôt que masqué par un abandon.
  // `startJob` empêche par ailleurs qu'un travail abandonné ici en bloque d'autres.
  for (let attempt = 0; attempt < 6000 && getJob(jobId)?.state === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getJob(jobId);
}

/**
 * Démarre un travail et garantit qu'il ne survive pas au test. Sans cela, le
 * `t.after` supprime le répertoire temporaire pendant que le git du travail y
 * tourne encore, et le travail resté `running` bloquait tous les suivants.
 */
async function startJob(t, args) {
  const job = await startOriginalsJob(args);
  t.after(() => cancelOriginalsJob(job.id));
  return job;
}

/** Motif d'échec lisible : « resté en phase commit » plutôt que running !== done. */
function describeJob(job) {
  if (!job) return 'travail introuvable';
  const tail = job.log.slice(-3).join(' | ') || '(journal vide)';
  return job.error || `état ${job.state}, phase ${job.phase}, ${tail}`;
}

/** Attend qu'une condition devienne vraie (promotion depuis la file, etc.). */
async function waitUntil(predicate, attempts = 200) {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Boolean(predicate());
}

function writeScan(caseRoot, stem, entities) {
  fs.writeFileSync(
    path.join(caseRoot, `${stem}_sensitive_map.json`),
    `${JSON.stringify({ source_file: `${stem}.md`, entities, summary: {} }, null, 2)}\n`
  );
}

function markScanned(caseRoot, ...relativeFiles) {
  return markFilesAnonymized(
    caseRoot,
    relativeFiles.map((relative) => path.join(caseRoot, ...relative.split('/')))
  );
}

test('le cadre déduit le scan du manifeste technique, sans sensitive map par pièce', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  markScanned(data.caseRoot, 'pièces originales/contrat.pdf');

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
  assert.equal(fs.existsSync(path.join(data.caseRoot, 'contrat_sensitive_map.json')), false);
  const state = JSON.parse(fs.readFileSync(anonymizationStateFile(data.caseRoot), 'utf8'));
  assert.equal(Object.keys(state.files).length, 1);
  assert.doesNotMatch(JSON.stringify(state), /contrat|pièces originales/i);
});

test('une source modifiée redevient à analyser', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  markScanned(data.caseRoot, 'pièces originales/contrat.pdf');
  const source = path.join(data.originals, 'contrat.pdf');
  fs.appendFileSync(source, ' MODIFIÉ');

  const contrat = (await listOriginals(data.caseRoot)).find((file) => file.name === 'contrat.pdf');
  assert.equal(contrat.converted, false);
  assert.equal(contrat.scanned, false);
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
  assert.equal(rebuilt.mapping['Société Alpha'], 'PERS_MORALE_1');
  assert.deepEqual(rebuilt.reverse_mapping.PERSONNE_PHYSIQUE_01, ['Jean Dupont']);
  assert.equal(new Set(Object.values(rebuilt.mapping)).size, 3);

  const onDisk = JSON.parse(fs.readFileSync(caseMappingFile(data.caseRoot), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.mapping), ['Société Alpha', 'Marie Martin', 'Jean Dupont']);
  assert.equal(fs.existsSync(path.join(data.caseRoot, 'contrat_sensitive_map.json')), false);
  assert.equal((await listOriginals(data.caseRoot)).find((file) => file.name === 'contrat.pdf').scanned, true);
});

test('une société à sigle est codée avec le sigle en préfixe, un compteur par sigle', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeScan(data.caseRoot, 'contrat', {
    ORGANIZATION_SA: [{ text: 'Alpha', score: 0.9 }, { text: 'Delta', score: 0.9 }],
    ORGANIZATION_SARL: [{ text: 'Beta', score: 0.9 }],
    ORGANIZATION_GMBH: [{ text: 'Gamma', score: 0.9 }],
    ORGANIZATION: [{ text: 'Groupe Sans Forme', score: 0.9 }],
  });

  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  // Chaque sigle repart de 1 (SA_1, SA_2, SARL_1…) ; sans sigle → PERS_MORALE_1.
  assert.equal(rebuilt.mapping.Alpha, 'SA_1');
  assert.equal(rebuilt.mapping.Delta, 'SA_2');
  assert.equal(rebuilt.mapping.Beta, 'SARL_1');
  assert.equal(rebuilt.mapping.Gamma, 'GMBH_1');
  assert.equal(rebuilt.mapping['Groupe Sans Forme'], 'PERS_MORALE_1');

  // Un second scan poursuit chaque suite sans réutiliser un code.
  writeScan(data.caseRoot, 'annexe', {
    ORGANIZATION_SA: [{ text: 'Epsilon', score: 0.9 }],
    ORGANIZATION: [{ text: 'Autre Groupe', score: 0.9 }],
  });
  const again = await rebuildCaseMapping(data.caseRoot);
  assert.equal(again.mapping.Epsilon, 'SA_3');
  assert.equal(again.mapping['Autre Groupe'], 'PERS_MORALE_2');
  assert.equal(again.mapping.Alpha, 'SA_1');
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
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_default.json'), `${JSON.stringify({ mapping: { Martin: 'PERSONNE_01' } })}\n`);

  const mapping = readCaseMapping(data.caseRoot);
  assert.equal(mapping.exists, true);
  assert.deepEqual(mapping.reverse_mapping, { PERSONNE_01: ['Martin'] });

  const saved = writeCaseMapping(data.caseRoot, mapping);
  assert.equal(path.basename(saved.file), 'mapping_default.json');
});

test('les informations des parties et le SIREN survivent aux éditions du mapping', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const informations_dossier = {
    parties_clientes: [{ type: 'personne_physique', position: 'demandeur', civilite: 'Mme', nom: 'Claire Reynaud' }],
    parties_adverses: [{ type: 'societe', position: 'defendeur', societe_nom: 'Alpha', forme_sociale: 'SAS', siren: '123 456 789' }],
  };
  writeCaseMapping(data.caseRoot, {
    mapping: { 'Claire Reynaud': 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01' },
    informations_dossier,
  });

  saveCaseMapping(data.caseRoot, {
    mapping: { 'Claire Reynaud': 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01', Alpha: 'ADVERSAIRE_DEFENDEUR_PERSONNE_MORALE_01' },
  });
  const saved = readCaseMapping(data.caseRoot);
  assert.equal(saved.informations_dossier.parties_clientes[0].nom, 'Claire Reynaud');
  assert.equal(saved.informations_dossier.parties_adverses[0].siren, '123 456 789');
});

test('un nouveau variant rejoint le code procédural existant de la personne', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeCaseMapping(data.caseRoot, {
    mapping: { 'Claire Reynaud': 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01: ['Claire Reynaud'] },
  });
  writeScan(data.caseRoot, 'requete', {
    PERSON: [{ text: 'Mme Reynaud', score: 0.9 }],
  });

  const rebuilt = await rebuildCaseMapping(data.caseRoot);
  assert.equal(rebuilt.mapping['Mme Reynaud'], 'CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01');
});

test('les artefacts d’un lot excluent les fichiers modifiés par une autre session', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'annexe.md'), '# Annexe convertie\n');
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
    ['annexe.md', `${WORKSPACE_SUBDIR}/mapping_default.json`],
  );
});

test('un lot anonymisé ne laisse que mapping_default.json et son état technique', async (t) => {
  const data = fixture();
  const fakePipeline = path.join(data.root, 'fake-pipeline.cjs');
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.PIECEMAKER_PIPELINE_PATH;
  });
  fs.writeFileSync(fakePipeline, [
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const source = path.resolve(args[0]);",
    "const output = path.resolve(args[args.indexOf('-o') + 1]);",
    "const caseRoot = path.resolve(args[args.indexOf('--case-root') + 1]);",
    "const mapping = args[args.indexOf('--mapping-file') + 1];",
    "const stateFile = args[args.indexOf('--state-file') + 1];",
    "fs.writeFileSync(path.join(output, `${path.basename(source, path.extname(source))}.md`), '# Converti\\n');",
    "fs.writeFileSync(mapping, JSON.stringify({ mapping: { Martin: 'PERSONNE_PHYSIQUE_01' }, reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Martin'] } }));",
    "const relative = path.relative(caseRoot, source).split(path.sep).join('/');",
    "const key = crypto.createHash('sha256').update(relative).digest('hex');",
    "const stat = fs.statSync(source);",
    "fs.mkdirSync(path.dirname(stateFile), { recursive: true });",
    "fs.writeFileSync(stateFile, JSON.stringify({ version: 1, files: { [key]: { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) } } }));",
  ].join('\n'));
  process.env.PYTHON_PATH = process.execPath;
  process.env.PIECEMAKER_PIPELINE_PATH = fakePipeline;

  const started = await startJob(t, {
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'anonymize',
    files: ['pièces originales/annexe.docx'],
  });
  const finished = await waitForJob(started.id);
  assert.equal(finished.state, 'done', describeJob(finished));
  assert.equal((await listOriginals(data.caseRoot)).find((file) => file.name === 'annexe.docx').scanned, true);
  // Le mapping vit désormais dans le sous-dossier des fichiers produits, pas à la racine.
  assert.deepEqual(
    fs.readdirSync(data.caseRoot).filter((name) => /^mapping.*\.json$/i.test(name)),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(data.caseRoot, WORKSPACE_SUBDIR)).filter((name) => /^mapping.*\.json$/i.test(name)),
    ['mapping_default.json'],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(data.caseRoot, WORKSPACE_SUBDIR)).filter((name) => /_sensitive_map\.json$/i.test(name)),
    [],
  );
});

test('un scan en échec ne migre pas prématurément les anciens mappings', async (t) => {
  const data = fixture();
  const failingPipeline = path.join(data.root, 'failing-pipeline.cjs');
  const legacy = path.join(data.caseRoot, 'mapping_dossier.json');
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.PIECEMAKER_PIPELINE_PATH;
  });
  fs.writeFileSync(legacy, JSON.stringify({ mapping: { Martin: 'PERSONNE_PHYSIQUE_01' } }));
  fs.writeFileSync(failingPipeline, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const workingMapping = args[args.indexOf('--mapping-file') + 1];",
    "fs.writeFileSync(workingMapping, JSON.stringify({ mapping: { Perdu: 'PERSONNE_PHYSIQUE_02' } }));",
    "process.exit(1);",
  ].join('\n'));
  process.env.PYTHON_PATH = process.execPath;
  process.env.PIECEMAKER_PIPELINE_PATH = failingPipeline;

  const finished = await waitForJob((await startJob(t, {
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'anonymize',
    files: ['pièces originales/annexe.docx'],
  })).id);
  assert.equal(finished.state, 'error');
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(path.join(data.caseRoot, 'mapping_default.json')), false);
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
  const started = await startJob(t, {
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir,
    action: 'convert',
    files: [annexe.path],
  });
  const finished = await waitForJob(started.id);
  assert.equal(finished.state, 'done', describeJob(finished));
  assert.equal(finished.result.commit.created, true);
  assert.equal((await listOriginals(data.caseRoot)).find((file) => file.name === 'annexe.docx').converted, true);
  assert.deepEqual(finished.result.commit.files.map((file) => file.path), [`${WORKSPACE_SUBDIR}/annexe.md`]);
  assert.match((await listHistory(data.casesRoot, homeDir, { caseName: 'Dossier Alpha' }))[0].subject, /Conversion de 1 pièce/);

  const pending = await worktreeDetails(data.casesRoot, homeDir, 'Dossier Alpha', 'autre-session.json');
  assert.equal(pending.filesCount, 1);
  assert.equal(pending.selectedFile.path, 'autre-session.json');
});

test('le verrou porte sur la racine du dossier, pas sur son nom', async (t) => {
  // Deux cabinets, deux racines, un dossier de même nom : un traitement en cours
  // sur l'un ne doit rien empêcher sur l'autre. Le verrou comparait le seul nom
  // du dossier, si bien qu'un travail lent en bloquait un sans rapport.
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
  });

  // Un convertisseur qui ne rend jamais la main : le premier travail est
  // certainement encore `running` quand le second démarre. Sans cela le test
  // passerait même avec le verrou fautif, le premier ayant déjà fini.
  const slowConverter = path.join(first.root, 'slow-converter.cjs');
  fs.writeFileSync(slowConverter, 'setTimeout(() => {}, 60_000);\n');
  process.env.PYTHON_PATH = process.execPath;
  process.env.SMART_CONVERTER_PATH = slowConverter;

  const running = await startJob(t, {
    casesRoot: first.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'convert',
    files: ['pièces originales/contrat.pdf'],
  });
  const other = await startJob(t, {
    casesRoot: second.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'convert',
    files: ['pièces originales/annexe.docx'],
  });
  assert.notEqual(other.id, running.id);

  assert.equal(getJob(running.id).state, 'running');
  assert.equal(getJob(other.id).state, 'running');

  // Sur la même racine, en revanche, le verrou tient toujours.
  await assert.rejects(
    startOriginalsJob({
      casesRoot: first.casesRoot,
      caseName: 'Dossier Alpha',
      action: 'convert',
      files: ['pièces originales/annexe.docx'],
    }),
    /déjà en cours/
  );
  // Les deux travaux sont tués par le `t.after` de `startJob`.
});

/** Un script Node qui ne rend jamais la main : garde un traitement `running`. */
function writeHang(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'setTimeout(() => {}, 60_000);\n');
  return file;
}

test('un seul scan GLiNER à la fois : le dossier suivant passe en file', async (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.PIECEMAKER_PIPELINE_PATH;
  });
  // Le scan anonymize passe par le pipeline : on le remplace par un process qui
  // ne finit jamais, pour tenir le premier `running` sans charger GLiNER.
  process.env.PYTHON_PATH = process.execPath;
  process.env.PIECEMAKER_PIPELINE_PATH = writeHang(first.root, 'slow-pipeline.cjs');

  const running = await startJob(t, { casesRoot: first.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });
  const queued = await startJob(t, { casesRoot: second.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });

  assert.equal(getJob(running.id).state, 'running');
  assert.equal(queued.state, 'queued');
  assert.equal(queued.queuePosition, 1);

  // Le premier terminé (ici annulé), le second démarre de lui-même.
  cancelOriginalsJob(running.id);
  assert.equal(await waitUntil(() => getJob(queued.id)?.state === 'running'), true,
    'le second scan doit démarrer une fois le premier fini');
});

test('les conversions sont plafonnées par la RAM, puis reprennent', async (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
    delete process.env.PIECEMAKER_RAM_BUDGET_BYTES;
    delete process.env.PIECEMAKER_CONVERT_JOB_BYTES;
  });
  process.env.PYTHON_PATH = process.execPath;
  process.env.SMART_CONVERTER_PATH = writeHang(first.root, 'slow-converter.cjs');
  // Budget qui ne laisse tenir qu'une conversion à la fois.
  process.env.PIECEMAKER_CONVERT_JOB_BYTES = '1000';
  process.env.PIECEMAKER_RAM_BUDGET_BYTES = '1500';

  const running = await startJob(t, { casesRoot: first.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/contrat.pdf'] });
  const queued = await startJob(t, { casesRoot: second.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/annexe.docx'] });

  assert.equal(getJob(running.id).state, 'running');
  assert.equal(queued.state, 'queued');

  cancelOriginalsJob(running.id);
  assert.equal(await waitUntil(() => getJob(queued.id)?.state === 'running'), true,
    'la conversion en file doit reprendre quand la RAM se libère');
});

test('sous le budget, deux conversions tournent en parallèle', async (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
    delete process.env.PIECEMAKER_RAM_BUDGET_BYTES;
    delete process.env.PIECEMAKER_CONVERT_JOB_BYTES;
  });
  process.env.PYTHON_PATH = process.execPath;
  process.env.SMART_CONVERTER_PATH = writeHang(first.root, 'slow-converter.cjs');
  process.env.PIECEMAKER_CONVERT_JOB_BYTES = '1000';
  process.env.PIECEMAKER_RAM_BUDGET_BYTES = '10000';

  const a = await startJob(t, { casesRoot: first.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/contrat.pdf'] });
  const b = await startJob(t, { casesRoot: second.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/annexe.docx'] });

  assert.equal(getJob(a.id).state, 'running');
  assert.equal(getJob(b.id).state, 'running');
});

test('un traitement annulé en file ne démarre jamais', async (t) => {
  const first = fixture();
  const second = fixture();
  t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
    delete process.env.PIECEMAKER_RAM_BUDGET_BYTES;
    delete process.env.PIECEMAKER_CONVERT_JOB_BYTES;
  });
  process.env.PYTHON_PATH = process.execPath;
  process.env.SMART_CONVERTER_PATH = writeHang(first.root, 'slow-converter.cjs');
  process.env.PIECEMAKER_CONVERT_JOB_BYTES = '1000';
  process.env.PIECEMAKER_RAM_BUDGET_BYTES = '1500';

  const running = await startJob(t, { casesRoot: first.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/contrat.pdf'] });
  const queued = await startJob(t, { casesRoot: second.casesRoot, caseName: 'Dossier Alpha', action: 'convert', files: ['pièces originales/annexe.docx'] });
  assert.equal(queued.state, 'queued');

  const cancelled = cancelOriginalsJob(queued.id);
  assert.equal(cancelled.state, 'error');
  // Il ne doit jamais passer `running`, même en laissant du temps s'écouler.
  const startedAnyway = await waitUntil(() => getJob(queued.id)?.state === 'running', 20);
  assert.equal(startedAnyway, false);
  assert.equal(getJob(running.id).state, 'running');
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

test('un convertisseur qui échoue termine le travail en erreur, jamais bloqué', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.PYTHON_PATH;
    delete process.env.SMART_CONVERTER_PATH;
  });

  // Deux façons d'échouer, toutes deux résolues sans créer de processus fils :
  // le test doit rester déterministe même quand la machine est saturée par les
  // autres fichiers de test (un simple spawn y a été mesuré à plus d'une minute).

  // 1. Script de conversion absent : refusé avant tout spawn.
  process.env.SMART_CONVERTER_PATH = path.join(data.root, 'smart_converter.py');
  const missingScript = await waitForJob((await startJob(t, {
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'convert',
    files: ['pièces originales/contrat.pdf'],
  })).id);
  assert.equal(missingScript.state, 'error');
  assert.match(missingScript.error, /smart_converter\.py/);

  // 2. Interpréteur introuvable : `spawn` émet « error », pas « close ».
  delete process.env.SMART_CONVERTER_PATH;
  process.env.PYTHON_PATH = path.join(data.root, 'python-inexistant');
  const started = await startJob(t, {
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    action: 'convert',
    files: ['pièces originales/contrat.pdf'],
  });
  assert.equal(started.state, 'running');
  assert.deepEqual(started.files, ['pièces originales/contrat.pdf']);
  const spawnFailure = await waitForJob(started.id);
  assert.equal(spawnFailure.state, 'error');
  assert.match(spawnFailure.error, /ENOENT|python-inexistant/);
});

test('les écritures d’une même personne partagent un code et gardent leurs variants', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  // Mapping tel que le produit le pipeline Python : variants dans extracted_data.
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_default.json'), `${JSON.stringify({
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

test('les anciens mappings convergent vers le seul mapping_default.json', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_default.json'), `${JSON.stringify({ mapping: { Egaré: 'AUTRE_01' } })}\n`);
  fs.writeFileSync(path.join(data.caseRoot, 'mapping_dossier.json'), `${JSON.stringify({ mapping: { Martin: 'PERSONNE_PHYSIQUE_01' } })}\n`);

  assert.equal(path.basename(caseMappingFile(data.caseRoot)), 'mapping_default.json');
  const merged = readCaseMapping(data.caseRoot);
  assert.deepEqual(new Set(Object.keys(merged.mapping)), new Set(['Egaré', 'Martin']));
  writeCaseMapping(data.caseRoot, merged);
  assert.equal(fs.existsSync(path.join(data.caseRoot, 'mapping_dossier.json')), false);
  // Toutes les copies racine (legacy comme `mapping_default.json`) sont retirées ;
  // le fichier canonique unique vit dans le sous-dossier des fichiers produits.
  assert.deepEqual(
    fs.readdirSync(data.caseRoot).filter((name) => /^mapping.*\.json$/i.test(name)),
    [],
  );
  assert.deepEqual(
    fs.readdirSync(path.join(data.caseRoot, WORKSPACE_SUBDIR)).filter((name) => /^mapping.*\.json$/i.test(name)),
    ['mapping_default.json'],
  );
});

test('sans sélection, un traitement ne refait que les pièces incomplètes', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  // Ce test porte sur la sélection, pas sur l'exécution : un interpréteur
  // introuvable fait échouer le spawn immédiatement (ENOENT) au lieu de lancer
  // un vrai processus, dont l'arrivée peut prendre plus d'une minute quand les
  // autres fichiers de test saturent le disque — et un travail resté « running »
  // bloque les tests suivants sur le même dossier.
  process.env.PYTHON_PATH = path.join(data.root, 'python-inexistant');
  t.after(() => { delete process.env.PYTHON_PATH; });
  // contrat.pdf a son Markdown et son scan ; annexe.docx n'a rien.
  markScanned(data.caseRoot, 'pièces originales/contrat.pdf');

  const job = await startJob(t, { casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });
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
  markScanned(data.caseRoot, 'pièces originales/contrat.pdf', 'pièces originales/annexe.docx');

  const job = await startJob(t, { casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize' });
  assert.equal(job.state, 'done');
  assert.equal(job.result.upToDate, true);
  assert.equal(job.result.skipped, 2);
  assert.deepEqual(job.files, []);

  // Une sélection explicite vaut demande de retraitement, elle relance le script.
  const forced = await startJob(t, {
    casesRoot: data.casesRoot, caseName: 'Dossier Alpha', action: 'anonymize', files: ['pièces originales/contrat.pdf'],
  });
  assert.equal(forced.state, 'running');
  assert.deepEqual(forced.files, ['pièces originales/contrat.pdf']);
  await waitForJob(forced.id);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const JSZip = require('jszip');

const {
  caseOverview,
  checkoutHistoryBranch,
  createCommit,
  createHistoryBranch,
  historyMonths,
  historyRepo,
  historyBranches,
  listCases,
  logPerformance,
  listHistory,
  listHistoryPeriod,
  parseCommitTrailers,
  repositoryOverview,
  resolveCommitIdentity,
  resolveCase,
  restoreRevision,
  revisionDetails,
  safeCaseFiles,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const { isProtectedFile, writeProtection, WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');
const { createLegalCase } = require('../websocket-server/admin-routes.cjs');

process.env.PIECEMAKER_USER_NAME = 'Utilisateur Test';

const commitHook = path.resolve(__dirname, '..', 'piecemaker-plugin', 'scripts', 'commit-track.mjs');
const originalsHook = path.resolve(__dirname, '..', 'piecemaker-plugin', 'scripts', 'protect-originals.mjs');

function git(gitDir, cwd, args) {
  const result = spawnSync('git', [`--git-dir=${gitDir}`, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

async function writeDocx(file, text, {
  compression = 'DEFLATE',
  date = new Date('2024-01-01T00:00:00Z'),
  documentBody = `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`,
} = {}) {
  const zip = new JSZip();
  const options = { date };
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', options);
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentBody}</w:body></w:document>`, options);
  zip.file('word/styles.xml', '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', options);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression }));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-cases-test-'));
  const casesRoot = path.join(root, 'PieceMaker');
  const home = path.join(root, 'home', '.piecemaker');
  const caseA = path.join(casesRoot, 'Dossier Alpha');
  const caseB = path.join(casesRoot, 'Dossier Beta');
  const originals = path.join(caseA, 'pièces originales');
  fs.mkdirSync(originals, { recursive: true });
  fs.mkdirSync(caseB, { recursive: true });
  fs.mkdirSync(path.join(casesRoot, 'PieceMaker_Output'), { recursive: true });
  fs.writeFileSync(path.join(originals, 'contrat.pdf'), 'CONTENU ORIGINAL SECRET\n');
  fs.writeFileSync(path.join(caseA, 'contrat.md'), '# Contrat anonymisé v1\n');
  fs.writeFileSync(path.join(caseA, 'contrat_sensitive_map.json'), '{"entities":[]}\n');
  fs.writeFileSync(path.join(caseB, 'memoire.md'), '# Mémoire Beta\n');
  return { root, casesRoot, home, caseA, caseB, originals };
}

function writeConfig(data) {
  fs.mkdirSync(data.home, { recursive: true });
  fs.writeFileSync(path.join(data.home, 'config.json'), `${JSON.stringify({ caseFolders: [data.caseA, data.caseB] })}\n`);
}

test('le journal de performance signale les opérations lentes avec leurs métriques', () => {
  const messages = [];
  const originalWarn = console.warn;
  console.warn = (...args) => messages.push(args);
  try {
    const durationMs = logPerformance('testOperation', performance.now() - 300, { files: 42 });
    assert.ok(durationMs >= 250);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0], '[PM-PERF] testOperation');
  assert.equal(messages[0][1].files, 42);
  assert.ok(messages[0][1].durationMs >= 250);
});

test('chaque dossier juridique possède un historique indépendant sans pièces originales', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const alpha = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'État Alpha' });
  const beta = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Beta', homeDir: data.home, label: 'État Beta' });
  assert.equal(alpha.created, true);
  assert.equal(beta.created, true);
  assert.notEqual(alpha.commit, beta.commit);

  const alphaCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const alphaGit = historyRepo(data.home, alphaCase);
  const files = git(alphaGit, data.caseA, ['ls-tree', '-r', '--name-only', alpha.commit]).split('\n');
  assert.deepEqual(files, ['contrat.md', 'contrat_sensitive_map.json']);
  assert.ok(!files.some((file) => file.includes('original')));
  assert.deepEqual(await safeCaseFiles(data.caseA), ['contrat_sensitive_map.json', 'contrat.md']);
  assert.equal(fs.readFileSync(path.join(data.originals, 'contrat.pdf'), 'utf8'), 'CONTENU ORIGINAL SECRET\n');
});

test('chaque commit porte le nom protégé dans le env global', async (t) => {
  const data = fixture();
  const envFile = path.join(data.root, '.env');
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(envFile, 'PIECEMAKER_USER_NAME=Alice Martin\n', { mode: 0o600 });

  const first = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    envFile,
    label: 'État signé par Alice',
  });
  const legalCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const gitDir = historyRepo(data.home, legalCase);
  assert.equal(
    git(gitDir, data.caseA, ['show', '-s', '--format=%an%x1f%ae%x1f%cn%x1f%ce', first.commit]),
    'Alice Martin\x1fcommits@piecemaker.local\x1fAlice Martin\x1fcommits@piecemaker.local',
  );

  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Version suivante\n');
  fs.writeFileSync(envFile, 'PIECEMAKER_USER_NAME=Bob Dupont\n', { mode: 0o600 });
  const second = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    envFile,
    label: 'État signé par Bob',
  });
  assert.equal(git(gitDir, data.caseA, ['show', '-s', '--format=%an', second.commit]), 'Bob Dupont');
  assert.deepEqual(
    (await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' })).map((entry) => entry.author),
    ['Bob Dupont', 'Alice Martin'],
  );
});

test('un nom invalide est refusé pour la signature des commits', () => {
  assert.throws(() => resolveCommitIdentity({ identity: { name: 'Alice <admin>' } }), /Nom utilisateur invalide/);
  assert.throws(() => resolveCommitIdentity({ identity: { name: '' } }), /Identité utilisateur absente/);
});

// Régression : lancé depuis le cache du plugin, le hook d'édition n'a ni `.env`
// (résolu à côté du clone runtime, inexistant) ni variable d'environnement.
// L'identité doit alors venir de ~/.piecemaker/config.json.
test('sans .env ni variable d’environnement, l’identité vient de config.json', () => {
  const previous = process.env.PIECEMAKER_USER_NAME;
  delete process.env.PIECEMAKER_USER_NAME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-identity-config-'));
  const configFile = path.join(dir, 'config.json');
  const absentEnv = path.join(dir, 'absent.env');
  try {
    fs.writeFileSync(configFile, JSON.stringify({ commits: { enabled: true, userName: 'Camille Config' } }));
    assert.equal(resolveCommitIdentity({ envFile: absentEnv, configFile }).name, 'Camille Config');
    // config.json sans nom → l'erreur d'identité absente est bien levée.
    fs.writeFileSync(configFile, JSON.stringify({ commits: { enabled: true } }));
    assert.throws(() => resolveCommitIdentity({ envFile: absentEnv, configFile }), /Identité utilisateur absente/);
  } finally {
    if (previous === undefined) delete process.env.PIECEMAKER_USER_NAME;
    else process.env.PIECEMAKER_USER_NAME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('les branches séparent les commits automatiques du dossier', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const initial = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'État initial' });

  await createHistoryBranch({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, name: 'analyse-alternative' });
  assert.deepEqual(await historyBranches(data.casesRoot, data.home, 'Dossier Alpha'), {
    active: 'analyse-alternative',
    branches: ['analyse-alternative', 'main'],
  });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Version branche\n');
  const automatic = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Conversion automatique',
    event: 'admin-originals-convert',
    paths: ['contrat.md'],
  });
  assert.equal(automatic.parent, initial.commit);

  await checkoutHistoryBranch({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, name: 'main' });
  const mainHistory = await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' });
  assert.deepEqual(mainHistory.map((entry) => entry.hash), [initial.commit]);
  await checkoutHistoryBranch({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, name: 'analyse-alternative' });
  assert.deepEqual((await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' })).map((entry) => entry.hash), [automatic.commit, initial.commit]);
});

test('la création d’un dossier installe mapping, protection et historique main', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const folder = await createLegalCase({ casesRoot: data.casesRoot, homeDir: data.home, name: 'Dossier Gamma' });
  const gamma = path.join(data.casesRoot, 'Dossier Gamma');

  assert.equal(folder.name, 'Dossier Gamma');
  assert.equal(fs.existsSync(path.join(gamma, WORKSPACE_SUBDIR, 'mapping_default.json')), true);
  assert.equal(fs.existsSync(path.join(gamma, '.piecemaker', 'protection.json')), true);
  assert.deepEqual(folder.branches, { active: 'main', branches: ['main'] });
  const history = await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Gamma' });
  assert.equal(history.length, 1);
  assert.equal(history[0].subject, 'Création du dossier juridique');
});

test('l’aperçu expose les métadonnées et le niveau de protection de chaque pièce', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.originals, 'conclusions.docx'), 'ORIGINAL 2');
  fs.writeFileSync(path.join(data.caseA, 'conclusions.md'), '# Conclusions\n');
  fs.writeFileSync(path.join(data.originals, 'annexe.png'), 'ORIGINAL 3');
  // Une pièce rangée à plat, hors de tout sous-dossier dédié : c'est le cas
  // courant, et l'ancien recensement par nom de dossier la laissait invisible.
  fs.writeFileSync(path.join(data.caseA, 'note.docx'), 'ORIGINAL 4');

  const overview = await repositoryOverview(data.casesRoot, data.home);
  assert.deepEqual(overview.folders.map((folder) => folder.name), ['Dossier Alpha', 'Dossier Beta']);
  const alpha = overview.folders[0];
  assert.deepEqual(alpha.originals.map((file) => file.path).sort(), [
    'note.docx',
    'pièces originales/annexe.png',
    'pièces originales/conclusions.docx',
    'pièces originales/contrat.pdf',
  ]);
  assert.equal(alpha.originals.find((file) => file.name === 'contrat.pdf').status, 'ready');
  assert.equal(alpha.originals.find((file) => file.name === 'conclusions.docx').status, 'awaiting-scan');
  assert.equal(alpha.originals.find((file) => file.name === 'annexe.png').status, 'not-converted');
  // Markdown et JSON ne sont jamais des pièces : ce sont les surfaces que l'IA
  // lit à travers le mapping.
  assert.ok(!alpha.originals.some((file) => ['.md', '.json'].includes(file.extension)));
  // Protégé par défaut : aucune exception n'a été enregistrée.
  assert.equal(alpha.protectedOriginals, 4);
  assert.ok(alpha.originals.every((file) => file.protected));
  assert.ok(alpha.originals.every((file) => !Object.hasOwn(file, 'content')));
});

test('une exception enregistrée rend une pièce accessible sans toucher aux autres', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseA, 'note.docx'), 'ORIGINAL 4');
  writeProtection(data.caseA, { unprotected: ['note.docx'] });

  const alpha = await caseOverview(data.casesRoot, data.home, 'Dossier Alpha');
  assert.equal(alpha.originals.find((file) => file.name === 'note.docx').protected, false);
  assert.equal(alpha.originals.find((file) => file.name === 'contrat.pdf').protected, true);
  assert.equal(alpha.protectedOriginals, 1);

  // La décision est bien ce que voit le hook, pas seulement l'administration.
  assert.equal(isProtectedFile(path.join(data.caseA, 'note.docx'), data.caseA), false);
  assert.equal(isProtectedFile(path.join(data.originals, 'contrat.pdf'), data.caseA), true);
});

test('l’index léger exclut le dossier de sortie et le détail ne calcule qu’un dossier', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const index = listCases(data.casesRoot);
  assert.deepEqual(index.folders.map((folder) => folder.name), ['Dossier Alpha', 'Dossier Beta']);
  assert.ok(index.folders.every((folder) => !Object.hasOwn(folder, 'workingChanges')));

  const alpha = await caseOverview(data.casesRoot, data.home, 'Dossier Alpha');
  assert.equal(alpha.name, 'Dossier Alpha');
  assert.equal(alpha.snapshot.length, 40);
  assert.deepEqual(alpha.originals.map((file) => file.path), ['pièces originales/contrat.pdf']);
});

test('les modifications sont calculées par rapport au dernier commit complet du dossier', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 1' });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat anonymisé v2\n');

  const worktree = await worktreeDetails(data.casesRoot, data.home, 'Dossier Alpha', 'contrat.md');
  assert.equal(worktree.kind, 'worktree');
  assert.equal(worktree.filesCount, 1);
  assert.equal(worktree.selectedFile.path, 'contrat.md');
  assert.match(worktree.patch, /Contrat anonymisé v2/);

  const version2 = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 2' });
  const history = await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' });
  assert.equal(history[0].hash, version2.commit);
  assert.equal(history[0].subject, 'Version 2');
  assert.equal(Object.hasOwn(history[0], 'filesCount'), false);
  assert.equal(Object.hasOwn(history[0], 'files'), false);
  const details = await revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', version2.commit);
  assert.equal(details.kind, 'commit');
  assert.equal(details.filesCount, 1);
  assert.deepEqual(details.files.map((file) => file.path), ['contrat.md']);
  assert.equal(details.selectedPath, '');
  assert.equal(details.patch, '');

  const selected = await revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', version2.commit, 'contrat.md');
  assert.equal(selected.selectedFile.path, 'contrat.md');
  assert.match(selected.patch, /Contrat anonymisé v2/);
});

test('un DOCX modifié est détecté par sa structure OOXML sans ralentir le chemin propre', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const document = path.join(data.caseA, 'conclusions.docx');
  await writeDocx(document, 'Version confidentielle 1', { compression: 'STORE' });
  const protectedDocument = path.join(data.caseA, 'piece-protegee.docx');
  await writeDocx(protectedDocument, 'Secret protégé', { compression: 'STORE' });
  writeProtection(data.caseA, { unprotected: ['conclusions.docx'] });

  const baseline = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Version Word initiale',
  });
  const legalCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const gitDir = historyRepo(data.home, legalCase);
  const treeFiles = git(gitDir, data.caseA, ['ls-tree', '-r', '--name-only', baseline.commit]).split('\n');
  assert.ok(treeFiles.some((file) => file.endsWith('history-docx-ooxml.json')));
  assert.ok(!treeFiles.includes('conclusions.docx'), 'le binaire Word ne doit pas entrer dans Git');
  const manifest = git(gitDir, data.caseA, ['show', `${baseline.commit}:.piecemaker/history-docx-ooxml.json`]);
  assert.doesNotMatch(manifest, /Version confidentielle|word\/document\.xml/);
  const parsedManifest = JSON.parse(manifest);
  assert.ok(parsedManifest.files['conclusions.docx'].textDeflate, 'le texte déprotégé est conservé sous forme compressée');
  assert.equal(parsedManifest.files['piece-protegee.docx'].textDeflate, undefined, 'une pièce protégée ne livre aucun texte');
  assert.ok(Buffer.byteLength(manifest) < 1500, 'le manifeste doit rester compact');

  // Chemin chaud : taille/date identiques => aucun octet du DOCX n'est rouvert.
  const originalOpen = fs.promises.open;
  let docxOpens = 0;
  fs.promises.open = async (...args) => {
    if (path.extname(String(args[0])).toLowerCase() === '.docx') docxOpens += 1;
    return originalOpen.call(fs.promises, ...args);
  };
  try {
    await caseOverview(data.casesRoot, data.home, 'Dossier Alpha');
  } finally {
    fs.promises.open = originalOpen;
  }
  assert.equal(docxOpens, 0);

  // Un ré-empaquetage ZIP identique n'est pas une modification OOXML.
  await writeDocx(document, 'Version confidentielle 1', {
    compression: 'DEFLATE',
    date: new Date('2026-08-11T10:00:00Z'),
  });
  assert.ok(!(await caseOverview(data.casesRoot, data.home, 'Dossier Alpha')).workingChanges
    .some((file) => file.path === 'conclusions.docx'));

  // Même longueur, contenu OOXML différent : l'admin doit le voir.
  await writeDocx(document, 'Version confidentielle 2', {
    compression: 'DEFLATE',
    date: new Date('2026-08-11T10:00:00Z'),
    documentBody: '<w:p><w:del><w:r><w:delText>Version confidentielle 1</w:delText></w:r></w:del><w:ins><w:r><w:t>Version confidentielle 2</w:t></w:r></w:ins></w:p>',
  });
  await writeDocx(protectedDocument, 'Secret remplacé', { compression: 'DEFLATE' });
  const overview = await caseOverview(data.casesRoot, data.home, 'Dossier Alpha');
  assert.ok(overview.workingChanges.some((file) => file.path === 'conclusions.docx' && file.kind === 'modified'));
  const worktree = await worktreeDetails(data.casesRoot, data.home, 'Dossier Alpha', 'conclusions.docx', overview.snapshot);
  assert.match(worktree.patch, /-Version confidentielle 1/);
  assert.match(worktree.patch, /\+Version confidentielle 2/);
  assert.doesNotMatch(worktree.patch, /Empreinte OOXML|word\/document\.xml/);
  const protectedDiff = await worktreeDetails(data.casesRoot, data.home, 'Dossier Alpha', 'piece-protegee.docx', overview.snapshot);
  assert.match(protectedDiff.patch, /Document protégé/);
  assert.doesNotMatch(protectedDiff.patch, /Secret protégé|Secret remplacé/);

  const updated = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Modification Word',
  });
  assert.ok(updated.files.some((file) => file.path === 'conclusions.docx' && file.kind === 'modified'));
  const revision = await revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', updated.commit, 'conclusions.docx');
  assert.match(revision.patch, /-Version confidentielle 1/);
  assert.match(revision.patch, /\+Version confidentielle 2/);

  writeProtection(data.caseA, { unprotected: [] });
  const reprotected = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Protection réactivée',
  });
  const reprotectedManifest = JSON.parse(git(gitDir, data.caseA, [
    'show', `${reprotected.commit}:.piecemaker/history-docx-ooxml.json`,
  ]));
  assert.equal(reprotectedManifest.files['conclusions.docx'].textDeflate, undefined,
    'réactiver la protection retire le snapshot textuel du manifeste suivant');
  const hiddenRevision = await revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', updated.commit, 'conclusions.docx');
  assert.match(hiddenRevision.patch, /Document protégé/);
  assert.doesNotMatch(hiddenRevision.patch, /Version confidentielle/);
});

test('un commit automatique ciblé laisse les fichiers des autres sessions hors du commit', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'État initial' });

  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat modifié par la session A\n');
  fs.writeFileSync(path.join(data.caseA, 'contrat_sensitive_map.json'), '{"entities":["session B"]}\n');

  const scoped = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Modification ciblée',
    description: 'Le commentaire reste dans le corps du commit.',
    sessionId: 'session-a',
    event: 'PostToolUse',
    paths: ['contrat.md'],
  });
  assert.equal(scoped.created, true);
  assert.deepEqual(scoped.files.map((file) => file.path), ['contrat.md']);

  const legalCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const gitDir = historyRepo(data.home, legalCase);
  assert.equal(git(gitDir, data.caseA, ['show', `${scoped.commit}:contrat_sensitive_map.json`]), '{"entities":[]}');
  assert.match(git(gitDir, data.caseA, ['show', '-s', '--format=%B', scoped.commit]), /Le commentaire reste dans le corps/);

  const pending = await worktreeDetails(data.casesRoot, data.home, 'Dossier Alpha', 'contrat_sensitive_map.json');
  assert.equal(pending.filesCount, 1);
  assert.equal(pending.selectedFile.path, 'contrat_sensitive_map.json');
  assert.match(pending.patch, /session B/);
});

test('un diff volumineux est interrompu à la limite au lieu d’être entièrement mis en mémoire', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const huge = Array.from({ length: 90_000 }, (_, index) => `ligne ${index} — contenu de test`).join('\n');
  fs.writeFileSync(path.join(data.caseA, 'volumineux.md'), `${huge}\n`);
  const commit = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Gros diff' });

  const details = await revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', commit.commit, 'volumineux.md');
  assert.equal(details.truncated, true);
  assert.ok(Buffer.byteLength(details.patch, 'utf8') <= 768 * 1024 + 3);
});

test('les noms de fichiers français restent lisibles dans l’historique', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseA, 'mémoire spécial.md'), '# Mémoire\n');

  const overview = await repositoryOverview(data.casesRoot, data.home);
  const paths = overview.folders.find((folder) => folder.name === 'Dossier Alpha').workingChanges.map((file) => file.path);
  assert.ok(paths.includes('mémoire spécial.md'));
  assert.ok(paths.every((file) => !file.includes('\\303')));
});

test('la restauration crée un retour de sécurité et préserve toutes les originales', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const version1 = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 1' });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat anonymisé v2\n');
  const version2 = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 2' });
  fs.writeFileSync(path.join(data.caseB, 'memoire.md'), '# Beta inchangé\n');

  const restored = await restoreRevision({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, hash: version1.commit });
  assert.equal(restored.restored, true);
  assert.equal(restored.safetyCommit, version2.commit);
  assert.ok(restored.restorationCommit);
  assert.equal(restored.originalsPreserved, true);
  assert.equal(fs.readFileSync(path.join(data.caseA, 'contrat.md'), 'utf8'), '# Contrat anonymisé v1\n');
  assert.equal(fs.readFileSync(path.join(data.originals, 'contrat.pdf'), 'utf8'), 'CONTENU ORIGINAL SECRET\n');
  assert.equal(fs.readFileSync(path.join(data.caseB, 'memoire.md'), 'utf8'), '# Beta inchangé\n');

  await restoreRevision({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, hash: restored.safetyCommit });
  assert.equal(fs.readFileSync(path.join(data.caseA, 'contrat.md'), 'utf8'), '# Contrat anonymisé v2\n');
});

test('le PostToolUse alimente uniquement l’historique du dossier juridique concerné', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeConfig(data);
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Modifié par le hook\n');
  const result = spawnSync(process.execPath, [commitHook], {
    cwd: data.casesRoot,
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'hook-session',
      cwd: data.casesRoot,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(data.caseA, 'contrat.md') },
      tool_response: { success: true },
    }),
    env: { ...process.env, HOME: path.dirname(data.home) },
  });
  assert.equal(result.status, 0, result.stderr);
  const history = await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' });
  assert.equal(history.length, 1);
  assert.match(history[0].subject, /Modification de contrat\.md/);
  const alphaCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  assert.deepEqual(
    git(historyRepo(data.home, alphaCase), data.caseA, ['ls-tree', '-r', '--name-only', history[0].hash]).split('\n'),
    ['contrat.md'],
  );
  assert.deepEqual(await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Beta' }), []);
});

test('le garde-fou refuse une originale et autorise le Markdown converti', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeConfig(data);
  const env = { ...process.env, HOME: path.dirname(data.home) };
  const denied = spawnSync(process.execPath, [originalsHook], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(data.originals, 'contrat.pdf') },
    }),
    env,
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');

  // Le Markdown converti n'est lisible qu'une fois le dossier anonymisé : sans
  // mapping, `anonymize-read` ne pourrait rien coder et le hook refuse la lecture.
  // On pose donc le mapping du dossier, état dans lequel la pièce Markdown est bien
  // la surface anonymisée que l'IA a le droit de lire.
  fs.mkdirSync(path.join(data.caseA, WORKSPACE_SUBDIR), { recursive: true });
  fs.writeFileSync(
    path.join(data.caseA, WORKSPACE_SUBDIR, 'mapping_default.json'),
    JSON.stringify({ mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01' }, reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'] } }),
  );

  const allowed = spawnSync(process.execPath, [originalsHook], {
    encoding: 'utf8',
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(data.caseA, 'contrat.md') },
    }),
    env,
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, '');
});

test('le commit porte le session_id et le temps de session écoulé en trailers', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const commit = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Beta',
    homeDir: data.home,
    label: 'État Beta',
    sessionId: 'sess-XYZ-001',
    durationMs: 5 * 60 * 1000 + 7 * 1000, // 5 min 07 s
  });
  assert.equal(commit.created, true);
  assert.equal(commit.durationMs, 307000);

  const betaCase = resolveCase(data.casesRoot, 'Dossier Beta');
  const betaGit = historyRepo(data.home, betaCase);
  const body = git(betaGit, data.caseB, ['log', '-1', '--pretty=%b', commit.commit]);
  assert.match(body, /^PieceMaker-Session: sess-XYZ-001$/m);
  assert.match(body, /^PieceMaker-Temps-Session: 5 min 07 s \(307000 ms\)$/m);

  // Le trailer reste lisible dans le corps renvoyé par listHistory (%b).
  const [entry] = await listHistory(data.casesRoot, data.home, { caseName: 'Dossier Beta', limit: 1 });
  assert.match(entry.body, /PieceMaker-Session: sess-XYZ-001/);
});

test('sans sessionId ni durationMs, le commit reste sans trailer PieceMaker', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const commit = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Beta', homeDir: data.home, label: 'État Beta' });
  const betaCase = resolveCase(data.casesRoot, 'Dossier Beta');
  const body = git(historyRepo(data.home, betaCase), data.caseB, ['log', '-1', '--pretty=%b', commit.commit]);
  assert.doesNotMatch(body, /PieceMaker-Session|PieceMaker-Temps/);
});

test('parseCommitTrailers extrait sessionId et durationMs, et nettoie le corps', () => {
  const body = 'Un commentaire de session.\n\nPieceMaker-Session: sess-42\nPieceMaker-Temps-Session: 5 min 07 s (307000 ms)\n';
  const parsed = parseCommitTrailers(body);
  assert.equal(parsed.sessionId, 'sess-42');
  assert.equal(parsed.durationMs, 307000);
  assert.equal(parsed.comment, 'Un commentaire de session.');
  assert.doesNotMatch(parsed.comment, /PieceMaker-/);
});

test('parseCommitTrailers renvoie durationMs nul quand le trailer de temps est absent', () => {
  const parsed = parseCommitTrailers('Juste un commentaire.\nPieceMaker-Session: sess-99\n');
  assert.equal(parsed.sessionId, 'sess-99');
  assert.equal(parsed.durationMs, null);
  assert.equal(parsed.comment, 'Juste un commentaire.');
});

test('parseCommitTrailers sur un corps sans trailer ne renvoie ni session ni durée', () => {
  const parsed = parseCommitTrailers('');
  assert.equal(parsed.sessionId, null);
  assert.equal(parsed.durationMs, null);
  assert.equal(parsed.comment, '');
});

test('historyMonths et listHistoryPeriod exposent l’historique par mois avec les fichiers touchés', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const first = await createCommit({
    casesRoot: data.casesRoot,
    caseName: 'Dossier Alpha',
    homeDir: data.home,
    label: 'Version 1',
    sessionId: 'sess-mois-1',
    durationMs: 12_000,
  });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat anonymisé v2\n');
  const second = await createCommit({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 2' });

  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

  assert.deepEqual(await historyMonths(data.casesRoot, data.home, { caseName: 'Dossier Alpha' }), [currentMonth]);
  // Un dossier sans commit ne casse rien : court-circuit vide, comme listHistory.
  assert.deepEqual(await historyMonths(data.casesRoot, data.home, { caseName: 'Dossier Beta' }), []);

  const period = await listHistoryPeriod(data.casesRoot, data.home, { caseName: 'Dossier Alpha', since, until });
  assert.equal(period.length, 2);
  assert.deepEqual(period.map((entry) => entry.hash), [second.commit, first.commit]);

  const secondEntry = period.find((entry) => entry.hash === second.commit);
  const firstEntry = period.find((entry) => entry.hash === first.commit);
  assert.deepEqual(secondEntry.files, ['contrat.md']);
  assert.deepEqual(firstEntry.files.sort(), ['contrat.md', 'contrat_sensitive_map.json']);
  assert.equal(firstEntry.filesCount, 2);
  assert.equal(firstEntry.sessionId, 'sess-mois-1');
  assert.equal(firstEntry.durationMs, 12000);
  assert.equal(secondEntry.sessionId, null);
  assert.equal(secondEntry.durationMs, null);

  // Une période ne couvrant aucun de ces commits renvoie une liste vide.
  assert.deepEqual(
    await listHistoryPeriod(data.casesRoot, data.home, { caseName: 'Dossier Alpha', since: '2000-01-01', until: '2000-02-01' }),
    [],
  );
});

test('session-timing dérive le début de session et met en forme la durée', () => {
  const { formatDurationFr, readSessionStartTimestamp, sessionElapsedMs } = require('../piecemaker-plugin/scripts/lib/session-timing.cjs');
  assert.equal(formatDurationFr(8_000), '8 s');
  assert.equal(formatDurationFr(307_000), '5 min 07 s');
  assert.equal(formatDurationFr(3_900_000), '1 h 05 min');
  assert.equal(formatDurationFr(-1), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-timing-'));
  try {
    const transcript = path.join(dir, 't.jsonl');
    const start = new Date(Date.now() - 90_000).toISOString(); // il y a 90 s
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: start })}\n${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString() })}\n`);
    assert.equal(readSessionStartTimestamp(transcript), start);
    const elapsed = sessionElapsedMs(transcript);
    assert.ok(elapsed >= 89_000 && elapsed <= 120_000, `elapsed inattendu: ${elapsed}`);

    assert.equal(readSessionStartTimestamp(path.join(dir, 'absent.jsonl')), null);
    assert.equal(sessionElapsedMs(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

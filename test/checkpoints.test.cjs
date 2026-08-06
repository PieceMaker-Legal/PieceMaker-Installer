const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  createCheckpoint,
  historyRepo,
  listHistory,
  repositoryOverview,
  resolveCase,
  restoreRevision,
  revisionDetails,
  safeCaseFiles,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/checkpoints.cjs');

const checkpointHook = path.resolve(__dirname, '..', 'piecemaker-plugin', 'scripts', 'checkpoint-track.mjs');
const originalsHook = path.resolve(__dirname, '..', 'piecemaker-plugin', 'scripts', 'protect-originals.mjs');

function git(gitDir, cwd, args) {
  const result = spawnSync('git', [`--git-dir=${gitDir}`, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
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
  fs.writeFileSync(path.join(originals, 'contrat.pdf'), 'CONTENU ORIGINAL SECRET\n');
  fs.writeFileSync(path.join(caseA, 'contrat.md'), '# Contrat anonymisé v1\n');
  fs.writeFileSync(path.join(caseA, 'contrat_sensitive_map.json'), '{"entities":[]}\n');
  fs.writeFileSync(path.join(caseB, 'memoire.md'), '# Mémoire Beta\n');
  return { root, casesRoot, home, caseA, caseB, originals };
}

function writeConfig(data) {
  fs.mkdirSync(data.home, { recursive: true });
  fs.writeFileSync(path.join(data.home, 'config.json'), `${JSON.stringify({ outputPath: data.casesRoot })}\n`);
}

test('chaque dossier juridique possède un historique indépendant sans pièces originales', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const alpha = createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'État Alpha' });
  const beta = createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Beta', homeDir: data.home, label: 'État Beta' });
  assert.equal(alpha.created, true);
  assert.equal(beta.created, true);
  assert.notEqual(alpha.commit, beta.commit);

  const alphaCase = resolveCase(data.casesRoot, 'Dossier Alpha');
  const alphaGit = historyRepo(data.home, alphaCase);
  const files = git(alphaGit, data.caseA, ['ls-tree', '-r', '--name-only', alpha.commit]).split('\n');
  assert.deepEqual(files, ['contrat.md', 'contrat_sensitive_map.json']);
  assert.ok(!files.some((file) => file.includes('original')));
  assert.deepEqual(safeCaseFiles(data.caseA), ['contrat_sensitive_map.json', 'contrat.md']);
  assert.equal(fs.readFileSync(path.join(data.originals, 'contrat.pdf'), 'utf8'), 'CONTENU ORIGINAL SECRET\n');
});

test('l’aperçu expose les métadonnées et le niveau de protection de chaque originale', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.originals, 'conclusions.docx'), 'ORIGINAL 2');
  fs.writeFileSync(path.join(data.caseA, 'conclusions.md'), '# Conclusions\n');
  fs.writeFileSync(path.join(data.originals, 'annexe.png'), 'ORIGINAL 3');

  const overview = repositoryOverview(data.casesRoot, data.home);
  assert.deepEqual(overview.folders.map((folder) => folder.name), ['Dossier Alpha', 'Dossier Beta']);
  const alpha = overview.folders[0];
  assert.equal(alpha.originals.length, 3);
  assert.equal(alpha.originals.find((file) => file.name === 'contrat.pdf').status, 'protected');
  assert.equal(alpha.originals.find((file) => file.name === 'conclusions.docx').status, 'awaiting-scan');
  assert.equal(alpha.originals.find((file) => file.name === 'annexe.png').status, 'not-converted');
  assert.equal(alpha.protectedOriginals, 1);
  assert.ok(alpha.originals.every((file) => !Object.hasOwn(file, 'content')));
});

test('les modifications et commits sont calculés par rapport au dernier checkpoint du dossier', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 1' });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat anonymisé v2\n');

  const worktree = worktreeDetails(data.casesRoot, data.home, 'Dossier Alpha', 'contrat.md');
  assert.equal(worktree.kind, 'worktree');
  assert.deepEqual(worktree.files.map((file) => file.path), ['contrat.md']);
  assert.match(worktree.patch, /Contrat anonymisé v2/);

  const version2 = createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 2' });
  const history = listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' });
  assert.equal(history[0].hash, version2.commit);
  assert.equal(history[0].subject, 'Version 2');
  const details = revisionDetails(data.casesRoot, data.home, 'Dossier Alpha', version2.commit);
  assert.equal(details.kind, 'checkpoint');
  assert.match(details.patch, /Contrat anonymisé v2/);
});

test('la restauration crée un retour de sécurité et préserve toutes les originales', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const version1 = createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 1' });
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Contrat anonymisé v2\n');
  const version2 = createCheckpoint({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, label: 'Version 2' });
  fs.writeFileSync(path.join(data.caseB, 'memoire.md'), '# Beta inchangé\n');

  const restored = restoreRevision({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, hash: version1.commit });
  assert.equal(restored.restored, true);
  assert.equal(restored.safetyCheckpoint, version2.commit);
  assert.ok(restored.restorationCheckpoint);
  assert.equal(restored.originalsPreserved, true);
  assert.equal(fs.readFileSync(path.join(data.caseA, 'contrat.md'), 'utf8'), '# Contrat anonymisé v1\n');
  assert.equal(fs.readFileSync(path.join(data.originals, 'contrat.pdf'), 'utf8'), 'CONTENU ORIGINAL SECRET\n');
  assert.equal(fs.readFileSync(path.join(data.caseB, 'memoire.md'), 'utf8'), '# Beta inchangé\n');

  restoreRevision({ casesRoot: data.casesRoot, caseName: 'Dossier Alpha', homeDir: data.home, hash: restored.safetyCheckpoint });
  assert.equal(fs.readFileSync(path.join(data.caseA, 'contrat.md'), 'utf8'), '# Contrat anonymisé v2\n');
});

test('le PostToolUse alimente uniquement l’historique du dossier juridique concerné', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeConfig(data);
  fs.writeFileSync(path.join(data.caseA, 'contrat.md'), '# Modifié par le hook\n');
  const result = spawnSync(process.execPath, [checkpointHook], {
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
  const history = listHistory(data.casesRoot, data.home, { caseName: 'Dossier Alpha' });
  assert.equal(history.length, 1);
  assert.match(history[0].subject, /Modification de contrat\.md/);
  assert.deepEqual(listHistory(data.casesRoot, data.home, { caseName: 'Dossier Beta' }), []);
});

test('le garde-fou refuse une originale et autorise le Markdown converti', (t) => {
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

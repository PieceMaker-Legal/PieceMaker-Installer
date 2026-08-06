const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { configuredWorkspacePath, resolveLegalCaseFolder } = require('../websocket-server/workspace-paths.cjs');

test('l’historique utilise la racine PieceMaker, jamais le dossier de sortie technique', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-workspace-test-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const workspacePath = path.join(root, 'dossiers-juridiques');
  const outputPath = path.join(root, 'output', 'models');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ workspacePath, outputPath }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(configuredWorkspacePath(home), workspacePath);
  assert.notEqual(configuredWorkspacePath(home), outputPath);
});

test('une racine juridique absente demande de relancer l’étape dédiée', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-workspace-test-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ outputPath: path.join(root, 'output') }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => configuredWorkspacePath(home), /Dossier racine PieceMaker/);
});

test('un document est toujours ramené à son dossier juridique sous workspacePath', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-routing-test-'));
  const workspace = path.join(root, 'PieceMaker');
  const legalCase = path.join(workspace, 'Dossier Dupont');
  const nested = path.join(legalCase, 'Actes', 'Projet');
  const outside = path.join(root, 'hors-workspace');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // macOS : /var est un lien vers /private/var, resolveLegalCaseFolder renvoie le chemin réel.
  assert.equal(resolveLegalCaseFolder(workspace, nested), fs.realpathSync(legalCase));
  assert.throws(() => resolveLegalCaseFolder(workspace, outside), /racine PieceMaker/);
});

test('la racine reçoit un CLAUDE.md, jamais écrasé au second passage', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'dossiers');
  process.env.PIECEMAKER_HOME = path.join(root, 'home');
  process.env.PIECEMAKER_WORKSPACE_PATH = workspace;
  t.after(() => {
    delete process.env.PIECEMAKER_HOME;
    delete process.env.PIECEMAKER_WORKSPACE_PATH;
  });

  const step = await import('../installer/steps/00-workspace.mjs');
  const claudeMd = path.join(workspace, 'CLAUDE.md');

  await step.install({ config: {} });
  assert.equal(fs.existsSync(claudeMd), true);
  assert.match(fs.readFileSync(claudeMd, 'utf8'), /Commits automatiques/);
  assert.equal((await step.check({ config: { workspacePath: workspace } })).status, 'done');

  fs.writeFileSync(claudeMd, '# Consignes du cabinet\n');
  await step.install({ config: {} });
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# Consignes du cabinet\n');

  fs.rmSync(claudeMd);
  assert.equal((await step.check({ config: { workspacePath: workspace } })).status, 'partial');
});

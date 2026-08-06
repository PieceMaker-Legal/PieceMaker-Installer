const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createManagedFile,
  isLocalOrigin,
  listManagedFiles,
  managedFileKind,
  readManagedFile,
  saveManagedFile,
  updateEnvFile,
} = require('../websocket-server/admin-routes.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-admin-test-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'skills', 'redaction'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n');
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'agents', 'analyse.md'), '# Analyse\n');
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'skills', 'redaction', 'SKILL.md'), '# Skill\n');
  return { root, repo, home };
}

test('seuls les fichiers Markdown PieceMaker explicitement prévus sont acceptés', () => {
  assert.equal(managedFileKind('AGENTS.md'), 'instructions');
  assert.equal(managedFileKind('piecemaker-plugin/agents/analyse.md'), 'agent');
  assert.equal(managedFileKind('piecemaker-plugin/skills/redaction/SKILL.md'), 'skill');
  assert.equal(managedFileKind('../secret.md'), null);
  assert.equal(managedFileKind('piecemaker-plugin/agents/nested/secret.md'), null);
});

test('la liste contient les instructions, skills et agents', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const files = listManagedFiles(data.repo, data.home);
  assert.deepEqual(files.map((file) => file.path), [
    'AGENTS.md',
    'CLAUDE.md',
    'piecemaker-plugin/agents/analyse.md',
    'piecemaker-plugin/skills/redaction/SKILL.md',
  ]);
  assert.equal(files[0].exists, false);
});

test('les synthèses de facturation sont listées en lecture seule', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const billingDir = path.join(data.home, 'billing', 'synthese');
  fs.mkdirSync(billingDir, { recursive: true });
  fs.writeFileSync(path.join(billingDir, 'session-2026.md'), '# Facturation\n');
  fs.writeFileSync(path.join(data.home, 'billing', '2026-08.jsonl'), `${JSON.stringify({
    timestamp: '2026-08-06T08:00:00.000Z', event: 'Stop', task_label: 'Analyse', dossier: 'Martin', duration_ms: 65000,
  })}\n`);
  const billingFiles = listManagedFiles(data.repo, data.home).filter((file) => file.kind === 'billing');
  const report = billingFiles.find((file) => file.path.endsWith('.md'));
  assert.equal(report.path, 'billing/synthese/session-2026.md');
  assert.equal(report.readonly, true);
  assert.equal(readManagedFile(data.repo, report.path, data.home).content, '# Facturation\n');
  assert.throws(() => saveManagedFile(data.repo, data.home, report.path, 'altéré'), /lecture seule/);
  const ledger = billingFiles.find((file) => file.path.endsWith('.jsonl'));
  const preview = readManagedFile(data.repo, ledger.path, data.home);
  assert.equal(ledger.name, 'Suivi mensuel 2026-08');
  assert.equal(preview.sourceType, 'billing-ledger');
  assert.match(preview.content, /# Suivi de facturation — 2026-08/);
  assert.match(preview.content, /\| Analyse \| Martin \| 1 min 5 s \|/);
});

test('un nouveau skill reçoit un front matter et reste dans le dossier autorisé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const created = createManagedFile(data.repo, data.home, {
    kind: 'skill',
    slug: 'analyse-contrat',
    name: 'Analyse de contrat',
    description: 'Analyser les clauses importantes.',
  });
  assert.equal(created.path, 'piecemaker-plugin/skills/analyse-contrat/SKILL.md');
  assert.match(created.content, /^---\nname: analyse-contrat\n/);
  assert.match(created.content, /# Analyse de contrat/);
  assert.throws(() => createManagedFile(data.repo, data.home, {
    kind: 'agent', slug: '../secret', name: 'x', description: 'x',
  }), /identifiant/);
});

test('un enregistrement crée une sauvegarde et refuse la traversée de dossiers', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/agents/analyse.md';
  const result = saveManagedFile(data.repo, data.home, relative, '# Nouvelle analyse');
  assert.equal(readManagedFile(data.repo, relative).content, '# Nouvelle analyse\n');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), '# Analyse\n');
  assert.throws(() => saveManagedFile(data.repo, data.home, '../secret.md', 'x'), /administrables/);
});

test('les secrets .env peuvent être remplacés ou effacés sans perdre les commentaires', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const envFile = path.join(data.repo, '.env');
  fs.writeFileSync(envFile, '# PieceMaker\nLEGIFRANCE_CLIENT_SECRET=ancien\n');
  updateEnvFile(envFile, { LEGIFRANCE_CLIENT_SECRET: 'nouveau' });
  let content = fs.readFileSync(envFile, 'utf8');
  assert.match(content, /^# PieceMaker/m);
  assert.match(content, /^LEGIFRANCE_CLIENT_SECRET=nouveau$/m);
  updateEnvFile(envFile, {}, ['LEGIFRANCE_CLIENT_SECRET']);
  content = fs.readFileSync(envFile, 'utf8');
  assert.doesNotMatch(content, /^LEGIFRANCE_CLIENT_SECRET=/m);
});

test('l’administration refuse les origines web non locales', () => {
  assert.equal(isLocalOrigin('https://localhost:43098'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1:43098'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
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
  const files = listManagedFiles(data.repo);
  assert.deepEqual(files.map((file) => file.path), [
    'AGENTS.md',
    'CLAUDE.md',
    'piecemaker-plugin/agents/analyse.md',
    'piecemaker-plugin/skills/redaction/SKILL.md',
  ]);
  assert.equal(files[0].exists, false);
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
  fs.writeFileSync(envFile, '# PieceMaker\nMCP_API_KEY=ancien\nMCP_URL=https://example.test\n');
  updateEnvFile(envFile, { MCP_REMOTE_URL: 'https://mcp.test', MCP_API_KEY: 'nouveau' });
  let content = fs.readFileSync(envFile, 'utf8');
  assert.match(content, /^# PieceMaker/m);
  assert.match(content, /^MCP_API_KEY=nouveau$/m);
  assert.match(content, /^MCP_REMOTE_URL=https:\/\/mcp\.test$/m);
  assert.match(content, /^MCP_URL=https:\/\/mcp\.test$/m);
  updateEnvFile(envFile, {}, ['MCP_API_KEY']);
  content = fs.readFileSync(envFile, 'utf8');
  assert.doesNotMatch(content, /^MCP_API_KEY=/m);
});

test('l’administration refuse les origines web non locales', () => {
  assert.equal(isLocalOrigin('https://localhost:43098'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1:43098'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
});

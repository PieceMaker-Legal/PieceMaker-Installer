const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claudeAssetStatus,
  pruneClaudeAssets,
  registerClaudeAsset,
  repositoryAssets,
  syncClaudeAssets,
} = require('../websocket-server/claude-assets.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-claude-assets-'));
  const repo = path.join(root, 'repo');
  const userHome = path.join(root, 'user');
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'skills', 'tamponnage'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md'), '---\nname: analyste-piece\n---\n');
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'skills', 'tamponnage', 'SKILL.md'), '---\nname: tamponnage\n---\n');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  return { root, repo, userHome };
}

test('les skills et agents du dépôt sont enregistrés dans ~/.claude', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const result = syncClaudeAssets(data.repo, data.userHome);
  assert.equal(result.registered, 2);
  assert.deepEqual(result.conflicts, []);

  const agent = path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md');
  const skill = path.join(data.userHome, '.claude', 'skills', 'tamponnage', 'SKILL.md');
  assert.equal(fs.readFileSync(agent, 'utf8'), '---\nname: analyste-piece\n---\n');
  assert.equal(fs.readFileSync(skill, 'utf8'), '---\nname: tamponnage\n---\n');
});

test('une modification du dépôt est immédiatement visible côté Claude Code', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  syncClaudeAssets(data.repo, data.userHome);

  fs.writeFileSync(path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md'), '---\nname: analyste-piece\nmodel: opus\n---\n');
  const seen = fs.readFileSync(path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md'), 'utf8');
  assert.match(seen, /model: opus/);
});

test('l’enregistrement est idempotent et signale l’état de chaque fichier', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/agents/analyste-piece.md';

  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'missing');
  assert.equal(registerClaudeAsset(data.repo, data.userHome, relative).state, 'linked');
  assert.equal(registerClaudeAsset(data.repo, data.userHome, relative).state, 'linked');
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'linked');
  assert.equal(claudeAssetStatus(data.repo, data.userHome, 'CLAUDE.md'), null);
  assert.equal(registerClaudeAsset(data.repo, data.userHome, '../evasion.md'), null);
});

test('un agent personnel homonyme n’est jamais écrasé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '# agent personnel\n');

  const result = registerClaudeAsset(data.repo, data.userHome, 'piecemaker-plugin/agents/analyste-piece.md');
  assert.equal(result.state, 'conflict');
  assert.match(result.note, /existe déjà/);
  assert.equal(fs.readFileSync(target, 'utf8'), '# agent personnel\n');
  assert.equal(syncClaudeAssets(data.repo, data.userHome).conflicts.length, 1);
});

test('les liens orphelins du dépôt sont nettoyés, pas les fichiers personnels', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  syncClaudeAssets(data.repo, data.userHome);
  const personal = path.join(data.userHome, '.claude', 'agents', 'perso.md');
  fs.writeFileSync(personal, '# perso\n');
  fs.rmSync(path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md'));

  const removed = pruneClaudeAssets(data.repo, data.userHome);
  assert.deepEqual(removed, [path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md')]);
  assert.equal(fs.existsSync(personal), true);
  assert.deepEqual(repositoryAssets(data.repo), ['piecemaker-plugin/skills/tamponnage/SKILL.md']);
});

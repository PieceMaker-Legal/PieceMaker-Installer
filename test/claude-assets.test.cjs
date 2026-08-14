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
  unregisterClaudeAsset,
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

test('un enregistrement laissé par un autre clone du dépôt est repris', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  // Deuxième clone du même dépôt (poste de dev + installation d'exécution).
  const other = path.join(data.root, 'autre-clone');
  fs.cpSync(data.repo, other, { recursive: true });
  syncClaudeAssets(other, data.userHome);

  const relative = 'piecemaker-plugin/agents/analyste-piece.md';
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'stale');

  const result = syncClaudeAssets(data.repo, data.userHome);
  assert.equal(result.registered, 2);
  assert.equal(result.adopted, 2);
  assert.deepEqual(result.conflicts, []);
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'linked');
  assert.equal(
    fs.realpathSync(path.join(data.userHome, '.claude', 'skills', 'tamponnage')),
    fs.realpathSync(path.join(data.repo, 'piecemaker-plugin', 'skills', 'tamponnage')),
  );
  // L'autre clone est intact : seul le lien dans ~/.claude a bougé.
  assert.equal(fs.existsSync(path.join(other, 'piecemaker-plugin', 'agents', 'analyste-piece.md')), true);
});

test('une copie déposée par PieceMaker est remise à jour, un fichier inconnu non', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/agents/analyste-piece.md';
  const source = path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md');
  const target = path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md');

  // Repli sans lien symbolique : la copie est notée dans le reçu.
  const symlinkSync = fs.symlinkSync;
  fs.symlinkSync = () => { throw new Error('EPERM'); };
  try {
    assert.equal(registerClaudeAsset(data.repo, data.userHome, relative).state, 'copied');
  } finally {
    fs.symlinkSync = symlinkSync;
  }

  fs.writeFileSync(source, '---\nname: analyste-piece\nmodel: opus\n---\n');
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'stale');
  const refreshed = registerClaudeAsset(data.repo, data.userHome, relative);
  assert.equal(refreshed.state, 'copied');
  assert.equal(refreshed.adopted, true);
  assert.match(fs.readFileSync(target, 'utf8'), /model: opus/);

  // Un skill personnel jamais déposé par nous reste un conflit.
  const personal = path.join(data.userHome, '.claude', 'skills', 'tamponnage');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'SKILL.md'), '# skill personnel\n');
  const skill = registerClaudeAsset(data.repo, data.userHome, 'piecemaker-plugin/skills/tamponnage/SKILL.md');
  assert.equal(skill.state, 'conflict');
  assert.equal(fs.readFileSync(path.join(personal, 'SKILL.md'), 'utf8'), '# skill personnel\n');
});

test('les liens orphelins du dépôt sont nettoyés, pas les fichiers personnels', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  syncClaudeAssets(data.repo, data.userHome);
  const personal = path.join(data.userHome, '.claude', 'agents', 'perso.md');
  fs.writeFileSync(personal, '# perso\n');
  fs.rmSync(path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md'));

  const orphan = path.join(data.userHome, '.claude', 'skills', 'clone-disparu');
  fs.symlinkSync(path.join(data.root, 'clone-effac\u00e9', 'piecemaker-plugin', 'skills', 'clone-disparu'), orphan, 'dir');

  const removed = pruneClaudeAssets(data.repo, data.userHome);
  assert.deepEqual(removed.sort(), [
    path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md'),
    orphan,
  ].sort());
  assert.equal(fs.existsSync(personal), true);
  assert.deepEqual(repositoryAssets(data.repo), ['piecemaker-plugin/skills/tamponnage/SKILL.md']);
});

test('unregisterClaudeAsset retire un lien/copie PieceMaker mais jamais un fichier personnel', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/agents/analyste-piece.md';
  const target = path.join(data.userHome, '.claude', 'agents', 'analyste-piece.md');

  // Rien à faire sur un composant jamais enregistré — idempotent.
  assert.deepEqual(unregisterClaudeAsset(data.repo, data.userHome, relative), {
    kind: 'agent', slug: 'analyste-piece', target, state: 'missing',
  });

  registerClaudeAsset(data.repo, data.userHome, relative);
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'linked');
  const result = unregisterClaudeAsset(data.repo, data.userHome, relative);
  assert.equal(result.state, 'missing');
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(target), false);
  // Rappelable sans effet une fois retiré.
  assert.equal(unregisterClaudeAsset(data.repo, data.userHome, relative).state, 'missing');

  // Un fichier personnel homonyme (conflit) n'est jamais touché.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '# agent personnel\n');
  assert.equal(claudeAssetStatus(data.repo, data.userHome, relative).state, 'conflict');
  const untouched = unregisterClaudeAsset(data.repo, data.userHome, relative);
  assert.equal(untouched.state, 'conflict');
  assert.equal(fs.readFileSync(target, 'utf8'), '# agent personnel\n');

  assert.equal(unregisterClaudeAsset(data.repo, data.userHome, 'CLAUDE.md'), null);
});

test('unregisterClaudeAsset retire aussi une copie (repli sans lien symbolique) et son reçu', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/skills/tamponnage/SKILL.md';
  const target = path.join(data.userHome, '.claude', 'skills', 'tamponnage');

  const symlinkSync = fs.symlinkSync;
  fs.symlinkSync = () => { throw new Error('EPERM'); };
  try {
    assert.equal(registerClaudeAsset(data.repo, data.userHome, relative).state, 'copied');
  } finally {
    fs.symlinkSync = symlinkSync;
  }
  assert.equal(fs.existsSync(target), true);

  const result = unregisterClaudeAsset(data.repo, data.userHome, relative);
  assert.equal(result.state, 'missing');
  assert.equal(fs.existsSync(target), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(data.userHome, '.claude', '.piecemaker-assets.json'), 'utf8'));
  assert.equal(Object.hasOwn(receipt.copies, 'skill:tamponnage'), false);
});

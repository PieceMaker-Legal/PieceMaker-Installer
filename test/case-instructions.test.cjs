const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  IMPORT_START,
  ensureCaseRule,
  refreshRegisteredCaseRules,
} = require('../websocket-server/case-instructions.cjs');

const projectRoot = path.resolve(__dirname, '..');

test('ensureCaseRule actualise la règle et préserve les instructions propres au dossier', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-instructions-'));
  const caseRoot = path.join(root, 'Dossier Alpha');
  fs.mkdirSync(path.join(caseRoot, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(caseRoot, '.claude', 'rules', 'piecemaker.md'), '# Ancienne règle sans graphe\n');
  fs.writeFileSync(path.join(caseRoot, 'CLAUDE.md'), '# Ce dossier\n\nConsigne personnelle conservée.\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const rule = ensureCaseRule(projectRoot, caseRoot);
  assert.match(fs.readFileSync(rule, 'utf8'), /piecemaker chronology --json/);
  const claude = fs.readFileSync(path.join(caseRoot, 'CLAUDE.md'), 'utf8');
  const agents = fs.readFileSync(path.join(caseRoot, 'AGENTS.md'), 'utf8');
  assert.match(claude, /Consigne personnelle conservée/);
  assert.match(claude, new RegExp(IMPORT_START));
  assert.match(agents, new RegExp(IMPORT_START));
  assert.match(claude, new RegExp(rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  ensureCaseRule(projectRoot, caseRoot);
  assert.equal(fs.readFileSync(path.join(caseRoot, 'CLAUDE.md'), 'utf8').split(IMPORT_START).length - 1, 1);
});

test('refreshRegisteredCaseRules couvre tous les dossiers enregistrés existants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-refresh-'));
  const first = path.join(root, 'Dossier 1');
  const second = path.join(root, 'Dossier 2');
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = refreshRegisteredCaseRules(projectRoot, { caseFolders: [first, second] });
  assert.deepEqual(result, { refreshed: 2, failed: [] });
  for (const folder of [first, second]) {
    assert.match(
      fs.readFileSync(path.join(folder, '.claude', 'rules', 'piecemaker.md'), 'utf8'),
      /piecemaker chronology --json/,
    );
  }
});

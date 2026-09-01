/**
 * Classement automatique en « espace de travail » des documents créés par l'IA.
 *
 * Deux niveaux : la primitive `classifyAsWorkspace` (ce qu'elle refuse de
 * déclasser) et le hook `classify-ai-documents.mjs` joué comme Claude Code le
 * joue — payload JSON sur stdin, exit 0, stdout vide.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO_ROOT, 'piecemaker-plugin', 'scripts', 'classify-ai-documents.mjs');
const { classifyAsWorkspace, readProtection, writeProtection } = require(
  path.join(REPO_ROOT, 'piecemaker-plugin', 'scripts', 'lib', 'protection.cjs'),
);

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-classify-test-')));
  const home = path.join(root, 'home', '.piecemaker');
  const casesRoot = path.join(root, 'PieceMaker');
  const caseRoot = path.join(casesRoot, 'Dossier Alpha');
  fs.mkdirSync(path.join(caseRoot, 'annexes'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ caseFolders: [caseRoot] })}\n`);
  return { root, home, casesRoot, caseRoot, env: { ...process.env, HOME: path.dirname(home) } };
}

function runHook(data, payload, { cwd = data.caseRoot } = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: data.env,
  });
}

test('classifyAsWorkspace inscrit la pièce et reste idempotent', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const note = path.join(data.caseRoot, 'annexes', 'note.docx');
  fs.writeFileSync(note, 'NOTE');

  const first = classifyAsWorkspace(note, data.caseRoot);
  assert.equal(first.classified, true);
  assert.equal(first.key, 'annexes/note.docx');
  assert.ok(readProtection(data.caseRoot).unprotected.has('annexes/note.docx'));

  const second = classifyAsWorkspace(note, data.caseRoot);
  assert.equal(second.classified, false);
  assert.equal(readProtection(data.caseRoot).unprotected.size, 1);
});

test('classifyAsWorkspace ne déclasse ni un mapping ni une ressource', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const mapping = path.join(data.caseRoot, 'mapping_dossier.json');
  const code = path.join(data.caseRoot, 'code civil.pdf');
  fs.writeFileSync(mapping, '{}\n');
  fs.writeFileSync(code, 'PDF');
  writeProtection(data.caseRoot, { resources: ['code civil.pdf'] });

  assert.equal(classifyAsWorkspace(mapping, data.caseRoot).classified, false);
  assert.equal(classifyAsWorkspace(code, data.caseRoot).reason, 'ressource');
  const state = readProtection(data.caseRoot);
  assert.equal(state.unprotected.size, 0);
  assert.ok(state.resources.has('code civil.pdf'));

  // Un Markdown est déjà lisible : rien à inscrire.
  const md = path.join(data.caseRoot, 'note.md');
  fs.writeFileSync(md, '# Note\n');
  assert.equal(classifyAsWorkspace(md, data.caseRoot).classified, false);
});

test('le hook classe le document écrit par Write', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const conclusions = path.join(data.caseRoot, 'conclusions.docx');
  fs.writeFileSync(conclusions, 'CONCLUSIONS');

  const result = runHook(data, {
    hook_event_name: 'PostToolUse',
    session_id: 'classify-test',
    cwd: data.caseRoot,
    tool_name: 'Write',
    tool_input: { file_path: conclusions },
    tool_response: { success: true },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.ok(readProtection(data.caseRoot).unprotected.has('conclusions.docx'));
});

test('le hook classe le document produit par une commande Bash', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const created = path.join(data.caseRoot, 'assignation.docx');
  fs.writeFileSync(created, 'ASSIGNATION');

  const result = runHook(data, {
    hook_event_name: 'PostToolUse',
    session_id: 'classify-test',
    cwd: data.caseRoot,
    tool_name: 'Bash',
    tool_input: { command: 'docx new "assignation.docx" --template vide' },
    tool_response: { success: true },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readProtection(data.caseRoot).unprotected.has('assignation.docx'));
});

test('le hook ignore une pièce ancienne simplement citée et un échec d’outil', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const ancienne = path.join(data.caseRoot, 'contrat.pdf');
  fs.writeFileSync(ancienne, 'ORIGINAL');
  const vieux = Date.now() / 1000 - 3600;
  fs.utimesSync(ancienne, vieux, vieux);

  runHook(data, {
    hook_event_name: 'PostToolUse',
    cwd: data.caseRoot,
    tool_name: 'Bash',
    tool_input: { command: 'ls -l contrat.pdf' },
    tool_response: { success: true },
  });

  const echec = path.join(data.caseRoot, 'brouillon.docx');
  fs.writeFileSync(echec, 'BROUILLON');
  runHook(data, {
    hook_event_name: 'PostToolUse',
    cwd: data.caseRoot,
    tool_name: 'Write',
    tool_input: { file_path: echec },
    tool_response: { success: false },
  });

  assert.equal(readProtection(data.caseRoot).unprotected.size, 0);
});

test('le hook ignore un dossier non enregistré', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const dehors = path.join(data.casesRoot, 'Dossier Beta');
  fs.mkdirSync(dehors, { recursive: true });
  const piece = path.join(dehors, 'note.docx');
  fs.writeFileSync(piece, 'NOTE');

  const result = runHook(data, {
    hook_event_name: 'PostToolUse',
    cwd: dehors,
    tool_name: 'Write',
    tool_input: { file_path: piece },
    tool_response: { success: true },
  }, { cwd: dehors });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(dehors, '.piecemaker', 'protection.json')), false);
});

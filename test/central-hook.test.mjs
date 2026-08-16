import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'websocket-server', 'global-hooks', 'piecemaker-central-anonymize.mjs');
const SUBSTITUTION_SRC = path.join(repoRoot, 'piecemaker-plugin', 'scripts', 'lib', 'substitution.cjs');

const CENTRAL = {
  version: 1,
  mapping: { 'Jean Dupont': 'PERSONNE_PHYSIQUE_01', 'Marie Martin': 'PERSONNE_PHYSIQUE_07' },
  reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Jean Dupont'], PERSONNE_PHYSIQUE_07: ['Marie Martin'] },
};

function fixture({ enabled = true, central = CENTRAL } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-central-hook-'));
  fs.mkdirSync(path.join(home, 'lib'), { recursive: true });
  fs.copyFileSync(SUBSTITUTION_SRC, path.join(home, 'lib', 'substitution.cjs'));
  if (central) fs.writeFileSync(path.join(home, 'central-mapping.json'), JSON.stringify(central));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ anonymization: { enabled } }));
  return home;
}

function runHook(payload, home) {
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, PIECEMAKER_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('à la lecture, le résultat est anonymisé où qu’il soit lu (hors dossier compris)', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/tmp/quelconque',
    tool_input: { file_path: '/tmp/quelconque/note.md' },
    tool_response: { type: 'text', file: { content: 'Jean Dupont a rencontré Marie Martin.' } },
  }, home);

  const content = out.hookSpecificOutput.updatedToolOutput.file.content;
  assert.equal(content.includes('Jean Dupont'), false);
  assert.equal(content.includes('Marie Martin'), false);
  assert.match(content, /PERSONNE_PHYSIQUE_01/);
  assert.match(content, /PERSONNE_PHYSIQUE_07/);
});

test('un Bash cite du contenu de pièce : stdout est codé', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: '/tmp',
    tool_input: { command: 'cat note.md' },
    tool_response: { stdout: 'Signé Jean Dupont', stderr: '' },
  }, home);
  assert.equal(out.hookSpecificOutput.updatedToolOutput.stdout.includes('Jean Dupont'), false);
});

test('à l’écriture, les codes sont restitués en vrais noms sur le disque', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/out.md', content: 'Note pour PERSONNE_PHYSIQUE_01 et PERSONNE_PHYSIQUE_07.' },
  }, home);
  const content = out.hookSpecificOutput.updatedInput.content;
  assert.equal(content.includes('Jean Dupont'), true);
  assert.equal(content.includes('Marie Martin'), true);
  assert.equal(content.includes('PERSONNE_PHYSIQUE_01'), false);
});

test('un Edit restitue les deux chaînes', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/out.md', old_string: 'PERSONNE_PHYSIQUE_01', new_string: 'cher PERSONNE_PHYSIQUE_01' },
  }, home);
  assert.equal(out.hookSpecificOutput.updatedInput.old_string, 'Jean Dupont');
  assert.equal(out.hookSpecificOutput.updatedInput.new_string, 'cher Jean Dupont');
});

test('un fichier de mapping n’est jamais « anonymisé » à la lecture', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/central-mapping.json' },
    tool_response: { file: { content: 'Jean Dupont' } },
  }, home);
  assert.equal(out, null);
});

test('anonymization.enabled=false neutralise complètement le hook', (t) => {
  const home = fixture({ enabled: false });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/note.md' },
    tool_response: { file: { content: 'Jean Dupont' } },
  }, home);
  assert.equal(out, null);
});

test('sans mapping central, le hook s’efface (échec ouvert)', (t) => {
  const home = fixture({ central: null });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/note.md' },
    tool_response: { file: { content: 'Jean Dupont' } },
  }, home);
  assert.equal(out, null);
});

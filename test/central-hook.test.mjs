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
  mapping: {
    'Jean Dupont': 'PERSONNE_PHYSIQUE_01',
    'M. Dupont': 'PERSONNE_PHYSIQUE_01',
    'Marie Martin': 'PERSONNE_PHYSIQUE_07',
  },
  reverse_mapping: {
    PERSONNE_PHYSIQUE_01: ['Jean Dupont', 'M. Dupont'],
    PERSONNE_PHYSIQUE_07: ['Marie Martin'],
  },
};

function fixture({ enabled = true, central = CENTRAL } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-central-hook-'));
  const legalCase = path.join(home, 'Dossier juridique');
  fs.mkdirSync(legalCase, { recursive: true });
  fs.mkdirSync(path.join(home, 'lib'), { recursive: true });
  fs.copyFileSync(SUBSTITUTION_SRC, path.join(home, 'lib', 'substitution.cjs'));
  if (central) fs.writeFileSync(path.join(home, 'central-mapping.json'), JSON.stringify(central));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    anonymization: { enabled },
    caseFolders: [legalCase],
  }));
  return home;
}

const caseRoot = (home) => path.join(home, 'Dossier juridique');

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
    cwd: caseRoot(home),
    tool_input: {
      file_path: path.join(caseRoot(home), 'out.md'),
      content: 'Note pour PERSONNE_PHYSIQUE_01 et PERSONNE_PHYSIQUE_07.',
    },
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
    cwd: caseRoot(home),
    tool_input: {
      file_path: path.join(caseRoot(home), 'out.md'),
      old_string: 'PERSONNE_PHYSIQUE_01',
      new_string: 'cher PERSONNE_PHYSIQUE_01',
    },
  }, home);
  assert.equal(out.hookSpecificOutput.updatedInput.old_string, 'Jean Dupont');
  assert.equal(out.hookSpecificOutput.updatedInput.new_string, 'cher Jean Dupont');
});

test('un Read restitue le vrai chemin avant exécution', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const realPath = path.join(caseRoot(home), '06_Jean Dupont.md');
  fs.writeFileSync(realPath, 'Pièce concernant Jean Dupont.');

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: caseRoot(home),
    tool_input: { file_path: path.join(caseRoot(home), '06_PERSONNE_PHYSIQUE_01.md') },
  }, home);
  assert.equal(out.hookSpecificOutput.updatedInput.file_path, realPath);
  assert.equal(fs.readFileSync(out.hookSpecificOutput.updatedInput.file_path, 'utf8'), 'Pièce concernant Jean Dupont.');
});

test('un Read conserve un chemin codé qui existe déjà littéralement', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codedPath = path.join(caseRoot(home), '06_PERSONNE_PHYSIQUE_01.md');
  fs.writeFileSync(codedPath, 'Pièce déjà nommée avec le code.');

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: caseRoot(home),
    tool_input: { file_path: codedPath },
  }, home);
  assert.equal(out, null);
  assert.equal(fs.existsSync(codedPath), true);
});

test('un Read retrouve une variante de nom non canonique par son nom anonymisé', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const realPath = path.join(caseRoot(home), '06_M. Dupont.md');
  const codedPath = path.join(caseRoot(home), '06_PERSONNE_PHYSIQUE_01.md');
  fs.writeFileSync(realPath, 'Pièce concernant une variante du nom.');

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: caseRoot(home),
    tool_input: { file_path: codedPath },
  }, home);
  assert.equal(out.hookSpecificOutput.updatedInput.file_path, realPath);
  assert.equal(fs.existsSync(out.hookSpecificOutput.updatedInput.file_path), true);
});

test('acceptation — scratchpad codé, fichier du dossier ré-identifié, Read au chemin codé', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legalCase = caseRoot(home);
  const scratchDir = path.join(home, 'scratchpads');
  fs.mkdirSync(scratchDir);

  const scratchInput = {
    file_path: path.join(scratchDir, 'travail.md'),
    content: 'Projet pour PERSONNE_PHYSIQUE_01.',
  };
  const scratchHook = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: legalCase,
    tool_input: scratchInput,
  }, home);
  assert.equal(scratchHook, null, 'un Write hors dossier ne doit pas être ré-identifié');
  fs.writeFileSync(scratchInput.file_path, scratchInput.content);
  assert.match(fs.readFileSync(scratchInput.file_path, 'utf8'), /PERSONNE_PHYSIQUE_01/);
  assert.doesNotMatch(fs.readFileSync(scratchInput.file_path, 'utf8'), /Jean Dupont/);

  const caseInput = {
    file_path: path.join(legalCase, 'note.md'),
    content: 'Projet pour PERSONNE_PHYSIQUE_01.',
  };
  const caseHook = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: legalCase,
    tool_input: caseInput,
  }, home);
  const effectiveCaseInput = caseHook.hookSpecificOutput.updatedInput;
  fs.writeFileSync(effectiveCaseInput.file_path, effectiveCaseInput.content);
  assert.match(fs.readFileSync(caseInput.file_path, 'utf8'), /Jean Dupont/);
  assert.doesNotMatch(fs.readFileSync(caseInput.file_path, 'utf8'), /PERSONNE_PHYSIQUE_01/);

  const realPath = path.join(legalCase, '06_Jean Dupont.md');
  const codedPath = path.join(legalCase, '06_PERSONNE_PHYSIQUE_01.md');
  fs.writeFileSync(realPath, 'Jean Dupont a signé.');
  const readPre = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: legalCase,
    tool_input: { file_path: codedPath },
  }, home);
  const resolvedPath = readPre.hookSpecificOutput.updatedInput.file_path;
  const clearContent = fs.readFileSync(resolvedPath, 'utf8');
  const readPost = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: legalCase,
    tool_input: { file_path: resolvedPath },
    tool_response: { file: { content: clearContent } },
  }, home);
  assert.equal(resolvedPath, realPath);
  assert.equal(readPost.hookSpecificOutput.updatedToolOutput.file.content, 'PERSONNE_PHYSIQUE_01 a signé.');
});

test('le résultat de Write et open_doc est recodé avant de revenir au modèle', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legalCase = caseRoot(home);
  const realDocument = path.join(legalCase, 'Projet Jean Dupont.docx');
  fs.writeFileSync(realDocument, 'fixture');

  const writeOut = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    cwd: legalCase,
    tool_input: { file_path: path.join(legalCase, 'note.md'), content: 'Jean Dupont' },
    tool_response: { content: 'Fichier écrit pour Jean Dupont.' },
  }, home);
  assert.equal(writeOut.hookSpecificOutput.updatedToolOutput.content, 'Fichier écrit pour PERSONNE_PHYSIQUE_01.');

  for (const toolName of ['mcp__piecemaker-word__open_doc', 'mcp__PieceMaker__open_doc']) {
    const openPre = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      cwd: legalCase,
      tool_input: { path: path.join(legalCase, 'Projet PERSONNE_PHYSIQUE_01.docx') },
    }, home);
    assert.equal(openPre.hookSpecificOutput.updatedInput.path, realDocument);

    const openPost = runHook({
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      cwd: legalCase,
      tool_input: openPre.hookSpecificOutput.updatedInput,
      tool_response: {
        content: [{ type: 'text', text: JSON.stringify({ path: openPre.hookSpecificOutput.updatedInput.path }) }],
      },
    }, home);
    const returned = JSON.stringify(openPost.hookSpecificOutput.updatedToolOutput);
    assert.doesNotMatch(returned, /Jean Dupont/);
    assert.match(returned, /PERSONNE_PHYSIQUE_01/);
  }
});

test('open_doc ne ré-identifie pas un document dont le nom codé existe', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codedDocument = path.join(caseRoot(home), 'Projet PERSONNE_PHYSIQUE_01.docx');
  fs.writeFileSync(codedDocument, 'fixture');

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'mcp__PieceMaker__open_doc',
    cwd: caseRoot(home),
    tool_input: { path: codedDocument },
  }, home);
  assert.equal(out, null);
  assert.equal(fs.existsSync(codedDocument), true);
});

test('une commande Bash restitue les vrais noms avant exécution', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const out = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: '/tmp',
    tool_input: { command: 'cat /tmp/06_PERSONNE_PHYSIQUE_01.md && echo PERSONNE_PHYSIQUE_07' },
  }, home);
  const command = out.hookSpecificOutput.updatedInput.command;
  assert.match(command, /Jean Dupont/);
  assert.match(command, /Marie Martin/);
  assert.doesNotMatch(command, /PERSONNE_PHYSIQUE_01|PERSONNE_PHYSIQUE_07/);
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

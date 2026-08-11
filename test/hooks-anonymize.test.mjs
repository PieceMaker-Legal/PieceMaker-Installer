import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'piecemaker-plugin', 'scripts');
const PROTECT = path.join(scripts, 'protect-originals.mjs');
const ANONYMIZE = path.join(scripts, 'anonymize-read.mjs');
const DEANONYMIZE = path.join(scripts, 'deanonymize-write.mjs');

const MAPPING = {
  mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01', 'URGOT SA': 'SOCIETE_SA_02' },
  reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'], SOCIETE_SA_02: ['URGOT SA'] },
};

function fixture({ withMapping = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-hooks-test-'));
  const home = path.join(root, 'home');
  const casesRoot = path.join(root, 'PieceMaker');
  const caseRoot = path.join(casesRoot, 'Dossier Alpha');
  fs.mkdirSync(path.join(home, '.piecemaker'), { recursive: true });
  fs.mkdirSync(path.join(caseRoot, 'annexes'), { recursive: true });
  fs.writeFileSync(path.join(home, '.piecemaker', 'config.json'), JSON.stringify({ workspacePath: casesRoot }));
  fs.writeFileSync(path.join(caseRoot, 'contrat.pdf'), 'ORIGINAL SECRET');
  fs.writeFileSync(path.join(caseRoot, 'contrat.md'), 'Contrat signé par Bernard Gilly pour URGOT SA.\n');
  fs.writeFileSync(path.join(caseRoot, 'annexes', 'annexe.docx'), 'ORIGINAL SECRET');
  if (withMapping) {
    fs.writeFileSync(path.join(caseRoot, 'mapping_dossier.json'), JSON.stringify(MAPPING));
  }
  return { root, home, casesRoot, caseRoot };
}

/** Lance un hook comme le fait Claude Code : charge utile JSON sur stdin. */
function runHook(script, payload, data) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: data.home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('une pièce protégée est refusée et le refus indique le Markdown à lire', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const denied = runHook(PROTECT, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.pdf') },
  }, data);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /contrat\.md/);

  // Le Markdown, lui, reste lisible : c'est la surface anonymisée.
  assert.equal(runHook(PROTECT, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.md') },
  }, data), null);
});

test('le mapping et les scans PII sont hors d’atteinte, quel que soit l’outil', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data.caseRoot, 'contrat_sensitive_map.json'), '{"entities":[]}');
  fs.writeFileSync(path.join(data.caseRoot, 'metadata.json'), '{"ok":true}');

  for (const name of ['mapping_dossier.json', 'contrat_sensitive_map.json']) {
    const denied = runHook(PROTECT, {
      tool_name: 'Read',
      cwd: data.caseRoot,
      tool_input: { file_path: path.join(data.caseRoot, name) },
    }, data);
    assert.equal(denied?.hookSpecificOutput.permissionDecision, 'deny', name);
    // Aucun renvoi : il n'existe pas de version anonymisée de ces fichiers.
    assert.doesNotMatch(denied.hookSpecificOutput.permissionDecisionReason, /\.md/);
  }

  // Le contournement évident — `cat` — est fermé du même coup.
  const viaBash = runHook(PROTECT, {
    tool_name: 'Bash',
    cwd: data.caseRoot,
    tool_input: { command: 'cat mapping_dossier.json | head -5' },
  }, data);
  assert.equal(viaBash?.hookSpecificOutput.permissionDecision, 'deny');

  // Un `Grep` récursif à la racine lirait le mapping ; un JSON ordinaire, non.
  const viaGrep = runHook(PROTECT, {
    tool_name: 'Grep',
    cwd: data.caseRoot,
    tool_input: { pattern: 'PERSONNE', path: data.caseRoot },
  }, data);
  assert.equal(viaGrep?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runHook(PROTECT, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'metadata.json') },
  }, data), null);
});

test('le garde-fou couvre Bash, par où passe le skill docx', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const denied = runHook(PROTECT, {
    tool_name: 'Bash',
    cwd: data.caseRoot,
    tool_input: { command: 'python3 ooxml/scripts/unpack.py "annexes/annexe.docx" /tmp/out' },
  }, data);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /annexe\.docx/);

  // Le nom du programme n'est pas un chemin : une commande ordinaire passe.
  assert.equal(runHook(PROTECT, {
    tool_name: 'Bash',
    cwd: data.caseRoot,
    tool_input: { command: 'pandoc contrat.md -o /tmp/contrat.docx' },
  }, data), null);
});

test('une exception rend la pièce accessible au hook', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(data.caseRoot, '.piecemaker'), { recursive: true });
  fs.writeFileSync(
    path.join(data.caseRoot, '.piecemaker', 'protection.json'),
    JSON.stringify({ version: 1, unprotected: ['contrat.pdf'] })
  );

  assert.equal(runHook(PROTECT, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.pdf') },
  }, data), null);
});

test('le mapping est appliqué au résultat lu, sans toucher au fichier', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const markdown = path.join(data.caseRoot, 'contrat.md');
  const onDisk = fs.readFileSync(markdown, 'utf8');

  const output = runHook(ANONYMIZE, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: markdown },
    tool_response: { file: { content: onDisk } },
  }, data);
  // `updatedToolOutput` doit épouser la forme du résultat d'outil : le harnais le
  // valide contre le schéma de sortie de l'outil et rejette une chaîne quand un
  // Read produit un objet `{ file: { content } }`. On code donc les chaînes
  // internes en laissant la structure intacte.
  assert.deepEqual(
    output.hookSpecificOutput.updatedToolOutput,
    { file: { content: 'Contrat signé par PERSONNE_PHYSIQUE_01 pour SOCIETE_SA_02.\n' } }
  );
  assert.equal(fs.readFileSync(markdown, 'utf8'), onDisk, 'le disque reste en clair pour le cabinet');
});

test('la sortie de Bash est codée elle aussi, et le format natif est préservé sans entité', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const output = runHook(ANONYMIZE, {
    tool_name: 'Bash',
    cwd: data.caseRoot,
    tool_input: { command: 'cat contrat.md' },
    tool_response: { stdout: 'Bernard Gilly a signé.', stderr: '' },
  }, data);
  // La forme du résultat Bash (`{ stdout, stderr }`) est préservée : le harnais
  // rejetterait une chaîne, et le vrai nom passerait alors en clair.
  assert.deepEqual(output.hookSpecificOutput.updatedToolOutput, { stdout: 'PERSONNE_PHYSIQUE_01 a signé.', stderr: '' });

  // Rien à substituer : le hook se tait pour que Read garde sa numérotation.
  assert.equal(runHook(ANONYMIZE, {
    tool_name: 'Bash',
    cwd: data.caseRoot,
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'contrat.md\n', stderr: '' },
  }, data), null);
});

test('la sortie de Bash est codée même quand le cwd est hors du dossier (chemin cité dans la commande)', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // cwd = ailleurs (comme la session principale, dont le cwd est le dépôt et non
  // le dossier juridique) ; la commande cite le fichier du dossier par chemin
  // absolu. Le hook doit retrouver le dossier depuis la commande, sinon un
  // `cat`/`grep` d'une pièce Markdown ressortait en clair.
  const output = runHook(ANONYMIZE, {
    tool_name: 'Bash',
    cwd: os.tmpdir(),
    tool_input: { command: `cat ${JSON.stringify(path.join(data.caseRoot, 'contrat.md'))}` },
    tool_response: { stdout: 'Bernard Gilly a signé pour URGOT SA.', stderr: '' },
  }, data);
  assert.deepEqual(
    output.hookSpecificOutput.updatedToolOutput,
    { stdout: 'PERSONNE_PHYSIQUE_01 a signé pour SOCIETE_SA_02.', stderr: '' }
  );
});

test('sans mapping, ou hors dossier juridique, rien n’est réécrit', (t) => {
  const data = fixture({ withMapping: false });
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  assert.equal(runHook(ANONYMIZE, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.md') },
    tool_response: { file: { content: 'Bernard Gilly.' } },
  }, data), null);

  assert.equal(runHook(ANONYMIZE, {
    tool_name: 'Read',
    cwd: os.tmpdir(),
    tool_input: { file_path: path.join(os.tmpdir(), 'ailleurs.md') },
    tool_response: { file: { content: 'Bernard Gilly.' } },
  }, data), null);
});

test('un Write repose les vrais noms sur le disque', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const output = runHook(DEANONYMIZE, {
    tool_name: 'Write',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'note.md'), content: 'PERSONNE_PHYSIQUE_01 agit pour SOCIETE_SA_02.' },
  }, data);
  assert.equal(output.hookSpecificOutput.updatedInput.content, 'Bernard Gilly agit pour URGOT SA.');
  // Le hook réécrit, il n'autorise pas : la décision de permission reste au harnais.
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
});

test('un Edit rétablit les deux chaînes, sinon la recherche échouerait', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const output = runHook(DEANONYMIZE, {
    tool_name: 'Edit',
    cwd: data.caseRoot,
    tool_input: {
      file_path: path.join(data.caseRoot, 'contrat.md'),
      old_string: 'signé par PERSONNE_PHYSIQUE_01',
      new_string: 'contresigné par PERSONNE_PHYSIQUE_01',
    },
  }, data);
  const { updatedInput } = output.hookSpecificOutput;
  assert.equal(updatedInput.old_string, 'signé par Bernard Gilly');
  assert.equal(updatedInput.new_string, 'contresigné par Bernard Gilly');
  // La chaîne recherchée existe bien telle quelle dans le fichier en clair.
  assert.ok(fs.readFileSync(path.join(data.caseRoot, 'contrat.md'), 'utf8').includes(updatedInput.old_string));
});

test('un message Telegram part avec les vrais noms, sans passer par l’API', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const output = runHook(DEANONYMIZE, {
    tool_name: 'mcp__telegram__reply',
    cwd: data.caseRoot,
    tool_input: { chat_id: '42', text: 'Synthèse : SOCIETE_SA_02 a résilié.' },
  }, data);
  assert.equal(output.hookSpecificOutput.updatedInput.text, 'Synthèse : URGOT SA a résilié.');
  assert.equal(output.hookSpecificOutput.updatedInput.chat_id, '42');
});

test('un résultat volumineux est codé en entier, pas tronqué au tampon du tube', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Claude Code branche stdout du hook sur un tube : au-delà de 64 Ko, un
  // `process.exit()` immédiat coupait le JSON en plein milieu. Le harnais ne
  // pouvait plus le lire et reprenait la sortie d'outil d'origine — le document
  // partait donc en clair dès qu'il dépassait le tampon.
  const filler = 'Le contrat court sur plusieurs pages.\n'.repeat(20000);
  const output = runHook(ANONYMIZE, {
    tool_name: 'Read',
    cwd: data.caseRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.md') },
    tool_response: `Signé par Bernard Gilly.\n${filler}Pour URGOT SA.\n`,
  }, data);

  const coded = output.hookSpecificOutput.updatedToolOutput;
  assert.ok(coded.length > 512 * 1024, 'la sortie doit dépasser largement le tampon du tube');
  assert.ok(!coded.includes('Bernard Gilly'), 'aucun nom ne doit subsister au début');
  assert.ok(!coded.includes('URGOT SA'), 'aucun nom ne doit subsister à la fin');
  assert.match(coded, /PERSONNE_PHYSIQUE_01/);
  // La fin du flux doit être intacte : c'est elle que la troncature emportait.
  assert.ok(coded.trimEnd().endsWith('Pour SOCIETE_SA_02.'));
});

test('un Write volumineux retrouve les vrais noms jusqu’à la dernière ligne', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const filler = 'Paragraphe de conclusions sans entité.\n'.repeat(20000);
  const output = runHook(DEANONYMIZE, {
    tool_name: 'Write',
    cwd: data.caseRoot,
    tool_input: {
      file_path: path.join(data.caseRoot, 'conclusions.md'),
      content: `PERSONNE_PHYSIQUE_01 conclut.\n${filler}Contre SOCIETE_SA_02.\n`,
    },
  }, data);

  const restored = output.hookSpecificOutput.updatedInput.content;
  assert.ok(restored.length > 512 * 1024);
  assert.ok(restored.startsWith('Bernard Gilly conclut.'));
  assert.ok(restored.trimEnd().endsWith('Contre URGOT SA.'));
});

test('sans configuration PieceMaker, chaque hook s’efface complètement', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-hooks-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = { home: root };

  for (const script of [PROTECT, ANONYMIZE, DEANONYMIZE]) {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x.pdf' }, tool_response: 'x' }),
      env: { ...process.env, HOME: data.home },
    });
    assert.equal(result.status, 0, `${path.basename(script)} doit sortir en 0`);
    assert.equal(result.stdout, '', `${path.basename(script)} ne doit rien écrire`);
  }
});

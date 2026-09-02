import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'installer', 'bin', 'piecemaker.mjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-conversion-cli-'));
  const home = path.join(root, 'home');
  const caseRoot = path.join(root, 'Dossier juridique');
  fs.mkdirSync(home);
  fs.mkdirSync(caseRoot);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ caseFolders: [caseRoot] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, caseRoot };
}

// La suite tourne à quatre tests de front, dont des tests git de plusieurs
// dizaines de secondes : sur une machine chargée, un simple `--help` peut
// dépasser un budget serré. Le plafond est donc large — il n'existe que pour
// éviter un blocage indéfini, pas pour mesurer une performance — et un
// dépassement est signalé comme tel plutôt que par un obscur `null !== 0`.
const CLI_TIMEOUT_MS = 120_000;

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: CLI_TIMEOUT_MS,
  });
  if (result.status === null) {
    assert.fail(
      `Le CLI n'a pas rendu de code de sortie (signal ${result.signal || 'aucun'}, `
      + `${result.error ? result.error.message : `plafond de ${CLI_TIMEOUT_MS} ms atteint`}) `
      + `pour : ${args.join(' ')}`,
    );
  }
  return result;
}

test('conversion est documentée dans l’aide du CLI', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /conversion \[pièce…\]/);
});

test('conversion refuse un nom de pièce inconnu sans lancer le pipeline', (t) => {
  const data = fixture(t);
  fs.writeFileSync(path.join(data.caseRoot, 'pièce existante.txt'), 'ORIGINAL');
  const result = runCli([
    'conversion', 'absente.pdf', '--case', data.caseRoot, '--json',
  ], {
    PIECEMAKER_HOME: data.home,
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /Aucune pièce ne correspond/);
  assert.doesNotMatch(result.stdout, /██████|Installateur/);
});

test('conversion cible une pièce et attend la fin du pipeline pseudonymisé', (t) => {
  const data = fixture(t);
  const documentName = 'document exemple.txt';
  fs.writeFileSync(path.join(data.caseRoot, documentName), 'ORIGINAL');
  const fakePipeline = path.join(data.root, 'fake_pipeline.py');
  fs.writeFileSync(fakePipeline, String.raw`import json
import sys
from pathlib import Path

args = sys.argv[1:]
output_index = args.index('-o')
files = args[:output_index]
output = Path(args[output_index + 1])
mapping = Path(args[args.index('--mapping-file') + 1])
output.mkdir(parents=True, exist_ok=True)
for source in files:
    (output / (Path(source).stem + '.md')).write_text('# Contenu pseudonymise\n', encoding='utf-8')
mapping.write_text(json.dumps({
    'mapping': {},
    'reverse_mapping': {},
    'informations_dossier': {},
}), encoding='utf-8')
print(f'PROGRESS:CONVERT:100:{len(files)}:{len(files)}', flush=True)
print(f'PROGRESS:SCAN:100:{len(files)}:{len(files)}', flush=True)
`);

  const result = runCli([
    'conversion', documentName, '--case', data.caseRoot, '--json',
  ], {
    PIECEMAKER_HOME: data.home,
    PIECEMAKER_PIPELINE_PATH: fakePipeline,
    PIECEMAKER_USER_NAME: 'Utilisateur Test',
    PYTHON_PATH: 'python3',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /██████|Installateur/);
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'done');
  assert.equal(status.result.scanned, 1);
  assert.equal(status.total, 1);
  assert.equal(
    fs.existsSync(path.join(data.caseRoot, 'Fichiers convertis PieceMaker', 'document exemple.md')),
    true,
  );
});

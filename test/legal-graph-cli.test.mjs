import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'installer', 'bin', 'piecemaker.mjs');

test('graph status --json produit une sortie machine pure depuis un dossier enregistré', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graph-cli-'));
  const home = path.join(root, 'home');
  const caseRoot = path.join(root, 'Dossier juridique');
  fs.mkdirSync(home);
  fs.mkdirSync(caseRoot);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ caseFolders: [caseRoot] }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [
    cli, 'graph', 'status', '--case', caseRoot, '--json',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, PIECEMAKER_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /██████|Installateur/);
  const status = JSON.parse(result.stdout);
  assert.equal(status.exists, false);
  assert.equal(status.stale, true);
  assert.match(status.graphFile, /\.piecemaker\/graphify\/legal\/graphify-out\/graph\.json$/);
});

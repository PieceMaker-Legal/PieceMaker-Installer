import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  check,
  install,
  legifranceEnvFile,
  writeLegifranceEnv,
} from '../installer/steps/07-legifrance.mjs';

function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legifrance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function silentLog() {
  return { info() {}, detail() {}, warn() {}, error() {}, ok() {} };
}

test('le fichier MCP fusionne les clés et reste privé', (t) => {
  const home = temporaryHome(t);
  const file = legifranceEnvFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# personnel\nAUTRE=conservee\n', 'utf8');

  writeLegifranceEnv(file, {
    LEGIFRANCE_CLIENT_ID: 'identifiant',
    LEGIFRANCE_CLIENT_SECRET: 'secret',
    LEGIFRANCE_ENV: 'production',
  });

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /# personnel/);
  assert.match(content, /AUTRE=conservee/);
  assert.match(content, /LEGIFRANCE_CLIENT_ID=identifiant/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('l’étape installe le plugin autonome puis configure PISTE', async (t) => {
  const home = temporaryHome(t);
  const installPath = path.join(home, 'plugin-cache');
  fs.mkdirSync(path.join(installPath, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(installPath, 'scripts', 'launcher.py'), '# test\n');
  const calls = [];
  const runCapture = (_command, args) => {
    if (args.includes('marketplace')) {
      return { code: 0, stdout: JSON.stringify([{ name: 'mcp-legifrance' }]), stderr: '' };
    }
    return {
      code: 0,
      stdout: JSON.stringify([{
        id: 'piecemaker@mcp-legifrance', version: '1.0.0', enabled: true, installPath,
      }]),
      stderr: '',
    };
  };
  const result = await install({
    dryRun: false,
    env: { LEGIFRANCE_CLIENT_ID: 'id', LEGIFRANCE_CLIENT_SECRET: 'secret' },
  }, {
    userHome: home,
    log: silentLog(),
    runCapture,
    run: async (command, args) => { calls.push([command, ...args]); return 0; },
    commandExists: () => true,
    findPython: () => ({ command: 'python3', version: '3.12' }),
    writeEnv: () => {},
    validatePisteCredentials: async () => ({ ok: true }),
    confirm: async () => true,
    nonInteractive: true,
  });

  assert.equal(result.status, 'done');
  assert.ok(calls.some((args) => args.at(-1) === '--bootstrap-only'));
  assert.match(fs.readFileSync(legifranceEnvFile(home), 'utf8'), /LEGIFRANCE_CLIENT_SECRET=secret/);

  const diagnosis = await check({}, {
    userHome: home,
    runCapture,
    commandExists: () => true,
  });
  assert.equal(diagnosis.status, 'done');
});

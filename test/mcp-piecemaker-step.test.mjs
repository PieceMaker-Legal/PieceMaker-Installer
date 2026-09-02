import assert from 'node:assert/strict';
import test from 'node:test';

import { check, install } from '../installer/steps/12-mcp-piecemaker.mjs';

function dependencies(overrides = {}) {
  return {
    existsSync: () => true,
    commandExists: () => true,
    runCapture: () => { throw new Error('runCapture non simulé pour ce test'); },
    run: async () => { throw new Error('run non simulé pour ce test'); },
    log: {
      ok() {}, info() {}, detail() {}, warn() {}, error() {},
    },
    ...overrides,
  };
}

test('installe et enregistre le serveur MCP quand il est absent', async () => {
  const calls = [];
  const result = await install({ dryRun: false }, dependencies({
    runCapture(command, args) {
      calls.push(['get', command, ...args]);
      return { code: 1, stdout: '', stderr: 'No MCP server named "piecemaker".' };
    },
    async run(command, args) {
      calls.push(['run', command, ...args]);
      return 0;
    },
  }));

  assert.equal(result.status, 'done');
  assert.deepEqual(calls[0], ['get', 'claude', 'mcp', 'get', 'piecemaker']);
  const addCall = calls.find((c) => c[0] === 'run');
  assert.deepEqual(addCall.slice(1, 5), ['claude', 'mcp', 'add', '-s']);
  assert.equal(addCall.includes('piecemaker'), true);
  assert.equal(addCall.includes('--'), true);
  assert.equal(addCall.includes('node'), true);
  // Aucun retrait n'a eu lieu : il n'y avait rien à retirer.
  assert.equal(calls.some((c) => c[0] === 'run' && c[2] === 'remove'), false);
});

test('ne réécrit rien quand l’enregistrement pointe déjà sur ce dépôt', async () => {
  let ran = false;
  const result = await install({ dryRun: false }, dependencies({
    runCapture: () => ({
      code: 0,
      stdout: 'piecemaker:\n  Command: node\n  Args: /Users/tsardet/Sites/PieceMaker-Installer/mcp/piecemaker/server.mjs\n',
      stderr: '',
    }),
    async run() { ran = true; return 0; },
  }));

  assert.equal(result.status, 'done');
  assert.equal(ran, false);
});

test('retire puis réenregistre quand l’entrée existante pointe ailleurs', async () => {
  const calls = [];
  const result = await install({ dryRun: false }, dependencies({
    runCapture: () => ({
      code: 0,
      stdout: 'piecemaker:\n  Command: node\n  Args: /autre/clone/mcp/piecemaker/server.mjs\n',
      stderr: '',
    }),
    async run(command, args) {
      calls.push([command, ...args]);
      return 0;
    },
  }));

  assert.equal(result.status, 'done');
  assert.deepEqual(calls[0], ['claude', 'mcp', 'remove', 'piecemaker', '-s', 'user']);
  assert.equal(calls[1][0], 'claude');
  assert.equal(calls[1].includes('add'), true);
});

test('échec du retrait de l’ancien enregistrement remonte "failed" avec la commande à taper à la main', async () => {
  const result = await install({ dryRun: false }, dependencies({
    runCapture: () => ({ code: 0, stdout: 'Args: /autre/clone/server.mjs', stderr: '' }),
    run: async (command, args) => (args[1] === 'remove' ? 1 : 0),
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.note, /claude mcp remove piecemaker -s user/);
});

test('échec de l’enregistrement remonte "failed" avec la commande à taper à la main', async () => {
  const result = await install({ dryRun: false }, dependencies({
    runCapture: () => ({ code: 1, stdout: '', stderr: 'introuvable' }),
    run: async () => 1,
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.note, /claude mcp add -s user piecemaker/);
});

test('CLI claude absente : ignoré, aucun appel réseau', async () => {
  let called = false;
  const result = await install({ dryRun: false }, dependencies({
    commandExists: () => false,
    runCapture: () => { called = true; return { code: 1, stdout: '', stderr: '' }; },
  }));

  assert.equal(result.status, 'skipped');
  assert.equal(called, false);
});

test('serveur MCP introuvable sur le disque : ignoré', async () => {
  const result = await install({ dryRun: false }, dependencies({
    existsSync: () => false,
  }));

  assert.equal(result.status, 'skipped');
  assert.match(result.note, /introuvable/);
});

test('--dry-run n’écrit rien même quand l’enregistrement est absent', async () => {
  let ran = false;
  const result = await install({ dryRun: true }, dependencies({
    runCapture: () => ({ code: 1, stdout: '', stderr: 'absent' }),
    async run() { ran = true; return 0; },
  }));

  assert.equal(result.status, 'skipped');
  assert.equal(ran, false);
});

test('--dry-run n’écrit rien quand l’enregistrement pointe ailleurs', async () => {
  let ran = false;
  const result = await install({ dryRun: true }, dependencies({
    runCapture: () => ({ code: 0, stdout: 'Args: /autre/clone/server.mjs', stderr: '' }),
    async run() { ran = true; return 0; },
  }));

  assert.equal(result.status, 'skipped');
  assert.equal(ran, false);
});

test('check : conforme quand l’entrée pointe sur ce dépôt', async () => {
  const result = await check({}, dependencies({
    runCapture: () => ({
      code: 0,
      stdout: 'Args: /Users/tsardet/Sites/PieceMaker-Installer/mcp/piecemaker/server.mjs',
      stderr: '',
    }),
  }));

  assert.equal(result.status, 'done');
});

test('check : en échec quand rien n’est enregistré', async () => {
  const result = await check({}, dependencies({
    runCapture: () => ({ code: 1, stdout: '', stderr: 'absent' }),
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.note, /non enregistré/);
});

test('check : en échec quand l’entrée pointe ailleurs', async () => {
  const result = await check({}, dependencies({
    runCapture: () => ({ code: 0, stdout: 'Args: /autre/clone/server.mjs', stderr: '' }),
  }));

  assert.equal(result.status, 'failed');
  assert.match(result.note, /pointe ailleurs/);
});

test('check : ignoré quand la CLI claude est absente', async () => {
  const result = await check({}, dependencies({ commandExists: () => false }));
  assert.equal(result.status, 'skipped');
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { registerWordMcpClients, wordMcpClientStatus } from '../installer/lib/word-mcp-clients.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = path.join(root, 'mcp-server', 'mcp-server-local.js');

test('enregistre le MCP Word avec les commandes natives Codex et Claude', () => {
  const calls = [];
  const configured = new Set();
  const ops = {
    commandExists: () => true,
    runCapture(command, args) {
      calls.push([command, ...args]);
      if (args[0] === 'mcp' && args[1] === 'get') return { code: configured.has(command) ? 0 : 1, stdout: '', stderr: '' };
      configured.add(command);
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  const result = registerWordMcpClients(root, ops);
  assert.deepEqual(result.map(({ name, configured: ready }) => [name, ready]), [['codex', true], ['claude', true]]);
  assert.deepEqual(calls.filter((call) => call[2] === 'add'), [
    ['codex', 'mcp', 'add', 'piecemaker-word', '--', process.execPath, server],
    ['claude', 'mcp', 'add', '--scope', 'user', 'piecemaker-word', '--', process.execPath, server],
  ]);
});

test('ne modifie pas un MCP déjà configuré et ignore un client absent', () => {
  const calls = [];
  const ops = {
    commandExists: (name) => name === 'codex',
    runCapture(command, args) { calls.push([command, ...args]); return { code: 0, stdout: '{}', stderr: '' }; },
  };
  const result = registerWordMcpClients(root, ops);
  assert.equal(result[0].configured, true);
  assert.equal(result[1].available, false);
  assert.equal(calls.some((call) => call.includes('add')), false);
  assert.equal(wordMcpClientStatus(root, 'codex', ops).configured, true);
});

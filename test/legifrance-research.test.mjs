import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('le corpus jurisprudentiel exhaustif est testé sans réseau', () => {
  const result = spawnSync(
    'python3',
    ['-m', 'unittest', 'discover', '-s', 'piecemaker-plugin/mcp/legifrance/tests', '-p', 'test_*.py'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran \d+ tests/);
});

test('les nouveaux outils sont exposés par le serveur MCP stdio', () => {
  const request = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  })}\n`;
  const result = spawnSync(
    'python3',
    ['piecemaker-plugin/mcp/legifrance/mcp_stdio_server.py'],
    { cwd: root, input: request, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout.trim());
  const names = response.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('Build_Research_Corpus'));
  assert.ok(names.includes('Validate_Research_Cards'));
});

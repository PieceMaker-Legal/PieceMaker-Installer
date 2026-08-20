import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(root, 'mcp-server', 'mcp-server-local.js');

function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function readMessage(stdout, timeoutMs = 5000) {
  let buffer = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stdout.off('data', onData);
      reject(new Error(`MCP response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;

      clearTimeout(timeout);
      stdout.off('data', onData);
      resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
    };

    stdout.on('data', onData);
  });
}

test('le serveur MCP local annonce uniquement le relais d’outils livré', async () => {
  const child = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: { ...process.env, OUTPUT_PATH: '/tmp/obsolete-piece-maker-output' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'piece-maker-test', version: '1.0.0' },
      },
    }));
    const initialized = await readMessage(child.stdout);

    assert.equal(initialized.id, 1);
    assert.ok(initialized.result?.capabilities?.tools);
    assert.equal('prompts' in initialized.result.capabilities, false);

    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'prompts/list',
      params: {},
    }));
    const promptsResponse = await readMessage(child.stdout);

    assert.equal(promptsResponse.id, 2);
    assert.equal(promptsResponse.error?.code, -32601);
    assert.match(promptsResponse.error?.message || '', /method not found/i);
    assert.doesNotMatch(stderr, /mcp-prompts\.json|Prompts: Enabled|addon\/output/);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

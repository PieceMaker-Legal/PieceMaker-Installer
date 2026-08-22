import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readMessage(stdout) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error('Délai MCP dépassé')), 10000);
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      stdout.off('data', onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    stdout.setEncoding('utf8');
    stdout.on('data', onData);
  });
}

test('les outils actifs documentent les vues, révisions et écritures suivies', async () => {
  const child = spawn(process.execPath, [path.join(root, 'mcp-server/mcp-server-local.js')], {
    cwd: root,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'piece-maker-schema-test', version: '1.0.0' }
      }
    })}\n`);
    await readMessage(child.stdout);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const response = await readMessage(child.stdout);
    const tools = response.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['open_doc', 'read_doc', 'edit_doc']);

    const read = tools.find((tool) => tool.name === 'read_doc').inputSchema;
    assert.deepEqual(read.properties.revision_view.enum, ['current', 'original']);
    assert.equal(read.properties.max_chars.maximum, 100000);
    assert.ok(read.properties.revisions.properties.from_revision);
    assert.equal('include_track_changes' in read.properties, false);

    const edit = tools.find((tool) => tool.name === 'edit_doc').inputSchema;
    assert.equal(edit.properties.track_changes.type, 'boolean');
    assert.deepEqual(
      edit.properties.review.properties.action.enum,
      ['show', 'display', 'accept', 'reject', 'accept_all', 'reject_all']
    );
    assert.ok(edit.anyOf.some((branch) => branch.required?.includes('review')));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
  }
});

test('le schéma du modèle intégré reste aligné sans réannoncer le paramètre historique', async () => {
  const source = await readFile(path.join(root, 'taskpane/taskpane.js'), 'utf8');
  const schemaBlock = source.slice(
    source.indexOf('const ENABLED_LOCAL_TOOL_NAMES'),
    source.indexOf('// WebSocket pour communication')
  );

  assert.match(schemaBlock, /revision_view/);
  assert.match(schemaBlock, /READ_REVISIONS_SCHEMA/);
  assert.match(schemaBlock, /track_changes/);
  assert.match(schemaBlock, /REVIEW_SCHEMA/);
  assert.doesNotMatch(schemaBlock, /include_track_changes/);
});

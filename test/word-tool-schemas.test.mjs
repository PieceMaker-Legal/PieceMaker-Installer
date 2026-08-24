import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

import {
  EDIT_DOC_TOOL,
  READ_DOC_TOOL,
  TEMPLATE_TOOL,
  toEmbeddedTool
} from '../taskpane/modules/word-tool-schemas.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANE = { paneId: 'a1b2' };

test('les variantes JSON excluent les combinaisons ambiguës', () => {
  const ajv = new Ajv({ strict: false });
  const validateRead = ajv.compile(READ_DOC_TOOL.inputSchema);
  const validateEdit = ajv.compile(EDIT_DOC_TOOL.inputSchema);
  const validateTemplate = ajv.compile(TEMPLATE_TOOL.inputSchema);

  assert.equal(validateRead({ ...PANE, list_headings: false, indexes: [0] }), true);
  assert.equal(validateRead({ ...PANE, list_headings: true, indexes: [0] }), false);
  assert.equal(validateRead({ ...PANE, revisions: {}, revision_view: 'current' }), false);
  assert.equal(validateRead({ list_headings: true }), false);

  assert.equal(validateEdit({ ...PANE, operation: 'delete', indexes_to_delete: [0] }), true);
  assert.equal(validateEdit({
    ...PANE,
    operation: 'delete',
    indexes_to_delete: [0],
    review: { action: 'display', markup: 'all' }
  }), false);
  assert.equal(validateEdit({
    ...PANE,
    review: {
      action: 'accept',
      snapshot: 'snapshot',
      filter: {},
      confirm: true
    }
  }), false);
  assert.equal(validateEdit({
    ...PANE,
    review: {
      action: 'accept',
      snapshot: 'snapshot',
      filter: { authors: ['Auteur'] },
      confirm: true
    }
  }), true);
  assert.equal(validateEdit({ operation: 'delete', indexes_to_delete: [0] }), false);
  assert.match(EDIT_DOC_TOOL.inputSchema.properties.review.description, /display: markup\/view\/reviewers/);

  assert.equal(validateTemplate({ ...PANE, path: '/tmp/template.docx' }), true);
  assert.equal(validateTemplate({ path: '/tmp/template.docx' }), false);
});

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
    assert.deepEqual(tools.map((tool) => tool.name), ['open_doc', 'read_doc', 'edit_doc', 'template']);

    const read = tools.find((tool) => tool.name === 'read_doc').inputSchema;
    assert.deepEqual(read, READ_DOC_TOOL.inputSchema);
    assert.deepEqual(read.properties.revision_view.enum, ['current', 'original']);
    assert.equal(read.properties.max_chars.maximum, 100000);
    assert.equal(read.properties.indexes.oneOf[0].items.type, 'integer');
    assert.ok(read.properties.revisions.properties.from_revision);
    assert.deepEqual(read.required, ['paneId']);
    assert.equal('include_track_changes' in read.properties, false);

    const edit = tools.find((tool) => tool.name === 'edit_doc').inputSchema;
    assert.deepEqual(edit, EDIT_DOC_TOOL.inputSchema);
    assert.equal(edit.properties.track_changes.type, 'boolean');
    assert.deepEqual(edit.required, ['paneId']);
    assert.deepEqual(
      edit.properties.review.properties.action.enum,
      ['show', 'display', 'accept', 'reject', 'accept_all', 'reject_all']
    );
    assert.ok(edit.oneOf.some((branch) => branch.required?.includes('review')));

    const template = tools.find((tool) => tool.name === 'template').inputSchema;
    assert.deepEqual(template, TEMPLATE_TOOL.inputSchema);
    assert.deepEqual(template.required, ['paneId', 'path']);
    assert.match(TEMPLATE_TOOL.description, /success: true, content: texte intégral du template, placeholders inclus/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'edit_doc',
        arguments: {
          paneId: 'a1b2',
          operation: 'delete',
          indexes_to_delete: [0],
          review: { action: 'display', markup: 'all' }
        }
      }
    })}\n`);
    const ambiguousEdit = await readMessage(child.stdout);
    assert.equal(ambiguousEdit.result?.isError, true);
    assert.match(ambiguousEdit.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'read_doc',
        arguments: { paneId: 'a1b2', revisions: {}, indexes: [0] }
      }
    })}\n`);
    const ambiguousRead = await readMessage(child.stdout);
    assert.equal(ambiguousRead.result?.isError, true);
    assert.match(ambiguousRead.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'read_doc',
        arguments: { list_headings: false, indexes: [0] }
      }
    })}\n`);
    const missingPane = await readMessage(child.stdout);
    assert.equal(missingPane.result?.isError, true);
    assert.match(missingPane.result?.content?.[0]?.text || '', /paneId/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'edit_doc',
        arguments: {
          paneId: 'a1b2',
          review: {
            action: 'accept',
            snapshot: 'snapshot',
            filter: {},
            confirm: true
          }
        }
      }
    })}\n`);
    const emptyFilter = await readMessage(child.stdout);
    assert.equal(emptyFilter.result?.isError, true);
    assert.match(emptyFilter.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'edit_doc',
        arguments: { paneId: 'a1b2', review: { action: 'display' } }
      }
    })}\n`);
    const incompleteDisplay = await readMessage(child.stdout);
    assert.equal(incompleteDisplay.result?.isError, true);
    assert.match(incompleteDisplay.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'edit_doc',
        arguments: { paneId: 'a1b2', edits: [{ operation: 'insert_after' }] }
      }
    })}\n`);
    const incompleteBatch = await readMessage(child.stdout);
    assert.equal(incompleteBatch.result?.isError, true);
    assert.match(incompleteBatch.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'edit_doc',
        arguments: { paneId: 'a1b2', review: { action: 'show', index: 1 } }
      }
    })}\n`);
    const incompleteShow = await readMessage(child.stdout);
    assert.equal(incompleteShow.result?.isError, true);
    assert.match(incompleteShow.result?.content?.[0]?.text || '', /Arguments invalides/);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'template',
        arguments: { paneId: 'a1b2', path: 'template.docx' }
      }
    })}\n`);
    const relativeTemplate = await readMessage(child.stdout);
    assert.equal(relativeTemplate.result?.isError, true);
    assert.match(relativeTemplate.result?.content?.[0]?.text || '', /chemin absolu/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
  }
});

test('le schéma du modèle intégré reste aligné sans réannoncer le paramètre historique', async () => {
  const source = await readFile(path.join(root, 'taskpane/taskpane.js'), 'utf8');
  const callLlmBlock = source.slice(
    source.indexOf('async function callLLM(messages)'),
    source.indexOf('async function callLLMWithFallback')
  );

  assert.match(source, /from '\.\/modules\/word-tool-schemas\.js'/);
  assert.match(source, /\[READ_DOC_TOOL\.name, toEmbeddedTool\(READ_DOC_TOOL\)\]/);
  assert.match(source, /\[EDIT_DOC_TOOL\.name, toEmbeddedTool\(EDIT_DOC_TOOL\)\]/);
  assert.match(callLlmBlock, /const tools = \[\.\.\.ACTIVE_LOCAL_TOOL_SCHEMAS\.values\(\)\]/);
  assert.doesNotMatch(callLlmBlock, /name: ['"]read_doc['"]/);
  assert.doesNotMatch(callLlmBlock, /name: ['"]edit_doc['"]/);
  const embeddedRead = toEmbeddedTool(READ_DOC_TOOL);
  assert.equal(embeddedRead.name, 'read_doc');
  assert.equal(embeddedRead.description, READ_DOC_TOOL.description);
  assert.equal('paneId' in embeddedRead.input_schema.properties, false);
  assert.equal('required' in embeddedRead.input_schema, false);
});

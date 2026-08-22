import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docToolsPath = path.join(root, 'taskpane', 'modules', 'doc-tools.js');

async function loadPureHelpers() {
  const source = readFileSync(docToolsPath, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace('function formatIndexedEntries(', 'export function formatIndexedEntries(')
    .replace('function prepareBatchEdits(', 'export function prepareBatchEdits(');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  return import(moduleUrl);
}

test('read_doc plafonne sa sortie et fournit un curseur de reprise', async () => {
  const { formatIndexedEntries } = await loadPureHelpers();
  const entries = [
    { index: 2, content: 'A'.repeat(600) },
    { index: 3, content: 'suite' },
  ];

  const firstPage = formatIndexedEntries(entries, { maxChars: 500 });
  assert.ok(firstPage.length <= 500);
  assert.match(firstPage, /\[TRUNCATED\]/);
  assert.match(firstPage, /"from_index":2,"from_offset":\d+/);

  const offset = Number(firstPage.match(/"from_offset":(\d+)/)?.[1]);
  const secondPage = formatIndexedEntries(entries, {
    fromIndex: 2,
    fromOffset: offset,
    maxChars: 500,
  });
  assert.match(secondPage, /^2 -> A+/);
  assert.match(secondPage, /3 -> suite/);

  const defaultPage = formatIndexedEntries([
    { index: 0, content: 'B'.repeat(120000) },
  ]);
  assert.ok(defaultPage.length <= 100000);
  assert.match(defaultPage, /\[TRUNCATED\]/);
});

test('edit_doc prépare les lots de haut en bas et refuse les index ambigus', async () => {
  const { prepareBatchEdits } = await loadPureHelpers();
  const prepared = prepareBatchEdits([
    { operation: 'insert_after', target_index: 2, text: 'Texte' },
    { operation: 'delete', indexes_to_delete: [4, 9] },
  ]);

  assert.deepEqual(prepared.edits.map((edit) => edit.anchor), [9, 4, 2]);

  const conflict = prepareBatchEdits([
    { operation: 'insert_before', target_index: 4, text: 'Texte' },
    { operation: 'delete', indexes_to_delete: [4] },
  ]);
  assert.match(conflict.error, /both an insertion target and deleted/);
});

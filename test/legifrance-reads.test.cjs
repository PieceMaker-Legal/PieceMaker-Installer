const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MARKER_NAME,
  READ_LOG_NAME,
  findResultsRoot,
  loadReadLog,
  recordRead,
} = require('../piecemaker-plugin/scripts/lib/legifrance-reads.cjs');

function makeResultsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-results-'));
  fs.writeFileSync(path.join(root, MARKER_NAME), JSON.stringify({ kind: 'legifrance-results' }));
  fs.writeFileSync(path.join(root, 'index.md'), '# index');
  fs.writeFileSync(path.join(root, '001-arret.md'), '# arret');
  return root;
}

test('findResultsRoot locates the marked folder from a file inside it', () => {
  const root = makeResultsDir();
  const found = findResultsRoot(path.join(root, '001-arret.md'));
  assert.equal(fs.realpathSync(found), fs.realpathSync(root));
});

test('findResultsRoot returns null outside any results folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  fs.writeFileSync(path.join(dir, 'foo.md'), 'x');
  assert.equal(findResultsRoot(path.join(dir, 'foo.md')), null);
});

test('recordRead counts reads and tracks distinct files', () => {
  const root = makeResultsDir();
  recordRead(root, '001-arret.md', { at: '2026-08-18T10:00:00Z' });
  recordRead(root, '001-arret.md', { at: '2026-08-18T10:01:00Z' });
  recordRead(root, 'index.md', { at: '2026-08-18T10:02:00Z' });

  const log = loadReadLog(root);
  assert.equal(log.counts['001-arret.md'], 2);
  assert.equal(log.counts['index.md'], 1);
  assert.equal(log.distinct, 2);
  assert.equal(log.reads.length, 3);
  assert.ok(fs.existsSync(path.join(root, READ_LOG_NAME)));
});

test('recordRead ignores the marker and the log itself', () => {
  const root = makeResultsDir();
  assert.equal(recordRead(root, MARKER_NAME, {}), null);
  assert.equal(recordRead(root, READ_LOG_NAME, {}), null);
  const log = loadReadLog(root);
  assert.equal(log.reads.length, 0);
});

test('recordRead reports firstTime on the first read of a file', () => {
  const root = makeResultsDir();
  assert.equal(recordRead(root, '001-arret.md', {}).firstTime, true);
  assert.equal(recordRead(root, '001-arret.md', {}).firstTime, false);
});

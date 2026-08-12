const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readDocumentIndex,
  documentIndexFile,
  categoryForCode,
  buildChronology,
} = require('../websocket-server/document-index.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

const stateKey = (relative) => crypto.createHash('sha256').update(relative).digest('hex');

function fixture({ index, mapping } = {}) {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-docindex-'));
  fs.writeFileSync(path.join(caseRoot, 'Assignation.pdf'), 'ORIGINAL');
  fs.writeFileSync(path.join(caseRoot, 'Courrier.pdf'), 'ORIGINAL');
  fs.mkdirSync(path.join(caseRoot, '.piecemaker'), { recursive: true });
  if (index) {
    fs.writeFileSync(documentIndexFile(caseRoot), JSON.stringify(index, null, 2));
  }
  if (mapping) {
    const dir = path.join(caseRoot, WORKSPACE_SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mapping_default.json'), JSON.stringify(mapping, null, 2));
  }
  return caseRoot;
}

const SAMPLE_INDEX = () => ({
  version: 1,
  documents: {
    [stateKey('Assignation.pdf')]: {
      nature: 'assignation', nature_confidence: 0.6,
      doc_date: '14 mars 2023', doc_date_iso: '2023-03-14',
      juridiction: 'Tribunal judiciaire de Paris',
      codes: ['PERSONNE_PHYSIQUE_01', 'PERSONNE_MORALE_01'],
      updatedAt: '2026-08-12T00:00:00Z',
    },
    [stateKey('Courrier.pdf')]: {
      nature: 'courrier', nature_confidence: 0.9,
      doc_date: '2 février 2023', doc_date_iso: '2023-02-02',
      juridiction: null,
      codes: ['PERSONNE_PHYSIQUE_01'],
      updatedAt: '2026-08-12T00:00:00Z',
    },
  },
});

const SAMPLE_MAPPING = () => ({
  mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01', 'IMMOBILIÈRE DU PARC': 'PERSONNE_MORALE_01' },
  reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'], PERSONNE_MORALE_01: ['IMMOBILIÈRE DU PARC'] },
});

test('categoryForCode maps every code family', () => {
  assert.equal(categoryForCode('PERSONNE_PHYSIQUE_01'), 'personne');
  assert.equal(categoryForCode('PERSONNE_MORALE_02'), 'societe');
  assert.equal(categoryForCode('SOCIETE_SA_03'), 'societe');
  assert.equal(categoryForCode('ADRESSE_01'), 'adresse');
  assert.equal(categoryForCode('SIREN_01'), 'siren');
  assert.equal(categoryForCode('EMAIL_01'), 'autre');
});

test('readDocumentIndex tolerates a missing or corrupt file', () => {
  const caseRoot = fixture();
  assert.deepEqual(readDocumentIndex(caseRoot), { version: 1, documents: {} });
  fs.writeFileSync(documentIndexFile(caseRoot), 'not json {{{');
  assert.deepEqual(readDocumentIndex(caseRoot), { version: 1, documents: {} });
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('readDocumentIndex drops entries whose key is not a sha256 hash', () => {
  const caseRoot = fixture({
    index: { version: 1, documents: { 'plain-filename.pdf': { codes: [] }, [stateKey('Courrier.pdf')]: { codes: ['X_01'] } } },
  });
  const index = readDocumentIndex(caseRoot);
  assert.equal(Object.keys(index.documents).length, 1);
  assert.ok(index.documents[stateKey('Courrier.pdf')]);
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('buildChronology orders documents by date and aggregates shared entities', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  const chrono = await buildChronology(caseRoot, { deanonymize: true });

  assert.equal(chrono.stats.documents, 2);
  assert.equal(chrono.stats.indexed, 2);
  assert.equal(chrono.stats.dated, 2);
  assert.deepEqual(chrono.stats.span, { from: '2023-02-02', to: '2023-03-14' });

  // Chronological order: Courrier (Feb) before Assignation (Mar).
  assert.deepEqual(chrono.documents.map((d) => d.name), ['Courrier.pdf', 'Assignation.pdf']);

  // Entity cited in both documents ranks first with the right count.
  const person = chrono.entities.find((e) => e.code === 'PERSONNE_PHYSIQUE_01');
  assert.equal(person.documentCount, 2);
  assert.equal(person.label, 'Bernard Gilly');
  assert.equal(person.category, 'personne');

  // Graph is bipartite: one node per doc + per entity, one edge per citation.
  const docNodes = chrono.graph.nodes.filter((n) => n.kind === 'document');
  const entityNodes = chrono.graph.nodes.filter((n) => n.kind === 'entity');
  assert.equal(docNodes.length, 2);
  assert.equal(entityNodes.length, 2);
  assert.equal(chrono.graph.edges.length, 3); // 2 (assignation) + 1 (courrier)

  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('buildChronology with deanonymize=false never exposes clear names', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  const chrono = await buildChronology(caseRoot, { deanonymize: false });
  assert.equal(chrono.deanonymized, false);
  assert.ok(chrono.entities.every((e) => e.label === null));
  assert.ok(chrono.documents.every((d) => d.codes.every((c) => c.label === null)));
  // Graph entity labels fall back to the code, not a name.
  const entityNodes = chrono.graph.nodes.filter((n) => n.kind === 'entity');
  assert.ok(entityNodes.every((n) => n.label === n.code));
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('buildChronology drops codes no longer present in the mapping', async () => {
  const index = SAMPLE_INDEX();
  // Attribute a stale code the mapping no longer knows about.
  index.documents[stateKey('Assignation.pdf')].codes.push('PERSONNE_PHYSIQUE_99');
  const caseRoot = fixture({ index, mapping: SAMPLE_MAPPING() });
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  const assignation = chrono.documents.find((d) => d.name === 'Assignation.pdf');
  assert.ok(!assignation.codes.some((c) => c.code === 'PERSONNE_PHYSIQUE_99'));
  assert.ok(!chrono.entities.some((e) => e.code === 'PERSONNE_PHYSIQUE_99'));
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('buildChronology lists an unscanned original with no metadata', async () => {
  const caseRoot = fixture({ mapping: SAMPLE_MAPPING() }); // no index at all
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  assert.equal(chrono.stats.documents, 2);
  assert.equal(chrono.stats.indexed, 0);
  assert.ok(chrono.documents.every((d) => d.indexed === false && d.codes.length === 0));
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

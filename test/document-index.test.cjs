const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readDocumentIndex,
  documentIndexFile,
  readDocumentIndexOverrides,
  writeDocumentIndexOverride,
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
  // A legacy malformed code ("SOCIETE SA_02" with a space) must still bucket as a company.
  assert.equal(categoryForCode('SOCIETE SA_02'), 'societe');
  // Role-prefixed person codes from the mapping vocabulary bucket as people.
  assert.equal(categoryForCode('CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01'), 'personne');
  assert.equal(categoryForCode('ADVERSAIRE_DEFENDEUR_PERSONNE_PHYSIQUE_01'), 'personne');
});

test('readDocumentIndex tolerates a missing or corrupt file', () => {
  const caseRoot = fixture();
  assert.deepEqual(readDocumentIndex(caseRoot), { version: 1, documents: {}, overrides: {} });
  fs.writeFileSync(documentIndexFile(caseRoot), 'not json {{{');
  assert.deepEqual(readDocumentIndex(caseRoot), { version: 1, documents: {}, overrides: {} });
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

test('buildChronology scrubs a juridiction that leaks a mapped party name', async () => {
  const index = SAMPLE_INDEX();
  // The Assignation keeps a genuine court; the Courrier's juridiction was
  // mis-extracted as a mapped party ("Bernard Gilly") — that must be dropped.
  index.documents[stateKey('Courrier.pdf')].juridiction = 'Bernard Gilly';
  const caseRoot = fixture({ index, mapping: SAMPLE_MAPPING() });
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  const assignation = chrono.documents.find((d) => d.name === 'Assignation.pdf');
  const courrier = chrono.documents.find((d) => d.name === 'Courrier.pdf');
  assert.equal(assignation.juridiction, 'Tribunal judiciaire de Paris');
  assert.equal(courrier.juridiction, null, 'a leaked party name must never surface as a juridiction');
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('buildChronology lists an unscanned original with no metadata', async () => {
  const caseRoot = fixture({ mapping: SAMPLE_MAPPING() }); // no index at all
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  assert.equal(chrono.stats.documents, 2);
  assert.equal(chrono.stats.indexed, 0);
  assert.ok(chrono.documents.every((d) => d.indexed === false && d.codes.length === 0));
  assert.ok(chrono.documents.every((d) => d.edited === false && Array.isArray(d.fields) && d.fields.length === 0));
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('a manual override wins over detection and re-orders the timeline', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  // Correct the Courrier: new date pushes it AFTER the Assignation, new type/lieu,
  // and two custom fields (one blank-labelled entry must be dropped).
  writeDocumentIndexOverride(caseRoot, 'Courrier.pdf', {
    nature: 'mise en demeure',
    dateIso: '2023-06-01',
    juridiction: 'Étude de Maître X',
    fields: [{ label: 'Cote', value: 'D12' }, { label: '', value: '' }],
  });
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  const courrier = chrono.documents.find((d) => d.name === 'Courrier.pdf');
  assert.equal(courrier.edited, true);
  assert.equal(courrier.nature, 'mise en demeure');
  assert.equal(courrier.dateIso, '2023-06-01');
  assert.equal(courrier.juridiction, 'Étude de Maître X');
  assert.deepEqual(courrier.fields, [{ label: 'Cote', value: 'D12' }]);
  // June now sorts last; span end moves with it.
  assert.deepEqual(chrono.documents.map((d) => d.name), ['Assignation.pdf', 'Courrier.pdf']);
  assert.deepEqual(chrono.stats.span, { from: '2023-03-14', to: '2023-06-01' });
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('a manually typed lieu is never scrubbed against the mapping', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  // Detection would scrub a lieu sharing a token with a mapped party; a manual
  // one is the cabinet's deliberate annotation and must survive verbatim.
  writeDocumentIndexOverride(caseRoot, 'Courrier.pdf', { juridiction: 'Bernard Gilly' });
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  const courrier = chrono.documents.find((d) => d.name === 'Courrier.pdf');
  assert.equal(courrier.juridiction, 'Bernard Gilly');
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('overrides are ignored in the code-only view (never leak clear text)', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  writeDocumentIndexOverride(caseRoot, 'Courrier.pdf', {
    juridiction: 'Étude de Maître X',
    fields: [{ label: 'Note', value: 'texte libre en clair' }],
  });
  const chrono = await buildChronology(caseRoot, { deanonymize: false });
  const courrier = chrono.documents.find((d) => d.name === 'Courrier.pdf');
  assert.equal(courrier.edited, false);
  assert.equal(courrier.juridiction, null);
  assert.deepEqual(courrier.fields, []);
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('an emptied override deletes the entry (reverts to detection)', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  writeDocumentIndexOverride(caseRoot, 'Courrier.pdf', { nature: 'mise en demeure' });
  assert.ok(readDocumentIndexOverrides(caseRoot).documents[stateKey('Courrier.pdf')]);
  // Clearing every field removes the override rather than persisting an empty shell.
  const result = writeDocumentIndexOverride(caseRoot, 'Courrier.pdf', {
    nature: '', dateIso: null, juridiction: '', fields: [],
  });
  assert.equal(result, null);
  assert.ok(!readDocumentIndexOverrides(caseRoot).documents[stateKey('Courrier.pdf')]);
  const chrono = await buildChronology(caseRoot, { deanonymize: true });
  const courrier = chrono.documents.find((d) => d.name === 'Courrier.pdf');
  assert.equal(courrier.edited, false);
  assert.equal(courrier.nature, 'courrier'); // detected value is back
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('manual overrides live in the sole document-index.json, mode 0600', async () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  writeDocumentIndexOverride(caseRoot, 'Assignation.pdf', { nature: 'jugement' });
  const file = documentIndexFile(caseRoot);
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.documents[stateKey('Assignation.pdf')].nature, 'assignation');
  assert.equal(stored.overrides[stateKey('Assignation.pdf')].nature, 'jugement');
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('document-index')),
    ['document-index.json'],
  );
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

test('a legacy override file is migrated into document-index.json without loss', () => {
  const caseRoot = fixture({ index: SAMPLE_INDEX(), mapping: SAMPLE_MAPPING() });
  const legacyFile = path.join(caseRoot, '.piecemaker', 'document-index-overrides.json');
  fs.writeFileSync(legacyFile, JSON.stringify({
    version: 1,
    documents: {
      [stateKey('Courrier.pdf')]: { nature: 'mise en demeure' },
    },
  }));

  writeDocumentIndexOverride(caseRoot, 'Assignation.pdf', { nature: 'jugement' });

  const stored = JSON.parse(fs.readFileSync(documentIndexFile(caseRoot), 'utf8'));
  assert.equal(stored.overrides[stateKey('Courrier.pdf')].nature, 'mise en demeure');
  assert.equal(stored.overrides[stateKey('Assignation.pdf')].nature, 'jugement');
  assert.equal(fs.existsSync(legacyFile), false);
  fs.rmSync(caseRoot, { recursive: true, force: true });
});

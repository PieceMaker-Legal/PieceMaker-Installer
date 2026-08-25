const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  buildAssistantChronology,
  chronologyForTarget,
  formatAssistantChronology,
} = require('../websocket-server/assistant-chronology.cjs');
const {
  documentIndexFile,
  writeDocumentIndexOverride,
} = require('../websocket-server/document-index.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

const projectRoot = path.resolve(__dirname, '..');
const cli = path.join(projectRoot, 'installer', 'bin', 'piecemaker.mjs');
const stateKey = (relative) => crypto.createHash('sha256').update(relative).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-assistant-chronology-'));
  const caseRoot = path.join(root, 'Dossier test');
  const home = path.join(root, 'home');
  const first = 'Assignation Bernard Gilly.pdf';
  const second = 'Courrier.pdf';
  fs.mkdirSync(caseRoot, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(caseRoot, first), 'ORIGINAL');
  fs.writeFileSync(path.join(caseRoot, second), 'ORIGINAL');
  fs.mkdirSync(path.dirname(documentIndexFile(caseRoot)), { recursive: true });
  fs.writeFileSync(documentIndexFile(caseRoot), JSON.stringify({
    version: 1,
    documents: {
      [stateKey(first)]: {
        nature: 'assignation',
        nature_confidence: 0.9,
        doc_date: '14 mars 2023',
        doc_date_iso: '2023-03-14',
        juridiction: 'Tribunal judiciaire de Paris',
        codes: ['PERSONNE_PHYSIQUE_01', 'PERSONNE_MORALE_01'],
      },
      [stateKey(second)]: {
        nature: 'courrier',
        nature_confidence: 0.8,
        doc_date: null,
        doc_date_iso: null,
        juridiction: null,
        codes: ['PERSONNE_PHYSIQUE_01'],
      },
    },
  }, null, 2));
  const converted = path.join(caseRoot, WORKSPACE_SUBDIR);
  fs.mkdirSync(converted, { recursive: true });
  fs.writeFileSync(path.join(converted, 'mapping_default.json'), JSON.stringify({
    mapping: {
      'Bernard Gilly': 'PERSONNE_PHYSIQUE_01',
      'Société du Parc': 'PERSONNE_MORALE_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Bernard Gilly'],
      PERSONNE_MORALE_01: ['Société du Parc'],
    },
  }, null, 2));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ caseFolders: [caseRoot] }, null, 2));
  return { root, caseRoot, home, first, second };
}

test('la chronologie assistant est triée, pseudonymisée et reprend les corrections structurées', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  writeDocumentIndexOverride(data.caseRoot, data.second, {
    dateIso: '2023-01-05',
    nature: 'mise en demeure',
    juridiction: 'Texte libre non destiné au modèle',
    fields: [{ label: 'Secret', value: 'hors projection' }],
  });

  const chronology = await buildAssistantChronology(data.caseRoot);
  const serialized = JSON.stringify(chronology);
  assert.doesNotMatch(serialized, /Bernard Gilly|Société du Parc|hors projection|Texte libre/);
  assert.match(serialized, /PERSONNE_PHYSIQUE_01/);
  assert.equal(chronology.confidentiality, 'pseudonymisee');
  assert.equal(chronology.documents[0].date, '2023-01-05');
  assert.equal(chronology.documents[0].nature, 'mise en demeure');
  assert.equal(chronology.documents[0].dateSource, 'correction-cabinet');
  assert.match(chronology.documents[1].piece, /PERSONNE_PHYSIQUE_01/);
  assert.equal(chronology.graph.entities.find((entity) => entity.code === 'PERSONNE_PHYSIQUE_01').documentCount, 2);
  assert.equal(chronology.graph.edgeCount, 3);

  const markdown = formatAssistantChronology(chronology);
  assert.match(markdown, /# Chronologie PieceMaker/);
  assert.match(markdown, /Liens entre pièces/);
  assert.doesNotMatch(markdown, /Bernard Gilly/);
});

test('la cible doit appartenir à un dossier explicitement enregistré', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const chronology = await chronologyForTarget({ caseFolders: [data.caseRoot] }, data.caseRoot);
  assert.equal(chronology.stats.documents, 2);
  await assert.rejects(
    chronologyForTarget({ caseFolders: [] }, data.caseRoot),
    /Aucun dossier juridique enregistré/,
  );
});

test('piecemaker chronology --json produit un JSON pur depuis le dossier courant', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, 'chronology', '--json'], {
    cwd: data.caseRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PIECEMAKER_HOME: data.home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /PieceMaker local/);
  const chronology = JSON.parse(result.stdout);
  assert.equal(chronology.stats.documents, 2);
  assert.equal(chronology.confidentiality, 'pseudonymisee');
  assert.doesNotMatch(result.stdout, /Bernard Gilly/);
});

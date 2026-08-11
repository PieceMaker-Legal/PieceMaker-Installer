const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveConfiguredLegalCaseFolder } = require('../websocket-server/workspace-paths.cjs');

test('un document est ramené au dossier juridique enregistré qui le contient', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-routing-test-'));
  const legalCase = path.join(root, 'clients', 'Dossier Dupont');
  const nested = path.join(legalCase, 'Actes', 'Projet');
  const outside = path.join(root, 'hors-dossier');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = { caseFolders: [legalCase] };
  // macOS : /var est un lien vers /private/var, le résultat est le chemin réel.
  assert.equal(resolveConfiguredLegalCaseFolder(config, nested), fs.realpathSync(legalCase));
});

test('un dossier non enregistré est refusé, il n’y a plus de racine fourre-tout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-routing-test-'));
  const legalCase = path.join(root, 'clients', 'Dossier Dupont');
  const outside = path.join(root, 'hors-dossier');
  fs.mkdirSync(legalCase, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const config = { caseFolders: [legalCase] };
  assert.throws(() => resolveConfiguredLegalCaseFolder(config, outside), /n’est pas enregistré/);
});

test('sans aucun dossier enregistré, tout chemin est refusé', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-case-routing-test-'));
  const somewhere = path.join(root, 'un-dossier');
  fs.mkdirSync(somewhere, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => resolveConfiguredLegalCaseFolder({}, somewhere), /n’est pas enregistré/);
});

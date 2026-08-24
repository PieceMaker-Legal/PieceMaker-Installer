import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createWordPaneRegistry } = require('../websocket-server/lib/word-pane-registry.cjs');

const ID_A = 'a1b2';
const ID_B = 'c3d4';
const ID_C = 'e5f6';

function registry(options = {}) {
  const generated = [ID_C];
  return createWordPaneRegistry({
    platform: 'darwin',
    realpathSync: (value) => value.replace(/^\/tmp\//, '/private/tmp/'),
    createPaneId: () => generated.shift() || ID_C,
    ...options,
  });
}

test('génère un paneId alphanumérique de quatre caractères', () => {
  const panes = createWordPaneRegistry({ realpathSync: (value) => value });
  const client = { readyState: 1 };

  assert.match(panes.register(client, '/tmp/A.docx').paneId, /^[0-9a-z]{4}$/);
});

test('trois volets ou plus sont routés par leur identifiant opaque, sans slots', () => {
  const panes = registry();
  const clientA = { readyState: 1 };
  const clientB = { readyState: 1 };
  const clientC = { readyState: 1 };

  panes.register(clientA, '/tmp/Dossier A/acte.docx', ID_A);
  panes.register(clientB, '/tmp/Dossier B/acte.docx', ID_B);
  panes.register(clientC, '/tmp/Dossier C/acte.docx', ID_C);

  assert.equal(panes.getById(ID_A), clientA);
  assert.equal(panes.getById(ID_B), clientB);
  assert.equal(panes.getById(ID_C), clientC);
  assert.equal(panes.getByPath('/private/tmp/Dossier A/acte.docx'), clientA);
  assert.equal(panes.getByPath('/private/tmp/Dossier B/acte.docx'), clientB);
  assert.equal(panes.getByPath('/private/tmp/Dossier C/acte.docx'), clientC);
  assert.equal(panes.idCount, 3);
});

test('Enregistrer sous déplace le chemin mais conserve le paneId de la session', () => {
  const panes = registry();
  const client = { readyState: 1 };

  panes.register(client, '/tmp/Dossier A/original.docx', ID_A);
  panes.register(client, '/tmp/Dossier B/copie.docx', ID_A);

  assert.equal(panes.getByPath('/tmp/Dossier A/original.docx'), null);
  assert.equal(panes.getByPath('/tmp/Dossier B/copie.docx'), client);
  assert.equal(panes.getById(ID_A), client);
  assert.equal(panes.identityVersionFor(client), 2);
});

test('une collision de paneId ne peut jamais détourner un volet connecté', () => {
  const panes = registry();
  const clientA = { readyState: 1 };
  const clientB = { readyState: 1 };

  panes.register(clientA, '/tmp/A.docx', ID_A);
  const second = panes.register(clientB, '/tmp/B.docx', ID_A);

  assert.equal(second.paneId, ID_C);
  assert.equal(panes.getById(ID_A), clientA);
  assert.equal(panes.getById(ID_C), clientB);
});

test('une reconnexion reprend son paneId seulement après fermeture de l’ancien socket', () => {
  const panes = registry();
  const oldClient = { readyState: 1 };
  const newClient = { readyState: 1 };

  panes.register(oldClient, '/tmp/A.docx', ID_A);
  oldClient.readyState = 3;
  panes.register(newClient, '/tmp/A.docx', ID_A);

  assert.equal(panes.getById(ID_A), newClient);
  assert.equal(panes.idFor(oldClient), null);
  assert.equal(panes.idCount, 1);
});

test('la fermeture supprime les deux index et les requêtes suivantes échouent fermées', () => {
  const panes = registry();
  const client = { readyState: 1 };

  panes.register(client, '/tmp/A.docx', ID_A);
  panes.remove(client);

  assert.equal(panes.getById(ID_A), null);
  assert.equal(panes.getByPath('/tmp/A.docx'), null);
  assert.equal(panes.idCount, 0);
  assert.equal(panes.pathCount, 0);
});

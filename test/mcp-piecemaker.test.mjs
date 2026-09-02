import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  CLI_PATH,
  REPO_ROOT,
  chronologyArgs,
  conversionArgs,
  createServer,
  graphBuildArgs,
  graphQuestionArgs,
  graphStatusArgs,
  resolveDossier,
  runPiecemakerCommand,
  toToolResult,
} from '../mcp/piecemaker/server.mjs';

// --- Construction des arguments (purs, sans sous-processus) ---------------

test('graphe_question construit « graph query <question> --case <dossier> »', () => {
  assert.deepEqual(
    graphQuestionArgs({ question: 'Quels délais courent ?', dossier: '/dossier' }),
    ['graph', 'query', 'Quels délais courent ?', '--case', '/dossier'],
  );
});

test('graphe_question ajoute --budget seulement s’il est fourni', () => {
  assert.deepEqual(
    graphQuestionArgs({ question: 'q', dossier: '/d', budget: 2000 }),
    ['graph', 'query', 'q', '--case', '/d', '--budget', '2000'],
  );
  assert.deepEqual(
    graphQuestionArgs({ question: 'q', dossier: '/d' }),
    ['graph', 'query', 'q', '--case', '/d'],
  );
});

test('graphe_construire ajoute --json et --force seulement si demandé', () => {
  assert.deepEqual(
    graphBuildArgs({ dossier: '/d' }),
    ['graph', 'build', '--json', '--case', '/d'],
  );
  assert.deepEqual(
    graphBuildArgs({ dossier: '/d', force: true }),
    ['graph', 'build', '--json', '--case', '/d', '--force'],
  );
});

test('graphe_etat construit « graph status --json --case <dossier> »', () => {
  assert.deepEqual(
    graphStatusArgs({ dossier: '/d' }),
    ['graph', 'status', '--json', '--case', '/d'],
  );
});

test('conversion place les pièces avant --force et garde --json', () => {
  assert.deepEqual(
    conversionArgs({ dossier: '/d', pieces: ['a.pdf', 'sous-dossier/b.docx'], force: true }),
    ['conversion', '--json', '--case', '/d', 'a.pdf', 'sous-dossier/b.docx', '--force'],
  );
  assert.deepEqual(
    conversionArgs({ dossier: '/d' }),
    ['conversion', '--json', '--case', '/d'],
  );
});

test('chronologie construit « chronology --json --case <dossier> »', () => {
  assert.deepEqual(
    chronologyArgs({ dossier: '/d' }),
    ['chronology', '--json', '--case', '/d'],
  );
});

test('resolveDossier retombe sur le répertoire courant si absent ou vide', () => {
  assert.equal(resolveDossier('/dossier'), '/dossier');
  assert.equal(resolveDossier(undefined), process.cwd());
  assert.equal(resolveDossier(''), process.cwd());
  assert.equal(resolveDossier('   '), process.cwd());
});

// --- Chemins du binaire visé -----------------------------------------------

test('le serveur cible le binaire piecemaker de ce dépôt', () => {
  assert.equal(REPO_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  assert.equal(CLI_PATH, path.join(REPO_ROOT, 'installer', 'bin', 'piecemaker.mjs'));
  assert.equal(fs.existsSync(CLI_PATH), true);
});

// --- Gestion du code de sortie et sortie texte -----------------------------

test('toToolResult renvoie stdout tel quel sur succès (texte, pas de reformatage)', () => {
  const result = toToolResult({ code: 0, stdout: 'Réponse en texte libre du graphe.\n', stderr: '' });
  assert.deepEqual(result, {
    content: [{ type: 'text', text: 'Réponse en texte libre du graphe.\n' }],
  });
});

test('toToolResult isError avec stderr si le code de sortie est non nul', () => {
  const result = toToolResult({ code: 1, stdout: '', stderr: 'Le graphe doit être actualisé.' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'Le graphe doit être actualisé.');
});

test('toToolResult retombe sur stdout si stderr est vide (log.error écrit sur stdout)', () => {
  const result = toToolResult({ code: 1, stdout: '  ✗ Lancez la commande depuis un dossier enregistré.  ', stderr: '' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, '✗ Lancez la commande depuis un dossier enregistré.');
});

test('toToolResult garde un message par défaut si tout est vide', () => {
  const result = toToolResult({ code: 2, stdout: '', stderr: '' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /code de sortie 2/);
});

test('runPiecemakerCommand transmet les arguments et le dossier à execFn', async () => {
  const calls = [];
  const result = await runPiecemakerCommand(['graph', 'status', '--json', '--case', '/d'], {
    cwd: '/d',
    execFn: async (args, cwd) => {
      calls.push({ args, cwd });
      return { code: 0, stdout: '{}', stderr: '' };
    },
  });
  assert.deepEqual(calls, [{ args: ['graph', 'status', '--json', '--case', '/d'], cwd: '/d' }]);
  assert.deepEqual(result, { code: 0, stdout: '{}', stderr: '' });
});

// --- Les cinq outils, appelés via un vrai client MCP en mémoire ------------
//
// `InMemoryTransport.createLinkedPair()` relie un Client et un McpServer dans
// le même processus, sans stdio ni sous-processus : on exerce le vrai
// protocole MCP (registerTool, schémas zod, callTool) sans jamais lancer le
// binaire piecemaker pour de vrai.

async function connectedClient(execFn) {
  const server = createServer({ execFn });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

test('les cinq outils sont enregistrés', async () => {
  const { client } = await connectedClient(async () => ({ code: 0, stdout: '{}', stderr: '' }));
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'chronologie', 'conversion', 'graphe_construire', 'graphe_etat', 'graphe_question',
  ].sort());
  const conversionTool = tools.find((tool) => tool.name === 'conversion');
  assert.match(conversionTool.description, /convertit/i);
  assert.match(conversionTool.description, /gliner|données personnelles/i);
  assert.match(conversionTool.description, /longue/i);
  assert.match(conversionTool.description, /un seul scan/i);
});

test('graphe_question appelle le bon sous-processus et renvoie le texte tel quel', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: 'Le délai court à compter de la notification.', stderr: '' };
  });

  const result = await client.callTool({
    name: 'graphe_question',
    arguments: { question: 'Quand court le délai ?', dossier: '/mon/dossier' },
  });

  assert.deepEqual(calls, [{
    args: ['graph', 'query', 'Quand court le délai ?', '--case', '/mon/dossier'],
    cwd: '/mon/dossier',
  }]);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, 'Le délai court à compter de la notification.');
});

test('graphe_question sans dossier utilise le répertoire courant du serveur', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: 'ok', stderr: '' };
  });

  await client.callTool({ name: 'graphe_question', arguments: { question: 'q' } });

  assert.equal(calls[0].cwd, process.cwd());
  assert.deepEqual(calls[0].args, ['graph', 'query', 'q', '--case', process.cwd()]);
});

test('graphe_question remonte l’erreur d’actualisation du graphe (isError)', async () => {
  const { client } = await connectedClient(async () => ({
    code: 1,
    stdout: '',
    stderr: 'Le graphe sémantique juridique doit être actualisé avant cette requête.',
  }));

  const result = await client.callTool({
    name: 'graphe_question',
    arguments: { question: 'q', dossier: '/d' },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /doit être actualisé/);
});

test('graphe_construire transmet --force et renvoie le JSON du CLI', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: '{"graphFile":"graphe.json"}', stderr: '' };
  });

  const result = await client.callTool({
    name: 'graphe_construire',
    arguments: { dossier: '/d', force: true },
  });

  assert.deepEqual(calls[0].args, ['graph', 'build', '--json', '--case', '/d', '--force']);
  assert.equal(result.content[0].text, '{"graphFile":"graphe.json"}');
});

test('graphe_etat interroge le statut sans construire', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: '{"exists":true,"stale":false}', stderr: '' };
  });

  await client.callTool({ name: 'graphe_etat', arguments: { dossier: '/d' } });

  assert.deepEqual(calls[0].args, ['graph', 'status', '--json', '--case', '/d']);
});

test('conversion transmet les pièces indiquées et --force', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: '{"result":{"scanned":1}}', stderr: '' };
  });

  const result = await client.callTool({
    name: 'conversion',
    arguments: { dossier: '/d', pieces: ['pièce.pdf'], force: true },
  });

  assert.deepEqual(calls[0].args, ['conversion', '--json', '--case', '/d', 'pièce.pdf', '--force']);
  assert.equal(result.content[0].text, '{"result":{"scanned":1}}');
});

test('conversion refusée (scan déjà en cours) remonte une erreur exploitable', async () => {
  const { client } = await connectedClient(async () => ({
    code: 1,
    stdout: '',
    stderr: 'Une conversion est déjà en cours pour ce dossier.',
  }));

  const result = await client.callTool({ name: 'conversion', arguments: { dossier: '/d' } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /déjà en cours/);
});

test('chronologie interroge le dossier demandé en JSON', async () => {
  const calls = [];
  const { client } = await connectedClient(async (args, cwd) => {
    calls.push({ args, cwd });
    return { code: 0, stdout: '[]', stderr: '' };
  });

  await client.callTool({ name: 'chronologie', arguments: { dossier: '/d' } });

  assert.deepEqual(calls[0].args, ['chronology', '--json', '--case', '/d']);
});

// --- Bout en bout avec le vrai binaire, uniquement sur les commandes qui
// court-circuitent le bandeau/la mise à jour (installer/bin/piecemaker.mjs
// autour des lignes 1006-1009) : aucun service PieceMaker n'est touché.

test('bout en bout : graphe_question sur un dossier non enregistré échoue proprement', async (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-mcp-e2e-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));

  const { client } = await connectedClient(undefined); // exécution réelle du CLI
  const result = await client.callTool({
    name: 'graphe_question',
    arguments: { question: 'test', dossier },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /dossier juridique enregistré/);
});

test('bout en bout : chronologie sur un dossier non enregistré échoue proprement', async (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-mcp-e2e-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));

  const { client } = await connectedClient(undefined);
  const result = await client.callTool({ name: 'chronologie', arguments: { dossier } });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /dossier juridique enregistré/);
});

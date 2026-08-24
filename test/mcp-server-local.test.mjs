import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(root, 'mcp-server', 'mcp-server-local.js');
const taskpaneScript = path.join(root, 'taskpane', 'taskpane.js');
const manifestPath = path.join(root, 'taskpane', 'manifest.xml');
const wordServerScript = path.join(root, 'websocket-server', 'server.cjs');

function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function readMessage(stdout, timeoutMs = 15000) {
  let buffer = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stdout.off('data', onData);
      reject(new Error(`MCP response timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;

      clearTimeout(timeout);
      stdout.off('data', onData);
      resolve(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
    };

    stdout.on('data', onData);
  });
}

async function initializeMcp(child) {
  child.stdin.write(encodeMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'piece-maker-routing-test', version: '1.0.0' },
    },
  }));
  return readMessage(child.stdout);
}

async function callTool(child, id, name, args = {}) {
  child.stdin.write(encodeMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }));
  return readMessage(child.stdout);
}

test('le chat du volet limite aussi les outils locaux actifs', () => {
  const source = readFileSync(taskpaneScript, 'utf8');

  assert.match(source, /ENABLED_LOCAL_TOOL_NAMES = new Set\(\['read_doc', 'edit_doc'\]\)/);
  assert.match(source, /const tools = \[\.\.\.ACTIVE_LOCAL_TOOL_SCHEMAS\.values\(\)\]/);
  assert.match(source, /const disabledLocalToolSchemas = \[/);
  assert.match(source, /Outil désactivé pour le modèle/);
  assert.match(source, /'X-PieceMaker-Pane': paneId/);
  assert.match(source, /message\.type === 'pane-bound'/);
  assert.match(source, /type: 'pane-hello', docUrl, paneId/);
});

test('les instructions Word décrivent le lancement minimal sans ancienne commande', () => {
  const skill = readFileSync(path.join(root, 'piecemaker-plugin', 'skills', 'word-taskpane', 'SKILL.md'), 'utf8');
  assert.equal(skill.includes(['piecemaker', 'codex'].join(' ')), false);
  assert.match(skill, /Lancer `codex` ou `claude`/);
  assert.match(skill, /open_doc` démarre PieceMaker/);
  assert.match(skill, /transmettre à chaque appel `read_doc` et `edit_doc`/);
});

test('un seul manifeste déclare le volet auto-ouvert', () => {
  const manifest = readFileSync(manifestPath, 'utf8');
  const wordServer = readFileSync(wordServerScript, 'utf8');
  const mcpServer = readFileSync(serverScript, 'utf8');

  assert.equal(existsSync(path.join(root, 'taskpane', 'manifest-B.xml')), false);
  assert.match(manifest, /<TaskpaneId>Office\.AutoShowTaskpaneWithDocument<\/TaskpaneId>/);
  assert.doesNotMatch(wordServer, /ADDIN_SLOTS|docSlotAssignments|manifest-B/);
  assert.match(wordServer, /req\.get\('X-PieceMaker-Document'\)/);
  assert.match(wordServer, /req\.get\('X-PieceMaker-Pane'\)/);
  assert.match(wordServer, /wordPaneRegistry\.getById\(paneId\)/);
  assert.doesNotMatch(wordServer, /activeWordDocPath/);
  assert.match(mcpServer, /'X-PieceMaker-Pane': paneId/);
  assert.doesNotMatch(mcpServer, /boundPaneId|boundDocumentPath/);
});

test('un processus MCP route chaque lecture et écriture par le paneId fourni par le modèle', async () => {
  const paneA = 'a1b2';
  const paneB = 'c3d4';
  const received = [];
  const proxy = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const paneId = req.headers['x-piecemaker-pane'] || null;
      received.push({ url: req.url, payload, paneId });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/word/open-doc') {
        const openedPaneId = payload.path.includes('Dossier A') ? paneA : paneB;
        res.end(JSON.stringify({ paneId: openedPaneId }));
      } else {
        res.end(JSON.stringify({ paneId, payload }));
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = proxy.address();

  const session = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      PIECEMAKER_SERVER_URL: `http://127.0.0.1:${port}`,
      OUTPUT_PATH: '/tmp/obsolete-piece-maker-output',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const docA = '/tmp/Dossier A/assignation.docx';
  const docB = '/tmp/Dossier B/conclusions accentuées.docx';

  try {
    await initializeMcp(session);
    const openedA = await callTool(session, 2, 'open_doc', { path: docA });
    const openedB = await callTool(session, 3, 'open_doc', { path: docB });
    const publicA = JSON.parse(openedA.result.content[0].text);
    const publicB = JSON.parse(openedB.result.content[0].text);
    assert.deepEqual(publicA, { paneId: paneA });
    assert.deepEqual(publicB, { paneId: paneB });
    const readA = await callTool(session, 4, 'read_doc', { paneId: paneA, list_headings: true });
    const readB = await callTool(session, 5, 'read_doc', { paneId: paneB, list_headings: true });
    const editA = await callTool(session, 6, 'edit_doc', {
      paneId: paneA,
      operation: 'delete',
      indexes_to_delete: [0],
    });

    assert.deepEqual(JSON.parse(readA.result.content[0].text), {
      paneId: paneA,
      payload: { list_headings: true, include_track_changes: false },
    });
    assert.deepEqual(JSON.parse(readB.result.content[0].text), {
      paneId: paneB,
      payload: { list_headings: true, include_track_changes: false },
    });
    assert.deepEqual(JSON.parse(editA.result.content[0].text), { success: true });
    assert.deepEqual(
      received.filter(({ url }) => url === '/api/word/read-doc')
        .map(({ paneId, payload }) => ({ paneId, payload })),
      [
        { paneId: paneA, payload: { list_headings: true, include_track_changes: false } },
        { paneId: paneB, payload: { list_headings: true, include_track_changes: false } },
      ],
    );
    assert.deepEqual(
      received.filter(({ url }) => url === '/api/word/edit-doc')
        .map(({ paneId, payload }) => ({ paneId, payload })),
      [{
        paneId: paneA,
        payload: { operation: 'delete', indexes_to_delete: [0], track_changes: true },
      }],
    );
  } finally {
    session.kill('SIGTERM');
    await once(session, 'exit').catch(() => {});
    proxy.close();
    await once(proxy, 'close');
  }
});

test('edit_doc réduit aussi un échec à success false et son message', async () => {
  const proxy = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: 'Index Word introuvable.' }));
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = proxy.address();

  const session = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      PIECEMAKER_SERVER_URL: `http://127.0.0.1:${port}`,
      OUTPUT_PATH: '/tmp/obsolete-piece-maker-output',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await initializeMcp(session);
    const result = await callTool(session, 2, 'edit_doc', {
      paneId: 'a1b2',
      operation: 'delete',
      indexes_to_delete: [999],
    });

    assert.equal(result.result?.isError, true);
    assert.deepEqual(JSON.parse(result.result.content[0].text), {
      success: false,
      message: 'Index Word introuvable.',
    });
  } finally {
    session.kill('SIGTERM');
    await once(session, 'exit').catch(() => {});
    proxy.close();
    await once(proxy, 'close');
  }
});

test('read_doc sans paneId échoue localement sans requête serveur', async () => {
  let readRequests = 0;
  const proxy = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url === '/api/word/open-doc') {
        res.statusCode = 504;
        res.end(JSON.stringify({ error: 'Exécutez `piecemaker restart`, puis rappelez `open_doc`.' }));
      } else {
        readRequests += 1;
        res.end(JSON.stringify({ unexpected: true }));
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = proxy.address();
  const child = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      PIECEMAKER_SERVER_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await initializeMcp(child);
    const opened = await callTool(child, 2, 'open_doc', { path: '/tmp/sans-volet.docx' });
    assert.equal(opened.result?.isError, true);
    assert.match(opened.result?.content?.[0]?.text || '', /piecemaker restart/);
    assert.doesNotMatch(opened.result?.content?.[0]?.text || '', /Vérifiez que le complément Word/);
    const read = await callTool(child, 3, 'read_doc', { indexes: [0] });

    assert.equal(read.result?.isError, true);
    assert.match(read.result?.content?.[0]?.text || '', /paneId/);
    assert.equal(readRequests, 0);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
    proxy.close();
    await once(proxy, 'close');
  }
});

test('le serveur MCP local n’expose que open_doc, read_doc et edit_doc', async () => {
  const child = spawn(process.execPath, [serverScript], {
    cwd: root,
    env: { ...process.env, OUTPUT_PATH: '/tmp/obsolete-piece-maker-output' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'piece-maker-test', version: '1.0.0' },
      },
    }));
    const initialized = await readMessage(child.stdout);

    assert.equal(initialized.id, 1);
    assert.ok(initialized.result?.capabilities?.tools);
    assert.equal('prompts' in initialized.result.capabilities, false);

    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }));
    const toolsResponse = await readMessage(child.stdout);

    assert.equal(toolsResponse.id, 2);
    assert.deepEqual(
      toolsResponse.result?.tools?.map((tool) => tool.name),
      ['open_doc', 'read_doc', 'edit_doc'],
    );

    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_case', arguments: {} },
    }));
    const disabledToolResponse = await readMessage(child.stdout);

    assert.equal(disabledToolResponse.id, 3);
    assert.equal(disabledToolResponse.result?.isError, true);
    assert.match(disabledToolResponse.result?.content?.[0]?.text || '', /outil désactivé/i);

    child.stdin.write(encodeMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'prompts/list',
      params: {},
    }));
    const promptsResponse = await readMessage(child.stdout);

    assert.equal(promptsResponse.id, 4);
    assert.equal(promptsResponse.error?.code, -32601);
    assert.match(promptsResponse.error?.message || '', /method not found/i);
    assert.doesNotMatch(stderr, /mcp-prompts\.json|Prompts: Enabled|addon\/output/);
    assert.doesNotMatch(stderr, /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.doesNotMatch(stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

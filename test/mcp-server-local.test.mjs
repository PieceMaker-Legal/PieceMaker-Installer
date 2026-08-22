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
  assert.match(source, /filter\(\(tool\) => ENABLED_LOCAL_TOOL_NAMES\.has\(tool\.name\)\)/);
  assert.match(source, /Outil désactivé pour le modèle/);
  assert.match(source, /'X-PieceMaker-Pane': paneId/);
  assert.match(source, /message\.type === 'pane-bound'/);
  assert.match(source, /type: 'pane-hello', docUrl, paneId/);
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
  assert.match(mcpServer, /'X-PieceMaker-Pane': boundPaneId/);
});

test('deux processus MCP restent liés chacun à leur propre document', async () => {
  const paneA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const paneB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const received = [];
  const proxy = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const routed = req.headers['x-piecemaker-document']
        ? decodeURIComponent(req.headers['x-piecemaker-document'])
        : null;
      const paneId = req.headers['x-piecemaker-pane'] || null;
      received.push({ url: req.url, payload, routed, paneId });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/word/open-doc') {
        const openedPaneId = payload.path.includes('Dossier A') ? paneA : paneB;
        res.end(JSON.stringify({
          ok: true,
          path: payload.path,
          paneId: openedPaneId,
          paneReady: true,
          message: 'prêt',
        }));
      } else {
        res.end(JSON.stringify({ routed, paneId }));
      }
    });
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = proxy.address();

  const spawnMcp = () => spawn(process.execPath, [serverScript], {
    cwd: root,
    env: {
      ...process.env,
      PIECEMAKER_SERVER_URL: `http://127.0.0.1:${port}`,
      OUTPUT_PATH: '/tmp/obsolete-piece-maker-output',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sessionA = spawnMcp();
  const sessionB = spawnMcp();
  const docA = '/tmp/Dossier A/assignation.docx';
  const docB = '/tmp/Dossier B/conclusions accentuées.docx';

  try {
    await Promise.all([initializeMcp(sessionA), initializeMcp(sessionB)]);
    const [openedA, openedB] = await Promise.all([
      callTool(sessionA, 2, 'open_doc', { path: docA }),
      callTool(sessionB, 2, 'open_doc', { path: docB }),
    ]);
    assert.equal('paneId' in JSON.parse(openedA.result.content[0].text), false);
    assert.equal('paneId' in JSON.parse(openedB.result.content[0].text), false);
    const [readA, readB] = await Promise.all([
      callTool(sessionA, 3, 'read_doc', { list_headings: true }),
      callTool(sessionB, 3, 'read_doc', { list_headings: true }),
    ]);

    assert.deepEqual(JSON.parse(readA.result.content[0].text), { routed: docA, paneId: paneA });
    assert.deepEqual(JSON.parse(readB.result.content[0].text), { routed: docB, paneId: paneB });
    assert.deepEqual(
      received.filter(({ url }) => url === '/api/word/read-doc')
        .map(({ routed, paneId }) => ({ routed, paneId }))
        .sort((a, b) => a.routed.localeCompare(b.routed)),
      [
        { routed: docA, paneId: paneA },
        { routed: docB, paneId: paneB },
      ],
    );
  } finally {
    sessionA.kill('SIGTERM');
    sessionB.kill('SIGTERM');
    await Promise.all([
      once(sessionA, 'exit').catch(() => {}),
      once(sessionB, 'exit').catch(() => {}),
    ]);
    proxy.close();
    await once(proxy, 'close');
  }
});

test('open_doc sans volet prêt ne lie pas la session et read_doc échoue localement', async () => {
  let readRequests = 0;
  const proxy = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/word/open-doc') {
        const payload = JSON.parse(body);
        res.end(JSON.stringify({
          ok: true,
          path: payload.path,
          paneReady: false,
          paneId: null,
          message: 'volet absent',
        }));
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
    await callTool(child, 2, 'open_doc', { path: '/tmp/sans-volet.docx' });
    const read = await callTool(child, 3, 'read_doc', { indexes: [0] });

    assert.equal(read.result?.isError, true);
    assert.match(read.result?.content?.[0]?.text || '', /Aucun document lié/);
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
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

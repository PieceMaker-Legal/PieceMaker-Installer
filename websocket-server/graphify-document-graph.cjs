/**
 * Graphe documentaire Graphify, construit uniquement depuis l'index GLiNER.
 *
 * Graphify ne reçoit jamais le Markdown juridique ni les noms de fichiers : on
 * lui prépare un corpus temporaire avec un fichier nommé par le hash de chaque
 * pièce et, comme seul contenu, les codes d'entités déjà attribués par GLiNER.
 * `--code-only` et `--no-cluster` court-circuitent toute étape LLM. Le graphe
 * persistant reste donc pseudonymisé ; les libellés sont rejoints en mémoire au
 * moment de répondre à l'administration. Une seconde passe temporaire appelle
 * le renderer officiel Graphify (`cluster-only --no-label`) : son HTML interactif
 * est renvoyé en mémoire, sans jamais persister les noms du dossier.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');

const GRAPHIFY_CACHE_RELATIVE = '.piecemaker/graphify';
const GRAPHIFY_TIMEOUT_MS = 120_000;
const GRAPHIFY_VIEWER_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PROCESS_OUTPUT = 16 * 1024;
const generations = new Map();

const LLM_ENV_KEYS = [
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'OLLAMA_BASE_URL', 'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GRAPHIFY_BACKEND',
  'GRAPHIFY_MODEL', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
];

let _cachedGraphifyPath;
let _cachedGraphifyPathAt = 0;
const CONFIG_CACHE_TTL_MS = 30_000;

function configuredGraphifyPath() {
  const now = Date.now();
  if (_cachedGraphifyPath !== undefined && now - _cachedGraphifyPathAt < CONFIG_CACHE_TTL_MS) {
    return _cachedGraphifyPath;
  }
  try {
    const configFile = path.join(os.homedir(), '.piecemaker', 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    _cachedGraphifyPath = typeof config.graphifyPath === 'string' ? config.graphifyPath : null;
  } catch {
    _cachedGraphifyPath = null;
  }
  _cachedGraphifyPathAt = now;
  return _cachedGraphifyPath;
}

function graphifyCommand() {
  if (process.env.GRAPHIFY_PATH) return process.env.GRAPHIFY_PATH;

  const binName = process.platform === 'win32' ? 'graphify.exe' : 'graphify';

  // Binaire géré par l'étape d'installation 03b-python-graphify (venv dédié).
  const configured = configuredGraphifyPath();
  if (configured && fs.existsSync(configured)) return configured;
  const venvBinDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const managed = path.join(os.homedir(), '.piecemaker', 'graphify-venv', venvBinDir, binName);
  if (fs.existsSync(managed)) return managed;

  const local = path.join(os.homedir(), '.local', 'bin', binName);
  return fs.existsSync(local) ? local : 'graphify';
}

function graphifyEnvironment() {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const key of LLM_ENV_KEYS) delete env[key];
  return env;
}

function topologyFromChronology(chronology) {
  const documents = [];
  const codes = new Set();
  for (const doc of chronology.documents || []) {
    const docCodes = [...new Set((doc.codes || []).map((entry) => String(entry.code || '')).filter(Boolean))].sort();
    if (!docCodes.length) continue;
    const key = stateKey(doc.path || doc.id);
    documents.push({ key, codes: docCodes, doc });
    for (const code of docCodes) codes.add(code);
  }
  return { documents, codes: [...codes].sort() };
}

function topologySignature(topology) {
  const payload = topology.documents
    .map(({ key, codes }) => ({ key, codes }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function cachePaths(caseRoot) {
  const directory = path.join(caseRoot, ...GRAPHIFY_CACHE_RELATIVE.split('/'));
  return {
    directory,
    graph: path.join(directory, 'graph.json'),
    manifest: path.join(directory, 'manifest.json'),
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function validateNoLlm(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error('Sortie Graphify invalide.');
  }
  // Ne pas seulement faire confiance aux options de ligne de commande : la
  // sortie doit elle-même attester qu'aucun token n'a été envoyé à un modèle.
  if (raw.input_tokens !== 0 || raw.output_tokens !== 0) {
    throw new Error('Graphify a utilisé une étape LLM interdite pour ce graphe.');
  }
}

function readCachedGraph(caseRoot, signature) {
  const files = cachePaths(caseRoot);
  const manifest = readJson(files.manifest);
  if (!manifest || manifest.signature !== signature || manifest.llm !== false) return null;
  const raw = readJson(files.graph);
  try {
    validateNoLlm(raw);
  } catch {
    return null;
  }
  return { raw, generatedAt: manifest.generatedAt, cacheHit: true };
}

function appendBounded(chunks, chunk) {
  chunks.push(Buffer.from(chunk));
  let size = chunks.reduce((total, value) => total + value.length, 0);
  while (size > MAX_PROCESS_OUTPUT && chunks.length > 1) size -= chunks.shift().length;
}

function runGraphifyProcess(command, args, { cwd, env, timeoutMs = GRAPHIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new Error('Graphify a dépassé le délai autorisé.');
      error.code = 'GRAPHIFY_TIMEOUT';
      finish(reject, error);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => appendBounded(stdout, chunk));
    child.stderr.on('data', (chunk) => appendBounded(stderr, chunk));
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      if (code === 0) {
        finish(resolve, { stdout: Buffer.concat(stdout).toString('utf8') });
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf8').trim().split(/\r?\n/).slice(-2).join(' · ');
      const error = new Error(`Graphify a échoué (${signal || `code ${code}`})${detail ? ` : ${detail}` : ''}`);
      error.code = 'GRAPHIFY_FAILED';
      finish(reject, error);
    });
  });
}

function writeGraphifyInputs(temporary, topology) {
  const corpus = path.join(temporary, 'corpus');
  const output = path.join(temporary, 'output');
  const entityMap = path.join(temporary, 'entity-map.json');
  fs.mkdirSync(corpus, { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const document of topology.documents) {
    fs.writeFileSync(path.join(corpus, `${document.key}.md`), `${document.codes.join('\n')}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
  }
  fs.writeFileSync(entityMap, `${JSON.stringify({
    mapping: Object.fromEntries(topology.codes.map((code) => [code, code])),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { corpus, output, entityMap };
}

function persistRawGraph(caseRoot, signature, raw, sourceGraph) {
  const files = cachePaths(caseRoot);
  fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  const generatedAt = new Date().toISOString();
  const graphTemporary = `${files.graph}.${process.pid}.tmp`;
  const manifestTemporary = `${files.manifest}.${process.pid}.tmp`;
  // Conserver la sortie Graphify elle-même, pas une reconstruction PieceMaker.
  fs.copyFileSync(sourceGraph, graphTemporary);
  fs.chmodSync(graphTemporary, 0o600);
  fs.writeFileSync(manifestTemporary, `${JSON.stringify({
    version: 1,
    engine: 'graphify',
    source: 'gliner-document-index',
    llm: false,
    inputTokens: 0,
    outputTokens: 0,
    signature,
    generatedAt,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(graphTemporary, files.graph);
  fs.renameSync(manifestTemporary, files.manifest);
  return { raw, generatedAt, cacheHit: false };
}

async function generateRawGraph(caseRoot, topology, signature, { command, runner }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-'));
  try {
    const inputs = writeGraphifyInputs(temporary, topology);
    const args = [
      'extract', inputs.corpus,
      '--code-only',
      '--no-cluster',
      '--entity-map', inputs.entityMap,
      '--entity-map-labels', 'canonical',
      '--out', inputs.output,
    ];
    await runner(command, args, { cwd: temporary, env: graphifyEnvironment() });
    const sourceGraph = path.join(inputs.output, 'graphify-out', 'graph.json');
    const raw = readJson(sourceGraph);
    validateNoLlm(raw);
    return persistRawGraph(caseRoot, signature, raw, sourceGraph);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function normalizedGraph(rawResult, topology, chronology) {
  const { raw, generatedAt, cacheHit } = rawResult;
  validateNoLlm(raw);
  const documentByKey = new Map(topology.documents.map((entry) => [entry.key, entry.doc]));
  const entityDetails = new Map((chronology.entities || []).map((entity) => [entity.code, entity]));
  const knownCodes = new Set(topology.codes);
  const graphifyDocuments = new Map();
  const graphifyEntities = new Map();

  for (const node of raw.nodes) {
    const nodeId = String(node.id || '');
    if (!nodeId) continue;
    if (node.file_type === 'document') {
      const source = path.basename(String(node.source_file || ''));
      const match = /^([a-f0-9]{64})\.md$/i.exec(source);
      if (match && documentByKey.has(match[1].toLowerCase())) {
        graphifyDocuments.set(nodeId, match[1].toLowerCase());
      }
    } else if (node.file_type === 'concept') {
      const code = String(node.label || '');
      if (knownCodes.has(code)) graphifyEntities.set(nodeId, code);
    }
  }

  const observed = new Set();
  for (const edge of raw.edges) {
    const sourceId = String(edge.source || '');
    const targetId = String(edge.target || '');
    let documentKey = graphifyDocuments.get(sourceId);
    let code = graphifyEntities.get(targetId);
    if (!documentKey || !code) {
      documentKey = graphifyDocuments.get(targetId);
      code = graphifyEntities.get(sourceId);
    }
    if (documentKey && code) observed.add(`${documentKey}:${code}`);
  }

  const expected = new Set();
  for (const document of topology.documents) {
    for (const code of document.codes) expected.add(`${document.key}:${code}`);
  }
  if (observed.size !== expected.size || [...expected].some((edge) => !observed.has(edge))) {
    throw new Error('La topologie Graphify ne correspond pas aux résultats GLiNER.');
  }

  const nodes = [];
  const edges = [];
  const degreeByCode = new Map(topology.codes.map((code) => [code, 0]));
  for (const document of topology.documents) {
    const doc = document.doc;
    nodes.push({
      id: `doc:${doc.id}`,
      kind: 'document',
      label: doc.name,
      nature: doc.nature,
      dateIso: doc.dateIso,
      protected: doc.protected,
    });
    for (const code of document.codes) {
      degreeByCode.set(code, (degreeByCode.get(code) || 0) + 1);
      edges.push({
        source: `doc:${doc.id}`,
        target: `ent:${code}`,
        kind: 'references',
        confidence: 'EXTRACTED',
        extractionMethod: 'entity_mapping',
      });
    }
  }
  const rankedCodes = [...topology.codes].sort((a, b) =>
    (degreeByCode.get(b) || 0) - (degreeByCode.get(a) || 0) || a.localeCompare(b));
  for (const code of rankedCodes) {
    const entity = entityDetails.get(code) || {};
    nodes.push({
      id: `ent:${code}`,
      kind: 'entity',
      category: entity.category || 'autre',
      label: entity.label || code,
      code,
      degree: degreeByCode.get(code) || 0,
    });
  }

  return {
    engine: 'graphify',
    source: 'gliner-document-index',
    llm: false,
    status: edges.length ? 'ready' : 'empty',
    inputTokens: 0,
    outputTokens: 0,
    generatedAt,
    cacheHit,
    nodes,
    edges,
  };
}

function viewerGraphDocument(graph) {
  return {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      file_type: node.kind === 'document' ? 'document' : node.category || 'entity',
      source_file: node.kind === 'document' ? node.label : '',
    })),
    edges: graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.kind || 'references',
      confidence: edge.confidence || 'EXTRACTED',
    })),
  };
}

function localizeGraphifyViewer(html) {
  const remoteScript = /<script\s+src="https:\/\/unpkg\.com\/vis-network@9\.1\.6\/standalone\/umd\/vis-network\.min\.js"[\s\S]*?<\/script>/;
  if (!remoteScript.test(html) || !html.includes('new vis.Network')) {
    throw new Error('Le visualiseur produit par Graphify est invalide ou incompatible.');
  }
  return html.replace(remoteScript, '<script src="/admin/vendor/vis-network.min.js"></script>');
}

async function renderGraphifyViewer(graph, { command, runner }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-viewer-'));
  try {
    const output = path.join(temporary, 'graphify-out');
    const graphFile = path.join(output, 'graph.json');
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    // Cette copie contient les libellés autorisés pour la vue cabinet. Elle est
    // détruite avec le HTML dès que Graphify a terminé son rendu.
    fs.writeFileSync(graphFile, `${JSON.stringify(viewerGraphDocument(graph), null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600,
    });
    await runner(command, [
      'cluster-only', temporary,
      '--graph', graphFile,
      '--no-label',
    ], { cwd: temporary, env: graphifyEnvironment() });
    const viewerFile = path.join(output, 'graph.html');
    const size = fs.statSync(viewerFile).size;
    if (!size || size > GRAPHIFY_VIEWER_MAX_BYTES) {
      throw new Error('Le visualiseur Graphify dépasse la taille autorisée.');
    }
    return localizeGraphifyViewer(fs.readFileSync(viewerFile, 'utf8'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function buildGraphifyDocumentGraph(caseRoot, chronology, options = {}) {
  const topology = topologyFromChronology(chronology);
  if (!topology.codes.length) {
    return {
      engine: 'graphify', source: 'gliner-document-index', llm: false,
      status: 'empty', inputTokens: 0, outputTokens: 0, nodes: [], edges: [],
    };
  }
  const signature = topologySignature(topology);
  let rawResult = readCachedGraph(caseRoot, signature);
  if (!rawResult) {
    const key = `${path.resolve(caseRoot)}:${signature}`;
    let pending = generations.get(key);
    if (!pending) {
      pending = generateRawGraph(caseRoot, topology, signature, {
        command: options.command || graphifyCommand(),
        runner: options.runner || runGraphifyProcess,
      }).finally(() => generations.delete(key));
      generations.set(key, pending);
    }
    rawResult = await pending;
  }
  const command = options.command || graphifyCommand();
  const runner = options.runner || runGraphifyProcess;
  const graph = normalizedGraph(rawResult, topology, chronology);
  graph.viewerHtml = await renderGraphifyViewer(graph, { command, runner });
  return graph;
}

function graphifyErrorGraph(error) {
  const unavailable = error?.code === 'ENOENT';
  return {
    engine: 'graphify',
    source: 'gliner-document-index',
    llm: false,
    status: 'error',
    inputTokens: 0,
    outputTokens: 0,
    nodes: [],
    edges: [],
    error: unavailable
      ? 'Graphify n’est pas installé ou n’est pas accessible par PieceMaker.'
      : 'Le graphe Graphify n’a pas pu être généré. La frise reste disponible.',
  };
}

module.exports = {
  GRAPHIFY_CACHE_RELATIVE,
  buildGraphifyDocumentGraph,
  graphifyCommand,
  graphifyEnvironment,
  graphifyErrorGraph,
  localizeGraphifyViewer,
  renderGraphifyViewer,
  runGraphifyProcess,
  topologyFromChronology,
  viewerGraphDocument,
};

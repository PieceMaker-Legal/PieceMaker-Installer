/**
 * Frontière de matérialisation du graphe juridique PieceMaker.
 *
 * Graphify reste propriétaire de l'extraction sémantique. Ce module conserve
 * son fragment pseudonymisé séparément, puis délègue sa normalisation métier
 * au finalizer PieceMaker avant d'écrire le graphe composite au chemin que les
 * commandes `query` et `cluster-only` connaissent déjà.
 */
const fs = require('node:fs');
const path = require('node:path');

const LEGAL_SEMANTIC_SNAPSHOT_VERSION = 1;
const LEGAL_GRAPH_MANIFEST_VERSION = 3;

const PRIVATE_PATH_KEYS = new Set([
  'path', 'filepath', 'file_path', 'filename', 'file_name',
  'original_path', 'original_file', 'original_filename',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function normalizeSourceFile(value) {
  const source = String(value || '').replaceAll('\\', '/');
  return source ? path.posix.basename(source) : '';
}

function isFilesystemPath(value) {
  const text = String(value || '');
  return /^\/(?:Users|home|private|tmp|var)\//.test(text)
    || /^[A-Za-z]:[\\/]/.test(text);
}

/**
 * Élimine les chemins locaux accidentels sans réduire le schéma sémantique de
 * Graphify à une allowlist PieceMaker. Les attributs juridiques nouveaux
 * restent ainsi conservés lors des mises à jour du moteur.
 */
function sanitizeValue(value, key = '') {
  if (PRIVATE_PATH_KEYS.has(key)) return undefined;
  if (typeof value === 'string') return isFilesystemPath(value) ? null : value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry));
  if (!value || typeof value !== 'object') return value;
  const sanitized = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const next = sanitizeValue(childValue, childKey);
    if (next !== undefined) sanitized[childKey] = next;
  }
  return sanitized;
}

function sanitizeGraphRecord(record, allowedSourceFiles) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const sanitized = sanitizeValue(record);
  const sourceFile = normalizeSourceFile(record.source_file);
  if (sourceFile && allowedSourceFiles.size && !allowedSourceFiles.has(sourceFile)) return null;
  sanitized.source_file = sourceFile;
  return sanitized;
}

function assertPseudonymized(value, forbiddenClearTexts) {
  const serialized = JSON.stringify(value);
  for (const clearText of forbiddenClearTexts) {
    const candidate = String(clearText || '');
    if (candidate.length >= 3 && serialized.includes(candidate)) {
      throw new Error('Le snapshot sémantique contient une entité non pseudonymisée ; écriture refusée.');
    }
  }
}

/**
 * Ramène les variantes Graphify (`links`) vers le contrat stable (`edges`) et
 * retire uniquement les chemins privés. Retourne `null` pour une sortie qui
 * n'est pas un graphe ; le matérialiseur peut alors produire la couche
 * déterministe seule sans inventer de contenu sémantique.
 */
function normalizeGraphifySemanticSnapshot(raw, {
  allowedSourceFiles = [],
  forbiddenClearTexts = [],
} = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
  const allowed = new Set([...allowedSourceFiles].map(normalizeSourceFile).filter(Boolean));
  const nodes = raw.nodes
    .map((node) => sanitizeGraphRecord(node, allowed))
    .filter(Boolean);
  const edges = (Array.isArray(raw.edges) ? raw.edges : (Array.isArray(raw.links) ? raw.links : []))
    .map((edge) => sanitizeGraphRecord(edge, allowed))
    .filter(Boolean);
  const hyperedges = (Array.isArray(raw.hyperedges) ? raw.hyperedges : [])
    .map((entry) => sanitizeGraphRecord(entry, allowed))
    .filter(Boolean);
  const snapshot = {
    directed: Boolean(raw.directed),
    multigraph: Boolean(raw.multigraph),
    graph: sanitizeValue(raw.graph && typeof raw.graph === 'object' ? raw.graph : {}),
    nodes,
    edges,
    hyperedges,
    input_tokens: Number(raw.input_tokens || 0),
    output_tokens: Number(raw.output_tokens || 0),
  };
  assertPseudonymized(snapshot, forbiddenClearTexts);
  return snapshot;
}

function emptyGraphifySemanticSnapshot() {
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [],
    edges: [],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  };
}

/**
 * Point d'entrée unique de la fusion. `finalizeGraph` reste injecté afin de
 * préserver sans duplication le finalizer juridique déjà éprouvé ; le module
 * prend en charge le contrat Graphify, la confidentialité et l'absence licite
 * de couche sémantique.
 */
function materializeCompositeLegalGraph({
  semanticSnapshot,
  topology,
  mappingDocument,
  finalizeGraph,
  allowedSourceFiles = [],
  forbiddenClearTexts = [],
  requireSemanticSnapshot = false,
}) {
  if (typeof finalizeGraph !== 'function') {
    throw new TypeError('Le matérialiseur juridique requiert un finalizer PieceMaker.');
  }
  const normalized = normalizeGraphifySemanticSnapshot(semanticSnapshot, {
    allowedSourceFiles,
    forbiddenClearTexts,
  });
  if (requireSemanticSnapshot && !normalized) {
    throw new Error('Graphify a produit un graphe juridique invalide.');
  }
  const graph = finalizeGraph(
    normalized || emptyGraphifySemanticSnapshot(),
    topology,
    mappingDocument,
  );
  return {
    graph,
    semanticSnapshot: normalized,
    semanticAvailable: Boolean(normalized),
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

/**
 * Écrit le snapshot d'abord et le manifeste en dernier : celui-ci sert de
 * marqueur de cohérence. Le graphe final garde exactement son emplacement
 * historique pour Graphify `query` et `cluster-only`.
 */
function persistCompositeLegalGraph({
  files,
  signature,
  semanticSnapshotSignature = signature,
  graph,
  semanticSnapshot = null,
  manifest = {},
}) {
  for (const directory of [files.directory, files.output, files.semanticDirectory]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* ACL Windows */ }
  }
  const generatedAt = new Date().toISOString();
  if (semanticSnapshot) {
    atomicWriteJson(files.semanticGraph, {
      version: LEGAL_SEMANTIC_SNAPSHOT_VERSION,
      engine: 'graphify',
      confidentiality: 'pseudonymisee',
      signature: semanticSnapshotSignature,
      generatedAt,
      graph: semanticSnapshot,
    });
  }
  atomicWriteJson(files.graph, graph);
  atomicWriteJson(files.manifest, {
    ...manifest,
    version: LEGAL_GRAPH_MANIFEST_VERSION,
    engine: 'graphify',
    source: 'piecemaker-legal',
    llm: Boolean(semanticSnapshot),
    signature,
    generatedAt,
    semanticSnapshot: semanticSnapshot ? {
      version: LEGAL_SEMANTIC_SNAPSHOT_VERSION,
      file: path.relative(files.directory, files.semanticGraph).replaceAll('\\', '/'),
      signature: semanticSnapshotSignature,
    } : null,
    stats: graph.piecemaker,
  });
  return {
    graph,
    graphFile: files.graph,
    manifestFile: files.manifest,
    semanticSnapshotFile: semanticSnapshot ? files.semanticGraph : null,
    generatedAt,
    cacheHit: false,
  };
}

function readLegalSemanticSnapshot(file, { signature = null } = {}) {
  const stored = readJson(file);
  if (!stored || stored.version !== LEGAL_SEMANTIC_SNAPSHOT_VERSION
      || stored.confidentiality !== 'pseudonymisee'
      || !stored.graph || (signature && stored.signature !== signature)) return null;
  const graph = normalizeGraphifySemanticSnapshot(stored.graph);
  if (!graph) return null;
  return {
    version: stored.version,
    signature: stored.signature,
    generatedAt: stored.generatedAt,
    graph,
  };
}

module.exports = {
  LEGAL_GRAPH_MANIFEST_VERSION,
  LEGAL_SEMANTIC_SNAPSHOT_VERSION,
  emptyGraphifySemanticSnapshot,
  materializeCompositeLegalGraph,
  normalizeGraphifySemanticSnapshot,
  persistCompositeLegalGraph,
  readLegalSemanticSnapshot,
};

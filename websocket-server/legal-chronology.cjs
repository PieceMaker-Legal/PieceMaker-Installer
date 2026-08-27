/**
 * Projection chronologique du graphe juridique matérialisé.
 *
 * Le graphe détermine les pièces et leurs métadonnées effectives. Les
 * informations qui doivent rester locales (chemin, nom, aperçu, protection)
 * sont jointes par `document_key` depuis la chronologie documentaire. Ce
 * module ne lit ni n'écrit aucun fichier et n'appelle jamais Graphify.
 */
const path = require('node:path');

const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { revertMapping } = require('../piecemaker-plugin/scripts/lib/mapping.cjs');
const { isSocieteCode } = require('./legal-forms.cjs');

const DOCUMENT_KEY_PATTERN = /^[a-f0-9]{64}$/i;
const HUMAN_GRAPH_FIELDS = new Set([
  'label', 'title', 'name', 'description', 'summary', 'context', 'rationale',
  'evidence', 'quote', 'source_location', 'nature', 'juridiction', 'jurisdiction',
  'fields', 'custom_fields', 'metadata', 'quality_flags', 'qualityFlags',
  'review_reasons', 'reviewReasons',
]);

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

// Même vocabulaire que l'index, conservé ici pour que `document-index.cjs`
// puisse à terme appeler cette projection sans dépendance circulaire.
function categoryForCode(code) {
  const normalized = String(code).replace(/\s+/g, '_').toUpperCase();
  if (normalized.includes('PERSONNE_PHYSIQUE') || normalized.includes('DIRIGEANT')) return 'personne';
  if (normalized.includes('ADRESSE')) return 'adresse';
  if (normalized.includes('SIREN')) return 'siren';
  if (isSocieteCode(normalized)) return 'societe';
  return 'autre';
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
}

function firstOwned(value, keys) {
  for (const key of keys) {
    if (hasOwn(value, key)) return value[key];
  }
  return undefined;
}

function documentKeyFromSourceFile(value) {
  const basename = path.posix.basename(String(value || '').replaceAll('\\', '/'));
  const match = /^([a-f0-9]{64})\.md$/i.exec(basename);
  return match ? match[1].toLowerCase() : null;
}

function documentKeyFromNode(node) {
  const explicit = firstOwned(node, ['document_key', 'documentKey']);
  if (DOCUMENT_KEY_PATTERN.test(String(explicit || ''))) return String(explicit).toLowerCase();
  const idMatch = /^piece_([a-f0-9]{64})$/i.exec(String(node?.id || ''));
  if (idMatch) return idMatch[1].toLowerCase();
  const sourceKey = documentKeyFromSourceFile(node?.source_file);
  if (sourceKey) return sourceKey;
  const legacyMatch = /^doc:(.+)$/s.exec(String(node?.id || ''));
  if (legacyMatch) return stateKey(legacyMatch[1]);
  return null;
}

function documentKeyFromLocal(document) {
  const explicit = firstOwned(document, ['documentKey', 'document_key']);
  if (DOCUMENT_KEY_PATTERN.test(String(explicit || ''))) return String(explicit).toLowerCase();
  const identifier = firstOwned(document, ['path', 'id']);
  return identifier ? stateKey(String(identifier)) : null;
}

function isDocumentNode(node) {
  return node && (node.file_type === 'document'
    || node.legal_kind === 'document'
    || node.kind === 'document');
}

function effectiveMetadataValue(node, local, field, aliases = []) {
  const metadata = node?.metadata && typeof node.metadata === 'object' ? node.metadata : {};
  const localMetadata = local?.metadata && typeof local.metadata === 'object' ? local.metadata : {};
  for (const metadataField of [field, ...aliases]) {
    const graphEntry = metadata[metadataField];
    if (graphEntry && typeof graphEntry === 'object' && hasOwn(graphEntry, 'effective')) {
      return cloneValue(graphEntry.effective);
    }
  }
  const direct = firstOwned(node, [field, ...aliases]);
  if (direct !== undefined) return cloneValue(direct);
  for (const metadataField of [field, ...aliases]) {
    const localEntry = localMetadata[metadataField];
    if (localEntry && typeof localEntry === 'object' && hasOwn(localEntry, 'effective')) {
      return cloneValue(localEntry.effective);
    }
  }
  return cloneValue(firstOwned(local, [field, ...aliases]));
}

function metadataFrom(node, local) {
  const graphMetadata = node?.metadata && typeof node.metadata === 'object' ? node.metadata : null;
  const localMetadata = local?.metadata && typeof local.metadata === 'object' ? local.metadata : null;
  return cloneValue(graphMetadata || localMetadata || null);
}

function normalizeCodeEntries(entries, { deanonymize, reverseMapping }) {
  const normalized = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const code = typeof entry === 'string' ? entry : entry?.code;
    const cleanCode = String(code || '').trim();
    if (!cleanCode || seen.has(cleanCode)) continue;
    seen.add(cleanCode);
    const mapped = reverseMapping[cleanCode];
    const mappedLabel = Array.isArray(mapped) && mapped.length ? String(mapped[0]) : null;
    normalized.push({
      code: cleanCode,
      category: typeof entry === 'object' && entry?.category
        ? String(entry.category)
        : categoryForCode(cleanCode),
      label: deanonymize
        ? (mappedLabel || (typeof entry === 'object' ? entry?.label || null : null))
        : null,
    });
  }
  return normalized;
}

function codesMentionedByDocument(graph) {
  const nodesById = new Map((graph?.nodes || []).map((node) => [String(node?.id || ''), node]));
  const documentIds = new Set((graph?.nodes || []).filter(isDocumentNode).map((node) => String(node.id)));
  const codes = new Map();
  const note = (documentId, entityId) => {
    const entity = nodesById.get(entityId);
    const code = String(entity?.code || entity?.label || '').trim();
    if (!code) return;
    if (!codes.has(documentId)) codes.set(documentId, []);
    codes.get(documentId).push(code);
  };
  for (const edge of graph?.edges || []) {
    if (edge?.relation !== 'mentionne') continue;
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (documentIds.has(source)) note(source, target);
    else if (documentIds.has(target)) note(target, source);
  }
  return codes;
}

function effectiveCodesFrom(node, local, mentionedCodes) {
  const graphCodes = firstOwned(node, ['effectiveCodes', 'effective_codes', 'codes']);
  if (graphCodes !== undefined) return graphCodes;
  const localCodes = firstOwned(local, ['effectiveCodes', 'effective_codes', 'codes']);
  if (localCodes !== undefined) return localCodes;
  return mentionedCodes.get(String(node?.id || '')) || [];
}

function detectedCodesFrom(node, local) {
  const graphCodes = firstOwned(node, ['detectedCodes', 'detected_codes']);
  if (graphCodes !== undefined) return graphCodes;
  return firstOwned(local, ['detectedCodes', 'detected_codes']);
}

function humanValue(value, reverseMapping) {
  if (typeof value === 'string') return revertMapping(value, reverseMapping);
  if (Array.isArray(value)) return value.map((entry) => humanValue(entry, reverseMapping));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, humanValue(child, reverseMapping)]),
  );
}

function graphForCabinet(graph, reverseMapping, deanonymize) {
  const copy = cloneValue(graph || {});
  if (!deanonymize) return copy;
  for (const collection of ['nodes', 'edges', 'hyperedges']) {
    for (const record of copy[collection] || []) {
      for (const key of HUMAN_GRAPH_FIELDS) {
        if (hasOwn(record, key)) record[key] = humanValue(record[key], reverseMapping);
      }
    }
  }
  return copy;
}

function normalizedArguments(mappingDocumentOrOptions, explicitOptions) {
  const candidate = mappingDocumentOrOptions && typeof mappingDocumentOrOptions === 'object'
    ? mappingDocumentOrOptions
    : {};
  if (explicitOptions && Object.keys(explicitOptions).length) {
    return { mappingDocument: candidate, options: explicitOptions };
  }
  const looksLikeMapping = hasOwn(candidate, 'reverse_mapping')
    || hasOwn(candidate, 'informations_dossier')
    || (hasOwn(candidate, 'mapping') && !hasOwn(candidate, 'mappingDocument'));
  if (looksLikeMapping) {
    return { mappingDocument: candidate, options: explicitOptions || {} };
  }
  return {
    mappingDocument: candidate.mappingDocument || {},
    options: candidate,
  };
}

function resolveRevision(graph, documents, options) {
  const explicit = firstOwned(options, ['graphRevision', 'revision']);
  if (explicit !== undefined) return explicit;
  const suppliedStatus = firstOwned(options, ['graphStatus', 'status']);
  if (suppliedStatus && typeof suppliedStatus === 'object') {
    const statusRevision = firstOwned(suppliedStatus, [
      'graphRevision', 'graph_revision', 'staticRevision', 'static_revision',
      'appliedEditRevision', 'applied_edit_revision', 'revision',
    ]);
    if (statusRevision !== undefined) return statusRevision;
  }
  const metadataCandidates = [graph?.piecemaker, graph?.graph, graph];
  for (const metadata of metadataCandidates) {
    const candidate = firstOwned(metadata, [
      'graphRevision', 'graph_revision', 'staticRevision', 'static_revision',
      'appliedEditRevision', 'applied_edit_revision', 'revision',
    ]);
    if (candidate !== undefined) return candidate;
  }
  const revisions = documents
    .map((document) => Number(firstOwned(document, ['editRevision', 'edit_revision'])))
    .filter(Number.isFinite);
  return revisions.length ? Math.max(...revisions) : null;
}

function resolveGraphStatus(graph, options, documentCount) {
  const supplied = firstOwned(options, ['graphStatus', 'status']);
  if (supplied && typeof supplied === 'object') {
    const status = cloneValue(supplied);
    if (!hasOwn(status, 'staticState')) {
      status.staticState = status.exists === false ? 'missing' : 'current';
    }
    if (!hasOwn(status, 'semanticState')) {
      status.semanticState = status.stale ? 'stale' : (status.exists === false ? 'missing' : 'current');
    }
    if (!Array.isArray(status.semanticStaleReasons)) status.semanticStaleReasons = [];
    return status;
  }
  if (typeof supplied === 'string') {
    return {
      staticState: documentCount ? 'current' : 'missing',
      semanticState: supplied,
      semanticStaleReasons: [],
    };
  }
  const metadata = graph?.piecemaker || {};
  const semanticAvailable = Number(metadata.semanticLegalNodes) > 0
    || Number(graph?.input_tokens) > 0
    || Number(graph?.output_tokens) > 0;
  return {
    staticState: metadata.staticState || metadata.static_state || (documentCount ? 'current' : 'missing'),
    semanticState: metadata.semanticState || metadata.semantic_state
      || (semanticAvailable ? 'current' : 'missing'),
    semanticStaleReasons: cloneValue(
      metadata.semanticStaleReasons || metadata.semantic_stale_reasons || [],
    ),
  };
}

function legacyGraphStatus(graphStatus, nodeCount) {
  if (['stale', 'building', 'failed', 'blocked'].includes(graphStatus.semanticState)) {
    return graphStatus.semanticState;
  }
  if (graphStatus.staticState === 'missing') return 'empty';
  return nodeCount ? 'ready' : 'empty';
}

function mappingSummary(source, mappingDocument) {
  const sourceSummary = source?.mapping;
  if (sourceSummary && typeof sourceSummary === 'object'
      && Number.isFinite(sourceSummary.entries)) return cloneValue(sourceSummary);
  const mapping = mappingDocument?.mapping || {};
  return {
    exists: Boolean(mappingDocument?.exists || Object.keys(mapping).length),
    entries: Object.keys(mapping).length,
  };
}

function buildEntities(documents, { deanonymize, reverseMapping }) {
  const entities = new Map();
  for (const document of documents) {
    for (const entry of document.codes || []) {
      let entity = entities.get(entry.code);
      if (!entity) {
        entity = {
          code: entry.code,
          category: entry.category || categoryForCode(entry.code),
          label: deanonymize ? entry.label : null,
          documents: new Set(),
        };
        entities.set(entry.code, entity);
      }
      entity.documents.add(document.id);
    }
  }
  return [...entities.values()]
    .map((entity) => ({
      code: entity.code,
      category: entity.category,
      label: deanonymize
        ? (entity.label || normalizeCodeEntries([entity.code], { deanonymize, reverseMapping })[0]?.label || null)
        : null,
      documentCount: entity.documents.size,
      documents: [...entity.documents],
    }))
    .sort((a, b) => b.documentCount - a.documentCount || a.code.localeCompare(b.code));
}

/**
 * Produit le contrat historique de `buildChronology()` depuis le graphe
 * juridique composite. Deux formes d'appel sont acceptées :
 *
 *   chronologyFromLegalGraph(graph, chronology, { mappingDocument, deanonymize })
 *   chronologyFromLegalGraph(graph, chronology, mappingDocument, { deanonymize })
 */
function chronologyFromLegalGraph(
  graph,
  documentIndexOrChronology = {},
  mappingDocumentOrOptions = {},
  explicitOptions = {},
) {
  const { mappingDocument, options } = normalizedArguments(mappingDocumentOrOptions, explicitOptions);
  const source = documentIndexOrChronology && typeof documentIndexOrChronology === 'object'
    ? documentIndexOrChronology
    : {};
  const deanonymize = hasOwn(options, 'deanonymize')
    ? Boolean(options.deanonymize)
    : Boolean(source.deanonymized);
  const reverseMapping = mappingDocument?.reverse_mapping || {};
  const localDocuments = Array.isArray(source.documents) ? source.documents : [];
  const localByKey = new Map();
  for (const document of localDocuments) {
    const key = documentKeyFromLocal(document);
    if (key) localByKey.set(key, document);
  }

  const graphDocumentNodes = (graph?.nodes || []).filter(isDocumentNode);
  const mentionedCodes = codesMentionedByDocument(graph);
  const nodesByKey = new Map();
  for (const node of graphDocumentNodes) {
    const key = documentKeyFromNode(node);
    if (!key) continue;
    const previous = nodesByKey.get(key);
    if (!previous || hasOwn(node, 'document_key')) nodesByKey.set(key, node);
  }

  // Repli de migration : un graphe documentaire ancien peut ne pas porter de
  // `document_key`. Dès que la couche composite existe, elle seule gouverne la
  // liste des pièces et une entrée locale orpheline n'est plus projetée.
  const projectionEntries = nodesByKey.size
    ? [...nodesByKey.entries()]
    : localDocuments.map((document) => [documentKeyFromLocal(document), null]).filter(([key]) => key);

  const documents = projectionEntries.map(([key, node]) => {
    const local = localByKey.get(key) || {};
    const effectiveCodes = effectiveCodesFrom(node, local, mentionedCodes);
    const codes = normalizeCodeEntries(effectiveCodes, { deanonymize, reverseMapping });
    const detectedCodes = detectedCodesFrom(node, local);
    const editRevision = firstOwned(node, ['editRevision', 'edit_revision'])
      ?? firstOwned(local, ['editRevision', 'edit_revision'])
      ?? null;
    const qualityFlags = cloneValue(
      firstOwned(node, ['qualityFlags', 'quality_flags'])
      ?? firstOwned(local, ['qualityFlags', 'quality_flags'])
      ?? [],
    );
    const metadata = metadataFrom(node, local);
    const projected = {
      ...cloneValue(local),
      documentKey: key,
      id: local.id || local.path || node?.id || `piece_${key}`,
      path: hasOwn(local, 'path') ? local.path : null,
      name: local.name || node?.label || `PIECE_${key.slice(0, 12).toUpperCase()}`,
      resource: hasOwn(node, 'resource') ? Boolean(node.resource) : Boolean(local.resource),
      scanned: hasOwn(node, 'scanned') ? Boolean(node.scanned) : Boolean(local.scanned),
      analyzable: hasOwn(node, 'analyzable') ? Boolean(node.analyzable) : Boolean(local.analyzable),
      indexed: hasOwn(node, 'indexed')
        ? Boolean(node.indexed)
        : (hasOwn(local, 'indexed')
            ? Boolean(local.indexed)
            : Boolean(node?.metadata || detectedCodes !== undefined)),
      edited: hasOwn(node, 'edited')
        ? Boolean(node.edited)
        : Boolean(local.edited || editRevision || qualityFlags.length),
      nature: effectiveMetadataValue(node, local, 'nature'),
      natureConfidence: firstOwned(node, ['natureConfidence', 'nature_confidence'])
        ?? local.natureConfidence ?? null,
      date: firstOwned(node, ['date']) ?? local.date ?? null,
      dateIso: effectiveMetadataValue(node, local, 'dateIso', ['date_iso']),
      juridiction: effectiveMetadataValue(node, local, 'juridiction', ['jurisdiction']),
      fields: effectiveMetadataValue(node, local, 'fields', ['custom_fields']) || [],
      codes,
      graphNodeId: node?.id || null,
      semanticScope: firstOwned(node, ['semanticScope', 'semantic_scope']) ?? null,
      semanticReason: firstOwned(node, ['semanticReason', 'semantic_reason']) ?? null,
      reviewRequired: Boolean(firstOwned(node, ['reviewRequired', 'review_required']) ?? false),
      reviewReasons: cloneValue(firstOwned(node, ['reviewReasons', 'review_reasons']) || []),
      editRevision,
      qualityFlags,
    };
    if (metadata) projected.metadata = deanonymize ? humanValue(metadata, reverseMapping) : metadata;
    if (detectedCodes !== undefined) {
      projected.detectedCodes = normalizeCodeEntries(detectedCodes, { deanonymize, reverseMapping });
    }
    projected.effectiveCodes = codes;
    const entityDecisions = firstOwned(node, ['entityDecisions', 'entity_decisions'])
      ?? firstOwned(local, ['entityDecisions', 'entity_decisions']);
    if (entityDecisions !== undefined) projected.entityDecisions = cloneValue(entityDecisions);
    const contradictions = firstOwned(node, ['contradictions', 'contradictionFlags', 'contradiction_flags'])
      ?? firstOwned(local, ['contradictions', 'contradictionFlags', 'contradiction_flags']);
    if (contradictions !== undefined) {
      projected.contradictions = deanonymize
        ? humanValue(contradictions, reverseMapping)
        : cloneValue(contradictions);
    }
    if (deanonymize) {
      projected.nature = humanValue(projected.nature, reverseMapping);
      projected.date = humanValue(projected.date, reverseMapping);
      projected.juridiction = humanValue(projected.juridiction, reverseMapping);
      projected.fields = humanValue(projected.fields, reverseMapping);
      projected.qualityFlags = humanValue(projected.qualityFlags, reverseMapping);
    }
    return projected;
  });

  documents.sort((a, b) => {
    if (a.dateIso && b.dateIso) {
      return a.dateIso.localeCompare(b.dateIso) || String(a.name).localeCompare(String(b.name), 'fr');
    }
    if (a.dateIso) return -1;
    if (b.dateIso) return 1;
    return String(a.name).localeCompare(String(b.name), 'fr');
  });

  const datedDocuments = documents.filter((document) => document.dateIso);
  const undatedDocuments = documents.filter((document) => !document.dateIso);
  const entities = buildEntities(documents, { deanonymize, reverseMapping });
  const graphRevision = resolveRevision(graph, documents, options);
  const graphStatus = resolveGraphStatus(graph, options, graphDocumentNodes.length);
  const projectedGraph = graphForCabinet(graph, reverseMapping, deanonymize);
  const engine = graph?.graph?.engine || source?.graph?.engine || 'graphify';
  const graphSource = graph?.graph?.source || source?.graph?.source || 'piecemaker-legal';
  const llm = hasOwn(options, 'llm')
    ? Boolean(options.llm)
    : Boolean(Number(graph?.input_tokens) > 0
      || Number(graph?.output_tokens) > 0
      || Number(graph?.piecemaker?.semanticLegalNodes) > 0);
  const legacyStatus = legacyGraphStatus(graphStatus, projectedGraph.nodes?.length || 0);
  const viewerHtml = options.viewerHtml ?? source?.graph?.viewerHtml ?? projectedGraph.viewerHtml;

  return {
    generatedAt: options.generatedAt || graph?.piecemaker?.generatedAt
      || graph?.graph?.generatedAt || source.generatedAt || new Date().toISOString(),
    deanonymized: deanonymize,
    mapping: mappingSummary(source, mappingDocument),
    graphRevision,
    graphStatus,
    stats: {
      documents: documents.length,
      indexed: documents.filter((document) => document.indexed).length,
      dated: datedDocuments.length,
      entities: entities.length,
      span: datedDocuments.length
        ? {
            from: datedDocuments[0].dateIso,
            to: datedDocuments[datedDocuments.length - 1].dateIso,
          }
        : null,
    },
    documents,
    datedDocuments,
    undatedDocuments,
    entities,
    graph: {
      ...projectedGraph,
      engine,
      source: graphSource,
      llm,
      status: legacyStatus,
      revision: graphRevision,
      state: graphStatus,
      ...(viewerHtml === undefined ? {} : { viewerHtml }),
    },
  };
}

module.exports = {
  chronologyFromLegalGraph,
  documentKeyFromNode,
};

/**
 * Chronologie structurée destinée aux assistants en ligne de commande.
 *
 * La source de vérité est le graphe juridique matérialisé. Il est alimenté
 * par l'index documentaire local, mais permet à l'assistant, à l'admin et aux
 * exports de partager exactement la même liste de pièces et les mêmes valeurs
 * effectives. Cette projection ne contient ni mapping inverse, ni contenu de
 * pièce, ni libellé d'entité en clair. Les noms éventuellement présents dans
 * les noms de fichiers passent en outre par le mapping avant toute sortie
 * standard.
 */
const fs = require('node:fs');
const { buildChronology } = require('./document-index.cjs');
const { chronologyFromLegalGraph } = require('./legal-chronology.cjs');
const {
  legalGraphStatus,
  rematerializeDeterministicLegalGraph,
} = require('./legal-graph.cjs');
const {
  applyMapping,
  readCaseMapping,
} = require('../piecemaker-plugin/scripts/lib/mapping.cjs');
const { locateConfiguredCase } = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, transform)]));
  }
  return value;
}

function compareDocuments(left, right) {
  if (left.date && right.date) return left.date.localeCompare(right.date) || left.piece.localeCompare(right.piece, 'fr');
  if (left.date) return -1;
  if (right.date) return 1;
  return left.piece.localeCompare(right.piece, 'fr');
}

/**
 * Construit la vue sûre que `piecemaker chronology` remet au modèle.
 *
 * Les corrections manuelles de date et de nature sont reprises : ces deux
 * champs structurés sont nécessaires à une chronologie exacte. Les champs
 * libres et la juridiction manuelle restent exclus du mode assistant.
 */
async function buildAssistantChronology(caseRoot) {
  const localChronology = await buildChronology(caseRoot, {
    deanonymizeLabels: false,
    includeManualDecisions: true,
  });

  // La matérialisation ne relance jamais Graphify ni un LLM : elle réunit la
  // couche documentaire exhaustive et, s'il existe, le snapshot sémantique
  // pseudonymisé. Ainsi un assistant ne peut pas déclencher une analyse par
  // simple lecture de chronologie.
  let status = await legalGraphStatus(caseRoot);
  if (!status.exists || !fs.existsSync(status.graphFile)) {
    const synchronized = await rematerializeDeterministicLegalGraph(caseRoot);
    status = {
      ...status,
      exists: true,
      graphFile: synchronized.graphFile,
      generatedAt: synchronized.generatedAt,
      staticState: synchronized.staticState,
      semanticState: synchronized.semanticState,
      staticRevision: synchronized.staticRevision,
      semanticBaseRevision: synchronized.semanticBaseRevision,
      semanticStaleReasons: synchronized.semanticStaleReasons,
      semanticQuarantined: synchronized.semanticQuarantined,
      registry: synchronized.registry,
      registryStatus: synchronized.registry?.status || status.registryStatus,
    };
  }
  let graph;
  try {
    graph = JSON.parse(fs.readFileSync(status.graphFile, 'utf8'));
  } catch {
    throw new Error('Le graphe documentaire matérialisé est illisible.');
  }
  const projected = chronologyFromLegalGraph(
    graph,
    localChronology,
    readCaseMapping(caseRoot),
    {
      deanonymize: false,
      graphRevision: status.staticRevision,
      graphStatus: status,
      generatedAt: status.generatedAt,
    },
  );

  // La borne assistant est volontairement plus étroite que la vue cabinet :
  // les commentaires libres et les juridictions saisies manuellement ne sont
  // jamais remis au modèle, même déjà pseudonymisés.
  const documents = projected.documents.map((document) => {
    const dateSource = document.metadata?.dateIso?.source;
    const natureSource = document.metadata?.nature?.source;
    const manualJuridiction = document.metadata?.juridiction?.source === 'admin_manual';
    return {
      piece: document.path,
      date: document.dateIso || null,
      dateSource: document.dateIso
        ? (dateSource === 'admin_manual' ? 'correction-cabinet' : 'detection') : null,
      nature: document.nature || null,
      natureSource: document.nature
        ? (natureSource === 'admin_manual' ? 'correction-cabinet' : 'detection') : null,
      // Les annotations libres du cabinet ne sont pas nécessaires au modèle,
      // même pseudonymisées ; seule une juridiction détectée est projetée.
      juridiction: manualJuridiction ? null : (document.juridiction || null),
      indexed: Boolean(document.indexed),
      scanned: Boolean(document.scanned),
      status: document.status,
      entities: (document.codes || []).map((entry) => ({ code: entry.code, category: entry.category })),
    };
  }).sort(compareDocuments);

  documents.forEach((document, index) => {
    document.id = `PIECE_${String(index + 1).padStart(3, '0')}`;
  });

  const entityDocuments = new Map();
  const entityCategories = new Map();
  for (const document of documents) {
    for (const entity of document.entities) {
      if (!entityDocuments.has(entity.code)) entityDocuments.set(entity.code, []);
      entityDocuments.get(entity.code).push(document.id);
      entityCategories.set(entity.code, entity.category);
    }
  }

  const entities = [...entityDocuments]
    .map(([code, documentIds]) => ({
      code,
      category: entityCategories.get(code) || 'autre',
      documents: documentIds,
      documentCount: documentIds.length,
    }))
    .sort((left, right) => right.documentCount - left.documentCount || left.code.localeCompare(right.code));

  const dated = documents.filter((document) => document.date);
  const result = {
    version: 1,
    source: 'piecemaker-legal-graph',
    confidentiality: 'pseudonymisee',
    generatedAt: new Date().toISOString(),
    stats: {
      documents: documents.length,
      indexed: documents.filter((document) => document.indexed).length,
      dated: dated.length,
      undated: documents.length - dated.length,
      entities: entities.length,
      span: dated.length ? { from: dated[0].date, to: dated[dated.length - 1].date } : null,
    },
    documents,
    graph: {
      kind: 'pieces-entites',
      entities,
      edgeCount: entities.reduce((total, entity) => total + entity.documentCount, 0),
      staticRevision: projected.graphRevision,
      semanticState: projected.graphStatus?.semanticState || 'missing',
    },
    warnings: [
      'Les dates et natures détectées automatiquement sont indicatives et doivent être vérifiées sur les pièces converties.',
      ...(documents.some((document) => !document.date)
        ? ['Certaines pièces ne comportent aucune date indexée.']
        : []),
    ],
  };

  const mapping = readCaseMapping(caseRoot).mapping;
  return mapStrings(result, (value) => applyMapping(value, mapping));
}

async function chronologyForTarget(config, target) {
  const located = locateConfiguredCase(config, target);
  if (!located) {
    throw new Error('Aucun dossier juridique enregistré ne correspond au chemin demandé. Lancez la commande depuis le dossier ou passez --case <chemin>.');
  }
  return buildAssistantChronology(located.caseRoot);
}

function formatAssistantChronology(chronology) {
  const lines = [
    '# Chronologie PieceMaker (pseudonymisée)',
    '',
    `- Pièces : ${chronology.stats.documents}`,
    `- Datées : ${chronology.stats.dated}`,
    `- Indexées : ${chronology.stats.indexed}`,
    `- Entités : ${chronology.stats.entities}`,
    ...(chronology.stats.span
      ? [`- Période : ${chronology.stats.span.from} → ${chronology.stats.span.to}`]
      : []),
    '',
    '## Pièces',
    '',
  ];

  for (const document of chronology.documents) {
    const date = document.date || 'date inconnue';
    const nature = document.nature || 'nature inconnue';
    lines.push(`- **${date}** — ${document.id} — ${nature} — \`${document.piece}\``);
    if (document.juridiction) lines.push(`  Juridiction : ${document.juridiction}`);
    if (document.entities.length) lines.push(`  Entités : ${document.entities.map((entry) => entry.code).join(', ')}`);
  }

  const shared = chronology.graph.entities.filter((entity) => entity.documentCount > 1);
  if (shared.length) {
    lines.push('', '## Liens entre pièces', '');
    for (const entity of shared) lines.push(`- ${entity.code} : ${entity.documents.join(', ')}`);
  }

  if (chronology.warnings.length) {
    lines.push('', '## Vigilance', '');
    for (const warning of chronology.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildAssistantChronology,
  chronologyForTarget,
  formatAssistantChronology,
  mapStrings,
};

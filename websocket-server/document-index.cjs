/**
 * Index par document — chronologie, nature et attribution des entités.
 *
 * Le pipeline Python écrit `<dossier>/.piecemaker/document-index.json` : pour
 * chaque pièce scannée, sa nature, sa date, sa juridiction et la liste des
 * CODES d'entités qu'elle cite (jamais les noms en clair, jamais le nom de
 * fichier — la clé est le même hash que le manifeste de scan). Ce module lit cet
 * index et le recroise avec la liste des pièces et le mapping du dossier pour
 * produire une chronologie et un graphe pièces ↔ entités.
 *
 * La ré-identification (code → nom) n'a lieu que côté serveur, sur la machine du
 * cabinet, exactement comme l'éditeur de mapping de l'administration : le graphe
 * reste indexé par code, et le libellé n'est joint que si `deanonymize` est vrai.
 */
const fs = require('node:fs');
const path = require('node:path');

const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { originalFilesOverview } = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const { readCaseMapping } = require('../piecemaker-plugin/scripts/lib/mapping.cjs');

const DOCUMENT_INDEX_RELATIVE_PATH = '.piecemaker/document-index.json';

function documentIndexFile(caseRoot) {
  return path.join(caseRoot, ...DOCUMENT_INDEX_RELATIVE_PATH.split('/'));
}

/** Lecture tolérante : un index absent ou corrompu donne un index vide. */
function readDocumentIndex(caseRoot) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(documentIndexFile(caseRoot), 'utf8').replace(/^﻿/, ''));
  } catch {
    return { version: 1, documents: {} };
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const documents = source.documents && typeof source.documents === 'object' && !Array.isArray(source.documents)
    ? source.documents
    : {};
  const clean = {};
  for (const [key, entry] of Object.entries(documents)) {
    if (!/^[a-f0-9]{64}$/i.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    clean[key.toLowerCase()] = {
      nature: typeof entry.nature === 'string' ? entry.nature : null,
      nature_confidence: Number.isFinite(entry.nature_confidence) ? entry.nature_confidence : null,
      doc_date: typeof entry.doc_date === 'string' ? entry.doc_date : null,
      doc_date_iso: /^\d{4}-\d{2}-\d{2}$/.test(entry.doc_date_iso) ? entry.doc_date_iso : null,
      juridiction: typeof entry.juridiction === 'string' ? entry.juridiction : null,
      codes: Array.isArray(entry.codes) ? entry.codes.filter((code) => typeof code === 'string') : [],
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
    };
  }
  return { version: 1, documents: clean };
}

/** Catégorie d'un code, déduite de sa famille (même vocabulaire que le pipeline). */
function categoryForCode(code) {
  // On teste par inclusion, pas par préfixe : le mapping enrichit souvent le code
  // d'un rôle procédural ("CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01",
  // "ADVERSAIRE_DEFENDEUR_PERSONNE_PHYSIQUE_01"), et un mapping ancien peut mal
  // former le séparateur ("SOCIETE SA_02"). Blancs normalisés, casse ignorée.
  const c = String(code).replace(/\s+/g, '_').toUpperCase();
  if (c.includes('PERSONNE_PHYSIQUE') || c.includes('DIRIGEANT')) return 'personne';
  if (c.includes('PERSONNE_MORALE') || c.includes('SOCIETE')) return 'societe';
  if (c.includes('ADRESSE')) return 'adresse';
  if (c.includes('SIREN')) return 'siren';
  return 'autre';
}

const FREE_TEXT_STOPWORDS = new Set([
  'sarl', 'sasu', 'société', 'societe', 'compagnie', 'groupe', 'group',
  'holding', 'association', 'syndicat', 'france',
]);

/** Tokens distinctifs (>=4) de chaque entité mappée — pour épurer les champs libres. */
function sensitiveTokens(mappingDict) {
  const tokens = new Set();
  for (const variant of Object.keys(mappingDict || {})) {
    for (const token of String(variant).toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || []) {
      if (!FREE_TEXT_STOPWORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Défense en profondeur, en miroir du pipeline Python : la « juridiction » est un
 * champ libre où GLiNER confond souvent une partie avec le tribunal. Un index déjà
 * écrit (avant le correctif Python) peut contenir un nom en clair — on le retire
 * s'il partage un token avec une entité mappée, dans toutes les vues.
 */
function scrubFreeText(value, tokens) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const found = value.toLowerCase().match(/[a-zà-ÿ0-9]{4,}/g) || [];
  // Noise-only extraction ("SA", "n/a", "RCS") carries no court name — drop it.
  if (!found.length) return null;
  return found.some((token) => tokens.has(token)) ? null : value;
}

/**
 * Chronologie complète d'un dossier : documents datés + graphe pièces ↔ entités.
 *
 * @param {string} caseRoot racine du dossier juridique
 * @param {{ deanonymize?: boolean }} options ré-identifier les codes (vue cabinet)
 */
async function buildChronology(caseRoot, { deanonymize = false } = {}) {
  const index = readDocumentIndex(caseRoot);
  const mapping = readCaseMapping(caseRoot);
  const reverse = mapping.reverse_mapping || {};
  // Un code renuméroté/supprimé dans l'éditeur ne doit pas rester fantôme dans le
  // graphe : on ne garde que les codes encore présents dans le mapping courant.
  const knownCodes = new Set(Object.keys(reverse));
  const scrubTokens = sensitiveTokens(mapping.mapping || {});

  const labelFor = (code) => {
    if (!deanonymize) return null;
    const values = reverse[code];
    return Array.isArray(values) && values.length ? String(values[0]) : null;
  };

  const overview = await originalFilesOverview(caseRoot);
  const originals = overview.filter((file) => file.extension !== '.md');

  // Agrégat par entité, pour la colonne latérale et les arêtes du graphe.
  const entities = new Map(); // code -> { code, category, label, documents:Set }
  const noteEntity = (code, docId) => {
    if (!knownCodes.has(code)) return false;
    let entry = entities.get(code);
    if (!entry) {
      entry = { code, category: categoryForCode(code), label: labelFor(code), documents: new Set() };
      entities.set(code, entry);
    }
    entry.documents.add(docId);
    return true;
  };

  const documents = [];
  for (const file of originals) {
    const entry = index.documents[stateKey(file.path)] || null;
    const docId = file.path;
    const codes = [];
    if (entry) {
      for (const code of entry.codes) {
        if (noteEntity(code, docId)) codes.push(code);
      }
    }
    documents.push({
      id: docId,
      path: file.path,
      name: file.name,
      extension: file.extension,
      status: file.status,
      protected: file.protected,
      scanned: file.scanned,
      indexed: Boolean(entry),
      nature: entry ? entry.nature : null,
      natureConfidence: entry ? entry.nature_confidence : null,
      date: entry ? entry.doc_date : null,
      dateIso: entry ? entry.doc_date_iso : null,
      juridiction: entry ? scrubFreeText(entry.juridiction, scrubTokens) : null,
      codes: codes.map((code) => ({ code, category: categoryForCode(code), label: labelFor(code) })),
    });
  }

  // Tri chronologique : date connue d'abord (croissant), puis les pièces sans
  // date, par nom, pour rester déterministe.
  documents.sort((a, b) => {
    if (a.dateIso && b.dateIso) return a.dateIso.localeCompare(b.dateIso) || a.name.localeCompare(b.name, 'fr');
    if (a.dateIso) return -1;
    if (b.dateIso) return 1;
    return a.name.localeCompare(b.name, 'fr');
  });

  const entityList = [...entities.values()]
    .map((entry) => ({
      code: entry.code,
      category: entry.category,
      label: entry.label,
      documentCount: entry.documents.size,
      documents: [...entry.documents],
    }))
    .sort((a, b) => b.documentCount - a.documentCount || a.code.localeCompare(b.code));

  // Graphe biparti pièces ↔ entités : le client peut en dériver les liens
  // pièce↔pièce (entités partagées) sans que le serveur ne les matérialise.
  const nodes = [];
  const edges = [];
  for (const doc of documents) {
    nodes.push({
      id: `doc:${doc.id}`,
      kind: 'document',
      label: doc.name,
      nature: doc.nature,
      dateIso: doc.dateIso,
      protected: doc.protected,
    });
    for (const code of doc.codes) {
      edges.push({ source: `doc:${doc.id}`, target: `ent:${code.code}`, kind: 'cite' });
    }
  }
  for (const entity of entityList) {
    nodes.push({
      id: `ent:${entity.code}`,
      kind: 'entity',
      category: entity.category,
      label: entity.label || entity.code,
      code: entity.code,
      degree: entity.documentCount,
    });
  }

  const dated = documents.filter((doc) => doc.dateIso);
  return {
    generatedAt: new Date().toISOString(),
    deanonymized: Boolean(deanonymize),
    mapping: { exists: mapping.exists, entries: Object.keys(mapping.mapping || {}).length },
    stats: {
      documents: documents.length,
      indexed: documents.filter((doc) => doc.indexed).length,
      dated: dated.length,
      entities: entityList.length,
      span: dated.length
        ? { from: dated[0].dateIso, to: dated[dated.length - 1].dateIso }
        : null,
    },
    documents,
    entities: entityList,
    graph: { nodes, edges },
  };
}

module.exports = {
  DOCUMENT_INDEX_RELATIVE_PATH,
  documentIndexFile,
  readDocumentIndex,
  categoryForCode,
  buildChronology,
};

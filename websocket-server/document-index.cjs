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
const { isSocieteCode } = require('./legal-forms.cjs');

const DOCUMENT_INDEX_RELATIVE_PATH = '.piecemaker/document-index.json';

// Corrections manuelles du cabinet (nature / date / lieu + champs libres), dans
// la racine `overrides` du MÊME index. Le pipeline Python préserve cette racine
// lors d'un re-scan. Clé identique aux documents (`stateKey` du chemin relatif).
// C'est une annotation propre à la vue cabinet : elle n'est appliquée qu'en mode
// ré-identifié, jamais en mode « codes seuls » (elle porte du texte libre saisi
// en clair).
//
// Ancien fichier lu uniquement pour migration lors de la prochaine correction.
const LEGACY_DOCUMENT_INDEX_OVERRIDES_RELATIVE_PATH = '.piecemaker/document-index-overrides.json';

const OVERRIDE_MAX_FIELDS = 24;

function documentIndexFile(caseRoot) {
  return path.join(caseRoot, ...DOCUMENT_INDEX_RELATIVE_PATH.split('/'));
}

function legacyDocumentIndexOverridesFile(caseRoot) {
  return path.join(caseRoot, ...LEGACY_DOCUMENT_INDEX_OVERRIDES_RELATIVE_PATH.split('/'));
}

function cleanOverrideString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Normalise une correction manuelle : champs bornés, `fields` filtré et plafonné. */
function normalizeOverrideEntry(entry) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const fields = Array.isArray(source.fields)
    ? source.fields
        .map((field) => {
          if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
          const label = cleanOverrideString(field.label, 120) || '';
          const value = cleanOverrideString(field.value, 400) || '';
          return label || value ? { label, value } : null;
        })
        .filter(Boolean)
        .slice(0, OVERRIDE_MAX_FIELDS)
    : [];
  return {
    nature: cleanOverrideString(source.nature, 120),
    dateIso: /^\d{4}-\d{2}-\d{2}$/.test(source.dateIso) ? source.dateIso : null,
    juridiction: cleanOverrideString(source.juridiction, 200),
    fields,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

/** Une correction vide (tous champs effacés) : signal de retour à la détection. */
function isEmptyOverride(entry) {
  return entry.nature == null && entry.dateIso == null && entry.juridiction == null && entry.fields.length === 0;
}

function normalizeOverrides(documents) {
  const source = documents && typeof documents === 'object' && !Array.isArray(documents) ? documents : {};
  const clean = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!/^[a-f0-9]{64}$/i.test(key)) continue;
    clean[key.toLowerCase()] = normalizeOverrideEntry(entry);
  }
  return clean;
}

/** Lit l'ancien fichier séparé, uniquement pour le migrer sans perte. */
function readLegacyDocumentIndexOverrides(caseRoot) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(legacyDocumentIndexOverridesFile(caseRoot), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {};
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return normalizeOverrides(source.documents);
}

/**
 * Écrit (ou supprime) la correction manuelle d'une pièce, désignée par son chemin
 * RELATIF à la racine du dossier — la même clé que la chronologie. Une correction
 * entièrement vide efface l'entrée (retour aux valeurs détectées). Écriture
 * atomique, permissions 0600 comme l'index.
 */
function writeDocumentIndexOverride(caseRoot, relativePath, override) {
  const key = stateKey(relativePath);
  if (!key) throw new Error('Chemin de pièce invalide.');
  const current = readDocumentIndex(caseRoot);
  // L'index courant prime ; les autres anciennes corrections sont rapatriées.
  current.overrides = { ...readLegacyDocumentIndexOverrides(caseRoot), ...current.overrides };
  const normalized = normalizeOverrideEntry({ ...override, updatedAt: new Date().toISOString() });
  if (isEmptyOverride(normalized)) {
    delete current.overrides[key];
  } else {
    current.overrides[key] = normalized;
  }
  const file = documentIndexFile(caseRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.piecemaker-${process.pid}.tmp`;
  // Fichier interne compact : moins de volume et de tokens si un outil le lit.
  fs.writeFileSync(temporary, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  // Suppression seulement après l'écriture atomique réussie de la migration.
  try {
    fs.unlinkSync(legacyDocumentIndexOverridesFile(caseRoot));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  return current.overrides[key] || null;
}

/** Lecture tolérante : un index absent ou corrompu donne un index vide. */
function readDocumentIndex(caseRoot) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(documentIndexFile(caseRoot), 'utf8').replace(/^﻿/, ''));
  } catch {
    return { version: 1, documents: {}, overrides: readLegacyDocumentIndexOverrides(caseRoot) };
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
  const embeddedOverrides = normalizeOverrides(source.overrides);
  return {
    version: 1,
    documents: clean,
    overrides: { ...readLegacyDocumentIndexOverrides(caseRoot), ...embeddedOverrides },
  };
}

/** Vue de compatibilité des corrections manuelles. */
function readDocumentIndexOverrides(caseRoot) {
  return { version: 1, documents: readDocumentIndex(caseRoot).overrides };
}

/** Catégorie d'un code, déduite de sa famille (même vocabulaire que le pipeline). */
function categoryForCode(code) {
  // On teste par inclusion, pas par préfixe : le mapping enrichit souvent le code
  // d'un rôle procédural ("CLIENT_DEMANDEUR_PERSONNE_PHYSIQUE_01",
  // "ADVERSAIRE_DEFENDEUR_PERSONNE_PHYSIQUE_01"), et un mapping ancien peut mal
  // former le séparateur ("SOCIETE SA_02"). Blancs normalisés, casse ignorée.
  const c = String(code).replace(/\s+/g, '_').toUpperCase();
  if (c.includes('PERSONNE_PHYSIQUE') || c.includes('DIRIGEANT')) return 'personne';
  if (c.includes('ADRESSE')) return 'adresse';
  if (c.includes('SIREN')) return 'siren';
  // Sociétés : repli/legacy (…MORALE…, SOCIETE_…) et codes à sigle (SA_1, GMBH_2).
  if (isSocieteCode(c)) return 'societe';
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
  // Les corrections manuelles n'existent que pour la vue cabinet : elles portent
  // du texte libre saisi en clair (lieu, champs), qui n'a rien à faire dans la
  // sortie « codes seuls ». En mode codes, on garde strictement les valeurs GLiNER.
  const overrides = deanonymize ? index.overrides : {};
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
    const key = stateKey(file.path);
    const entry = index.documents[key] || null;
    const override = overrides[key] || null;
    const docId = file.path;
    const codes = [];
    if (entry) {
      for (const code of entry.codes) {
        if (noteEntity(code, docId)) codes.push(code);
      }
    }
    // Une correction manuelle « prend la main » sur la pièce : la popup pré-remplit
    // les valeurs détectées, l'utilisateur édite, et l'ensemble est ré-enregistré —
    // une re-détection ultérieure ne réécrase donc pas un choix explicite. Le lieu
    // saisi à la main n'est jamais épuré (contrairement au champ détecté).
    documents.push({
      id: docId,
      path: file.path,
      name: file.name,
      extension: file.extension,
      status: file.status,
      protected: file.protected,
      scanned: file.scanned,
      indexed: Boolean(entry),
      edited: Boolean(override),
      nature: override ? override.nature : (entry ? entry.nature : null),
      natureConfidence: entry ? entry.nature_confidence : null,
      date: entry ? entry.doc_date : null,
      dateIso: override ? override.dateIso : (entry ? entry.doc_date_iso : null),
      juridiction: override ? override.juridiction : (entry ? scrubFreeText(entry.juridiction, scrubTokens) : null),
      fields: override ? override.fields : [],
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
    // Topologie de secours pour les consommateurs internes. La route admin la
    // remplace par la sortie Graphify construite à partir de ce même index.
    graph: {
      engine: 'index-fallback', source: 'gliner', llm: false,
      status: edges.length ? 'ready' : 'empty', nodes, edges,
    },
  };
}

module.exports = {
  DOCUMENT_INDEX_RELATIVE_PATH,
  documentIndexFile,
  readDocumentIndex,
  readDocumentIndexOverrides,
  writeDocumentIndexOverride,
  categoryForCode,
  buildChronology,
};

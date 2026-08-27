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
 * reste indexé par code, et le libellé n'est joint que si
 * `deanonymizeLabels` est vrai. L'application des décisions manuelles est un
 * choix distinct : le graphe pseudonymisé doit lui aussi refléter les
 * corrections du cabinet.
 */
const fs = require('node:fs');
const path = require('node:path');

const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { originalFilesOverview } = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const {
  applyMapping,
  readCaseMapping,
} = require('../piecemaker-plugin/scripts/lib/mapping.cjs');
const { isSocieteCode } = require('./legal-forms.cjs');

const DOCUMENT_INDEX_RELATIVE_PATH = '.piecemaker/document-index.json';

// Corrections manuelles du cabinet (nature / date / lieu + champs libres), dans
// la racine `overrides` du MÊME index. Le pipeline Python préserve cette racine
// lors d'un re-scan. Clé identique aux documents (`stateKey` du chemin relatif).
// Elles sont appliquées aux vues claires comme pseudonymisées ; dans cette
// dernière, le texte libre est codé en mémoire avant d'entrer dans le graphe.
//
// Ancien fichier lu uniquement pour migration lors de la prochaine correction.
const LEGACY_DOCUMENT_INDEX_OVERRIDES_RELATIVE_PATH = '.piecemaker/document-index-overrides.json';

const OVERRIDE_MAX_FIELDS = 24;
const DOCUMENT_INDEX_VERSION = 2;
const MANUAL_OVERRIDE_FLAG = 'MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION';
const METADATA_FIELDS = ['nature', 'dateIso', 'juridiction', 'fields'];

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

function cleanCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (!code || code.length > 160 || /[\x00-\x1f\x7f]/.test(code)) return null;
  return code;
}

function normalizeEntityDecisionEntry(entry) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const codes = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map(cleanCode)
    .filter(Boolean))].sort();
  return {
    additions: codes(source.additions),
    exclusions: codes(source.exclusions),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  };
}

function isEmptyEntityDecision(entry) {
  return entry.additions.length === 0 && entry.exclusions.length === 0;
}

function normalizeEntityDecisions(decisions) {
  const source = decisions && typeof decisions === 'object' && !Array.isArray(decisions) ? decisions : {};
  const clean = {};
  for (const [key, entry] of Object.entries(source)) {
    if (!/^[a-f0-9]{64}$/i.test(key)) continue;
    const normalized = normalizeEntityDecisionEntry(entry);
    if (!isEmptyEntityDecision(normalized)) clean[key.toLowerCase()] = normalized;
  }
  return clean;
}

function jsonValue(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeRevisionEntries(revisions) {
  if (!Array.isArray(revisions)) return [];
  const clean = [];
  let previousRevision = 0;
  for (const entry of revisions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const documentKey = String(entry.documentKey || '').toLowerCase();
    const field = String(entry.field || '');
    const revision = Number(entry.revision);
    if (!/^[a-f0-9]{64}$/.test(documentKey) || !Number.isSafeInteger(revision)
        || revision <= previousRevision || ![...METADATA_FIELDS, 'codes'].includes(field)) continue;
    clean.push({
      revision,
      documentKey,
      field,
      detectedValue: jsonValue(entry.detectedValue),
      previousEffectiveValue: jsonValue(entry.previousEffectiveValue),
      newValue: jsonValue(entry.newValue),
      previousSource: entry.previousSource === 'admin_manual' ? 'admin_manual' : 'detection',
      source: entry.source === 'admin_manual' ? 'admin_manual' : 'detection',
      reason: cleanOverrideString(entry.reason, 400),
      editedAt: typeof entry.editedAt === 'string' ? entry.editedAt : null,
      semanticImpact: cleanOverrideString(entry.semanticImpact, 80),
    });
    previousRevision = revision;
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

function detectedMetadata(entry) {
  return {
    nature: entry?.nature ?? null,
    dateIso: entry?.doc_date_iso ?? null,
    juridiction: entry?.juridiction ?? null,
    fields: [],
  };
}

function effectiveMetadata(entry, override) {
  const detected = detectedMetadata(entry);
  if (!override) return { ...detected, source: 'detection' };
  return {
    nature: override.nature,
    dateIso: override.dateIso,
    juridiction: override.juridiction,
    fields: override.fields,
    source: 'admin_manual',
  };
}

function effectiveEntityCodes(entry, decision, knownCodes = null) {
  const detected = [...new Set((entry?.codes || []).filter((code) =>
    typeof code === 'string' && (!knownCodes || knownCodes.has(code))))];
  if (!decision) return detected.sort();
  const exclusions = new Set(decision.exclusions);
  return [...new Set([
    ...detected.filter((code) => !exclusions.has(code)),
    ...decision.additions.filter((code) => !knownCodes || knownCodes.has(code)),
  ])].sort();
}

function semanticImpactForField(field) {
  if (['nature', 'dateIso'].includes(field)) return 'refresh_required';
  if (field === 'codes') return 'refresh_if_scope_changed';
  return 'display_only';
}

function semanticStaleReasonForField(field) {
  if (field === 'dateIso') return 'date_changed';
  if (field === 'codes') return 'document_entities_changed';
  return `${field}_changed`;
}

function appendRevision(current, {
  documentKey,
  field,
  detectedValue,
  previousEffectiveValue,
  newValue,
  previousSource,
  source,
  reason,
  editedAt,
}) {
  const last = current.revisions.at(-1)?.revision || 0;
  const revision = last + 1;
  current.revisions.push({
    revision,
    documentKey,
    field,
    detectedValue: jsonValue(detectedValue),
    previousEffectiveValue: jsonValue(previousEffectiveValue),
    newValue: jsonValue(newValue),
    previousSource,
    source,
    reason: cleanOverrideString(reason, 400),
    editedAt,
    semanticImpact: semanticImpactForField(field),
  });
  return revision;
}

function writeDocumentIndexFile(caseRoot, current) {
  const file = documentIndexFile(caseRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.piecemaker-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(current)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.unlinkSync(legacyDocumentIndexOverridesFile(caseRoot));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

/**
 * Applique une correction documentaire atomique et renvoie son impact précis.
 * Les métadonnées gardent le contrat historique de « snapshot complet » : une
 * correction vide revient intégralement aux valeurs détectées. Les décisions
 * d'entités, optionnelles, sont locales à la pièce.
 */
function applyDocumentIndexCorrection(caseRoot, relativePath, correction, {
  now = () => new Date(),
} = {}) {
  const key = stateKey(relativePath);
  if (!key) throw new Error('Chemin de pièce invalide.');
  const current = readDocumentIndex(caseRoot);
  current.version = DOCUMENT_INDEX_VERSION;
  current.overrides = { ...readLegacyDocumentIndexOverrides(caseRoot), ...current.overrides };
  const entry = current.documents[key] || null;
  const previousOverride = current.overrides[key] || null;
  const previousDecision = current.entityDecisions[key] || null;
  const previousMetadata = effectiveMetadata(entry, previousOverride);
  const mapping = readCaseMapping(caseRoot);
  const knownCodes = new Set(Object.keys(mapping.reverse_mapping || {}));
  const previousCodes = effectiveEntityCodes(entry, previousDecision, knownCodes);
  const editedAt = now().toISOString();
  const normalized = normalizeOverrideEntry({ ...correction, updatedAt: editedAt });
  if (isEmptyOverride(normalized)) {
    delete current.overrides[key];
  } else {
    current.overrides[key] = normalized;
  }

  if (Object.hasOwn(correction || {}, 'entityDecisions')) {
    const decision = normalizeEntityDecisionEntry(correction.entityDecisions);
    const overlap = decision.additions.find((code) => decision.exclusions.includes(code));
    if (overlap) throw new Error(`Le code ${overlap} ne peut pas être simultanément ajouté et écarté.`);
    const unknown = [...decision.additions, ...decision.exclusions]
      .find((code) => !knownCodes.has(code));
    if (unknown) throw new Error(`Code d’entité inconnu dans le mapping du dossier : ${unknown}.`);
    decision.updatedAt = editedAt;
    if (isEmptyEntityDecision(decision)) delete current.entityDecisions[key];
    else current.entityDecisions[key] = decision;
  }

  const nextOverride = current.overrides[key] || null;
  const nextDecision = current.entityDecisions[key] || null;
  const nextMetadata = effectiveMetadata(entry, nextOverride);
  const nextCodes = effectiveEntityCodes(entry, nextDecision, knownCodes);
  const detected = detectedMetadata(entry);
  const revisions = [];
  for (const field of METADATA_FIELDS) {
    if (sameValue(previousMetadata[field], nextMetadata[field])
        && previousMetadata.source === nextMetadata.source) continue;
    revisions.push(appendRevision(current, {
      documentKey: key,
      field,
      detectedValue: detected[field],
      previousEffectiveValue: previousMetadata[field],
      newValue: nextMetadata[field],
      previousSource: previousMetadata.source,
      source: nextMetadata.source,
      reason: correction?.reason,
      editedAt,
    }));
  }
  if (!sameValue(previousCodes, nextCodes) || Boolean(previousDecision) !== Boolean(nextDecision)) {
    revisions.push(appendRevision(current, {
      documentKey: key,
      field: 'codes',
      detectedValue: effectiveEntityCodes(entry, null, knownCodes),
      previousEffectiveValue: previousCodes,
      newValue: nextCodes,
      previousSource: previousDecision ? 'admin_manual' : 'detection',
      source: nextDecision ? 'admin_manual' : 'detection',
      reason: correction?.reason,
      editedAt,
    }));
  }

  writeDocumentIndexFile(caseRoot, current);
  const semanticStaleReasons = [...new Set(revisions
    .map((revision) => current.revisions.find((entryRevision) => entryRevision.revision === revision))
    // Changer seulement la provenance (détection → correction portant la même
    // valeur) reste utile dans l'historique, mais ne change aucune entrée LLM.
    .filter((revision) => revision?.semanticImpact !== 'display_only'
      && !sameValue(revision.previousEffectiveValue, revision.newValue))
    .map((revision) => semanticStaleReasonForField(revision.field)))];
  return {
    documentKey: key,
    override: nextOverride,
    entityDecisions: nextDecision || { additions: [], exclusions: [], updatedAt: null },
    revisions,
    editRevision: current.revisions.at(-1)?.revision || 0,
    semanticStaleReasons,
  };
}

/** Vue de compatibilité : retourne uniquement l'override comme auparavant. */
function writeDocumentIndexOverride(caseRoot, relativePath, override) {
  return applyDocumentIndexCorrection(caseRoot, relativePath, override).override;
}

/** Lecture tolérante : un index absent ou corrompu donne un index vide. */
function readDocumentIndex(caseRoot) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(documentIndexFile(caseRoot), 'utf8').replace(/^﻿/, ''));
  } catch {
    return {
      version: DOCUMENT_INDEX_VERSION,
      documents: {},
      overrides: readLegacyDocumentIndexOverrides(caseRoot),
      entityDecisions: {},
      revisions: [],
    };
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
  const revisions = normalizeRevisionEntries(source.revisions);
  return {
    version: DOCUMENT_INDEX_VERSION,
    documents: clean,
    overrides: { ...readLegacyDocumentIndexOverrides(caseRoot), ...embeddedOverrides },
    entityDecisions: normalizeEntityDecisions(source.entityDecisions),
    revisions,
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
 * @param {{ deanonymize?: boolean, deanonymizeLabels?: boolean,
 *   includeManualDecisions?: boolean }} options
 */
async function buildChronology(caseRoot, options = {}) {
  const deanonymizeLabels = options.deanonymizeLabels ?? options.deanonymize ?? false;
  const includeManualDecisions = options.includeManualDecisions ?? true;
  const index = readDocumentIndex(caseRoot);
  const overrides = includeManualDecisions ? index.overrides : {};
  const entityDecisions = includeManualDecisions ? index.entityDecisions : {};
  const mapping = readCaseMapping(caseRoot);
  const reverse = mapping.reverse_mapping || {};
  // Un code renuméroté/supprimé dans l'éditeur ne doit pas rester fantôme dans le
  // graphe : on ne garde que les codes encore présents dans le mapping courant.
  const knownCodes = new Set(Object.keys(reverse));
  const scrubTokens = sensitiveTokens(mapping.mapping || {});

  const labelFor = (code) => {
    if (!deanonymizeLabels) return null;
    const values = reverse[code];
    return Array.isArray(values) && values.length ? String(values[0]) : null;
  };

  // Les décisions manuelles existent aussi dans la couche pseudonymisée. Leur
  // texte libre est donc codé à la volée quand la vue ne doit pas être claire.
  const visibleValue = (value) => {
    if (deanonymizeLabels || typeof value !== 'string') return value;
    return applyMapping(value, mapping.mapping || {});
  };
  const visibleMetadataValue = (value) => {
    if (Array.isArray(value)) return value.map((entry) => visibleMetadataValue(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .map(([key, entry]) => [key, visibleMetadataValue(entry)]));
    }
    return visibleValue(value);
  };

  const overview = await originalFilesOverview(caseRoot);
  const originals = overview.filter((file) => file.extension !== '.md');
  const editRevisionByKey = new Map();
  for (const revision of index.revisions) {
    editRevisionByKey.set(revision.documentKey, revision.revision);
  }

  const documents = [];
  for (const file of originals) {
    const key = stateKey(file.path);
    const entry = index.documents[key] || null;
    const override = overrides[key] || null;
    const entityDecision = entityDecisions[key] || null;
    const docId = file.path;
    const detected = detectedMetadata(entry);
    detected.juridiction = entry ? scrubFreeText(entry.juridiction, scrubTokens) : null;
    const effective = effectiveMetadata({ ...entry, juridiction: detected.juridiction }, override);
    const detectedCodes = effectiveEntityCodes(entry, null, knownCodes);
    const effectiveCodes = effectiveEntityCodes(entry, entityDecision, knownCodes);
    const editRevision = editRevisionByKey.get(key) || 0;
    const qualityFlags = [];
    if (override) {
      for (const field of METADATA_FIELDS) {
        if (sameValue(detected[field], effective[field])) continue;
        qualityFlags.push({
          type: MANUAL_OVERRIDE_FLAG,
          field,
          detectedValue: visibleMetadataValue(detected[field]),
          effectiveValue: visibleMetadataValue(effective[field]),
          source: 'admin_manual',
        });
      }
    }
    if (entityDecision && !sameValue(detectedCodes, effectiveCodes)) {
      qualityFlags.push({
        type: MANUAL_OVERRIDE_FLAG,
        field: 'codes',
        detectedValue: detectedCodes,
        effectiveValue: effectiveCodes,
        source: 'admin_manual',
      });
    }
    // Une correction manuelle « prend la main » sur la pièce : la popup pré-remplit
    // les valeurs détectées, l'utilisateur édite, et l'ensemble est ré-enregistré —
    // une re-détection ultérieure ne réécrase donc pas un choix explicite. Le lieu
    // saisi à la main n'est jamais épuré (contrairement au champ détecté).
    documents.push({
      // Jointure pseudonyme stable avec le graphe juridique. Le chemin et le
      // nom restent disponibles dans cette vue locale, mais seul ce hash est
      // matérialisé dans le graphe persistant.
      documentKey: key,
      id: docId,
      path: file.path,
      name: file.name,
      extension: file.extension,
      status: file.status,
      protected: file.protected,
      resource: file.resource,
      scanned: file.scanned,
      indexed: Boolean(entry),
      edited: Boolean(override || entityDecision),
      nature: visibleMetadataValue(effective.nature),
      natureConfidence: entry ? entry.nature_confidence : null,
      date: entry ? entry.doc_date : null,
      dateIso: effective.dateIso,
      juridiction: visibleMetadataValue(effective.juridiction),
      fields: visibleMetadataValue(effective.fields),
      metadata: Object.fromEntries(METADATA_FIELDS.map((field) => [field, {
        detected: visibleMetadataValue(detected[field]),
        effective: visibleMetadataValue(effective[field]),
        source: override ? 'admin_manual' : 'detection',
      }])),
      editRevision,
      qualityFlags,
      entityDecisions: entityDecision
        ? { additions: [...entityDecision.additions], exclusions: [...entityDecision.exclusions] }
        : { additions: [], exclusions: [] },
      detectedCodes,
      effectiveCodes,
      codes: effectiveCodes.map((code) => ({ code, category: categoryForCode(code), label: labelFor(code) })),
    });
  }

  // Agrégat par entité après application des décisions documentaires : la
  // frise, le graphe déterministe et les compteurs partagent le même périmètre.
  const entities = new Map();
  for (const document of documents) {
    for (const { code, category, label } of document.codes) {
      let entity = entities.get(code);
      if (!entity) {
        entity = { code, category, label, documents: new Set() };
        entities.set(code, entity);
      }
      entity.documents.add(document.id);
    }
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
    deanonymized: Boolean(deanonymizeLabels),
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
  DOCUMENT_INDEX_VERSION,
  DOCUMENT_INDEX_RELATIVE_PATH,
  MANUAL_OVERRIDE_FLAG,
  applyDocumentIndexCorrection,
  documentIndexFile,
  readDocumentIndex,
  readDocumentIndexOverrides,
  writeDocumentIndexOverride,
  categoryForCode,
  buildChronology,
};

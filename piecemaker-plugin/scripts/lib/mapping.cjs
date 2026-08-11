/**
 * Mapping d'anonymisation d'un dossier juridique — implémentation unique.
 *
 * Trois appelants la partagent, et c'est volontaire : les hooks
 * (`anonymize-read.mjs`, `deanonymize-write.mjs`), le pipeline admin
 * (`websocket-server/originals-pipeline.cjs`) et le routeur du task pane
 * (`taskpane/modules/anonymization-server.cjs`). Le module vit dans le plugin
 * parce que c'est le seul des trois qui soit distribué seul : un hook ne peut
 * require ni `websocket-server/` ni `taskpane/`.
 *
 * Deux sens, jamais symétriques dans leur usage :
 *  - `applyMapping`  entité → code, sur tout ce que l'IA s'apprête à lire ;
 *  - `revertMapping` code → entité, sur tout ce que l'IA produit et qui
 *    atterrit chez un humain (fichier, message Telegram, libellé de commit).
 *
 * Les deux sont idempotents : réappliquer un mapping à un texte déjà codé ne
 * change rien, ce qui permet aux hooks de s'exécuter sans savoir ce qui a déjà
 * été traité.
 */
const fs = require('node:fs');
const path = require('node:path');

const { locateCase, WORKSPACE_SUBDIR } = require('./protection.cjs');
const { locateConfiguredCase } = require('./case-folders.cjs');
const { isInstitutionalEntity } = require('./institutional-terms.cjs');

const CANONICAL_MAPPING_FILE = 'mapping_default.json';

// ─────────────────────────── Correspondance d'entités ───────────────────────
// Repris tel quel de `anonymization-server.cjs`, qui require désormais ce
// module : une seule définition des frontières de mots et des variantes
// Unicode, sinon deux moteurs de substitution divergent silencieusement.

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Longueur en deçà de laquelle une entité n'est jamais substituée, sauf
 * acronyme tout en capitales (voir `buildEntityRegex`). Mesuré sur GENSIGHT_URD :
 * des entités de 2-3 caractères ("CA", "us", "AU", "RU", "ZA") déclenchaient
 * 10 000+ substitutions dont >99 % à l'intérieur de mots sans rapport
 * (capital, business, Faubourg, rue, organization).
 */
const MIN_ENTITY_LENGTH = 4;

/** Caractères de mot, Unicode : le \b de JS est ASCII et casse sur « Motté ». */
const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_])';

/**
 * Ponctuations à plusieurs orthographes Unicode, ramenées à une classe qui les
 * accepte toutes. Pas hypothétique : le scanner normalise le texte des entités
 * en NFKC, qui réécrit U+2011 (trait d'union insécable) en U+2010. GENSIGHT
 * contient « Kreos‑A » en U+2011, le mapping portait donc « Kreos‐A » en U+2010
 * et la substitution ne trouvait rien — une entité détectée puis laissée en
 * clair dans le document livré.
 */
const CHAR_VARIANTS = [
  // trait d'union, tirets, signe moins
  { chars: '-‐‑‒–—―−', class: '[-\\u2010-\\u2015\\u2212]' },
  // apostrophes droites et typographiques — omniprésentes en français
  { chars: "'‘’ʼ´", class: "['\\u2018\\u2019\\u02BC\\u00B4]" },
  // guillemets doubles
  { chars: '"“”«»', class: '["\\u201C\\u201D]' },
];

const VARIANT_OF = new Map();
for (const { chars, class: cls } of CHAR_VARIANTS) {
  for (const c of chars) VARIANT_OF.set(c, cls);
}

/** Échappe un token en remplaçant chaque caractère à variantes par sa classe. */
function escapeWithVariants(token) {
  let out = '';
  for (const ch of token) {
    out += VARIANT_OF.get(ch) || escapeRegex(ch);
  }
  return out;
}

/**
 * Construit la regex qui retrouve une entité dans le texte.
 *
 * Trois propriétés qu'un simple `new RegExp(escapeRegex(x), 'gi')` n'a pas :
 *  1. des frontières de mots — sans elles, une entité de 2 lettres réécrit un
 *     septième du document depuis l'intérieur d'autres mots ;
 *  2. la tolérance aux espaces — les entités extraites du Markdown converti
 *     portent des retours à la ligne, doubles espaces et espaces insécables
 *     (« Board\nof  Directors ») ; échappés littéralement, l'entité ne
 *     correspondait presque nulle part ;
 *  3. la sensibilité à la casse pour les acronymes courts — « EDF »/« BNP »
 *     doivent matcher, mais sans casse « US » attrape aussi le pronom « us ».
 *
 * @returns {RegExp|null} null quand l'entité est trop ambiguë pour être substituée.
 */
function buildEntityRegex(entity) {
  if (typeof entity !== 'string') return null;

  const trimmed = entity.trim();
  if (!trimmed) return null;

  // Au moins une lettre ou un chiffre : de la ponctuation pure n'est pas une entité.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;

  const isShort = trimmed.length < MIN_ENTITY_LENGTH;
  const isAcronym = /^[\p{Lu}\p{N}][\p{Lu}\p{N}.&-]*$/u.test(trimmed);

  // Court et pas acronyme → trop ambigu, on saute.
  if (isShort && (!isAcronym || trimmed.length < 2)) return null;

  const pattern = trimmed
    .split(/\s+/)
    .map(escapeWithVariants)
    .join('\\s+');

  const flags = isShort ? 'gu' : 'giu';
  return new RegExp(WORD_BOUNDARY_BEFORE + pattern + WORD_BOUNDARY_AFTER, flags);
}

/**
 * Ordonne les entrées d'un mapping de la plus longue entité à la plus courte.
 *
 * La substitution est séquentielle : une entité imbriquée ne doit jamais passer
 * avant celle qui la contient. Remplacer LOCATION « French » avant ORGANIZATION
 * « French Monetary and Financial Code » transforme la seconde en
 * « ADRESSE_07 Monetary and Financial Code ».
 */
function byDescendingEntityLength(getEntity) {
  return (a, b) => {
    const la = (getEntity(a) || '').length;
    const lb = (getEntity(b) || '').length;
    return lb - la;
  };
}

// ───────────────────────────── Fichier de mapping ───────────────────────────

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

/**
 * Tous les mappings présents, sous-dossier `WORKSPACE_SUBDIR` **et** racine
 * (lecture tolérante pendant la migration). Le fichier canonique du sous-dossier
 * passe en dernier : c'est lui qui gagne quand `readCaseMapping` fusionne, tandis
 * que les copies legacy (racine ou `mapping_<id>.json`) ne servent qu'à ne rien
 * perdre avant le prochain enregistrement.
 */
function existingMappingFiles(caseRoot) {
  const dirs = [
    { path: path.join(caseRoot, WORKSPACE_SUBDIR), inSubfolder: true },
    { path: caseRoot, inSubfolder: false },
  ];
  const found = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^mapping.*\.json$/i.test(entry.name)) continue;
      found.push({
        full: path.join(dir.path, entry.name),
        name: entry.name,
        // Priorité de fusion croissante : legacy racine < canonique racine <
        // legacy sous-dossier < canonique sous-dossier (dernier, il l'emporte).
        rank: (dir.inSubfolder ? 2 : 0) + (entry.name === CANONICAL_MAPPING_FILE ? 1 : 0),
      });
    }
  }
  return found
    .sort((a, b) => (a.rank - b.rank) || a.name.localeCompare(b.name, 'fr'))
    .map((entry) => entry.full);
}

/**
 * L'unique cible d'écriture par dossier vit désormais dans le sous-dossier
 * `WORKSPACE_SUBDIR`, pour garder la racine propre. Les anciens
 * `mapping_dossier.json` / `mapping_<id>.json` et un `mapping_default.json` resté
 * à la racine sont lus pour migration (voir `existingMappingFiles`), mais toute
 * écriture converge vers `<dossier>/<WORKSPACE_SUBDIR>/mapping_default.json`.
 */
function caseMappingFile(caseRoot) {
  return path.join(caseRoot, WORKSPACE_SUBDIR, CANONICAL_MAPPING_FILE);
}

function cleanMappingString(value) {
  return String(value || '').trim();
}

function normalizePartyAssignments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const assignment = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const variants = [...new Set((Array.isArray(assignment.variants) ? assignment.variants : [])
      .map(cleanMappingString).filter(Boolean))];
    return {
      field: cleanMappingString(assignment.field),
      code: cleanMappingString(assignment.code),
      original_code: cleanMappingString(assignment.original_code),
      category: cleanMappingString(assignment.category),
      principal: cleanMappingString(assignment.principal),
      variants,
    };
  }).filter((assignment) => assignment.code && assignment.variants.length);
}

function normalizeProcedureParty(raw, side) {
  const party = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const type = party.type === 'societe' ? 'societe' : 'personne_physique';
  const allowedPositions = new Set(['demandeur', 'defendeur', 'appelant', 'intime', 'requerant', 'mis_en_cause', 'intervenant', 'autre']);
  const position = allowedPositions.has(party.position) ? party.position : side === 'client' ? 'demandeur' : 'defendeur';
  return {
    type,
    position,
    position_libelle: position === 'autre' ? cleanMappingString(party.position_libelle) : '',
    civilite: type === 'personne_physique' ? cleanMappingString(party.civilite) : '',
    nom: type === 'personne_physique' ? cleanMappingString(party.nom) : '',
    date_naissance: type === 'personne_physique' ? cleanMappingString(party.date_naissance) : '',
    lieu_naissance: type === 'personne_physique' ? cleanMappingString(party.lieu_naissance) : '',
    adresse: type === 'personne_physique' ? cleanMappingString(party.adresse) : '',
    societe_nom: type === 'societe' ? cleanMappingString(party.societe_nom) : '',
    forme_sociale: type === 'societe' ? cleanMappingString(party.forme_sociale) : '',
    siren: type === 'societe' ? cleanMappingString(party.siren) : '',
    siege_social: type === 'societe' ? cleanMappingString(party.siege_social) : '',
    representant: type === 'societe' ? cleanMappingString(party.representant) : '',
    mapping_assignments: normalizePartyAssignments(party.mapping_assignments),
  };
}

function normalizeProcedureInfo(raw) {
  const info = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    parties_clientes: (Array.isArray(info.parties_clientes) ? info.parties_clientes : [])
      .map((party) => normalizeProcedureParty(party, 'client')),
    parties_adverses: (Array.isArray(info.parties_adverses) ? info.parties_adverses : [])
      .map((party) => normalizeProcedureParty(party, 'adversaire')),
  };
}

function normalizeMappingDocument(raw) {
  const document = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mapping = {};
  const reverse = {};
  const source = document.mapping && typeof document.mapping === 'object' ? document.mapping : {};
  // Les entités institutionnelles (juridictions, registres, publications
  // officielles…) sont écartées ici même : c'est le point de passage unique de la
  // lecture comme de l'écriture, si bien qu'une entité bannie ne persiste jamais
  // dans `mapping_default.json` et n'est jamais substituée par les hooks. GLiNER
  // continue de les détecter — on ne débranche que le codage.
  for (const [entity, code] of Object.entries(source)) {
    const from = String(entity || '').trim();
    const to = String(code || '').trim();
    if (from && to && !isInstitutionalEntity(from)) mapping[from] = to;
  }
  const ignored = [...new Set((Array.isArray(document.ignored) ? document.ignored : [])
    .map((entity) => String(entity || '').trim())
    .filter(Boolean))];
  const reverseSource = document.reverse_mapping && typeof document.reverse_mapping === 'object' ? document.reverse_mapping : {};
  for (const [code, value] of Object.entries(reverseSource)) {
    const key = String(code || '').trim();
    if (!key) continue;
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => String(item || '').trim())
      .filter((item) => item && !isInstitutionalEntity(item));
    if (values.length) reverse[key] = [...new Set(values)];
  }
  // Un mapping écrit à la main peut n'avoir que le sens direct : on reconstruit
  // le sens inverse plutôt que de laisser un fichier inutilisable.
  for (const [entity, code] of Object.entries(mapping)) {
    if (!reverse[code]) reverse[code] = [entity];
    else if (!reverse[code].includes(entity)) reverse[code].push(entity);
  }
  // `extracted_data` est écrit par `convert_and_scan_pipeline.py` : c'est lui
  // qui porte les variants d'une entité et l'analyse des adresses, dont la
  // dé-anonymisation partielle a besoin (anonymization-server.cjs).
  // L'administration ne l'édite pas, mais elle ne doit surtout pas le détruire —
  // seules les entrées dont le code a disparu du mapping sont retirées.
  const extracted = {};
  const extractedSource = document.extracted_data && typeof document.extracted_data === 'object'
    && !Array.isArray(document.extracted_data) ? document.extracted_data : {};
  for (const [category, codes] of Object.entries(extractedSource)) {
    if (!codes || typeof codes !== 'object' || Array.isArray(codes)) continue;
    extracted[category] = Object.fromEntries(
      Object.entries(codes).filter(([code]) => reverse[code])
    );
  }
  return {
    mapping,
    reverse_mapping: reverse,
    extracted_data: extracted,
    ignored: ignored.filter((entity) => !mapping[entity]),
    informations_dossier: normalizeProcedureInfo(document.informations_dossier),
  };
}

/** L'ordre d'écriture suit `byDescendingEntityLength`. */
function sortedMapping(mapping) {
  return Object.fromEntries(
    Object.entries(mapping).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], 'fr'))
  );
}

function readCaseMapping(caseRoot) {
  const file = caseMappingFile(caseRoot);
  const sourceFiles = existingMappingFiles(caseRoot);
  if (!sourceFiles.length) {
    return { file, sourceFiles: [], exists: false, ...normalizeMappingDocument(null) };
  }

  // Migration non destructive à la lecture : tous les anciens mappings sont
  // réunis en mémoire. Le canonique passe en dernier et gagne donc si une même
  // entité a été recodée. Le prochain enregistrement écrira l'ensemble dans le
  // seul `mapping_default.json`.
  const mapping = {};
  const preferredVariants = {};
  const extracted_data = {};
  const ignored = [];
  let informations_dossier = normalizeProcedureInfo();
  const readableFiles = [];
  for (const sourceFile of sourceFiles) {
    const raw = readJsonFile(sourceFile, null);
    if (raw === null) continue;
    readableFiles.push(sourceFile);
    const document = normalizeMappingDocument(raw);
    Object.assign(mapping, document.mapping);
    ignored.push(...document.ignored);
    for (const [code, variants] of Object.entries(document.reverse_mapping)) {
      preferredVariants[code] = [...new Set([...(preferredVariants[code] || []), ...variants])];
    }
    for (const [category, codes] of Object.entries(document.extracted_data)) {
      extracted_data[category] = { ...(extracted_data[category] || {}), ...codes };
    }
    if (path.basename(sourceFile) === CANONICAL_MAPPING_FILE
        || document.informations_dossier.parties_clientes.length
        || document.informations_dossier.parties_adverses.length) {
      informations_dossier = document.informations_dossier;
    }
  }

  const reverse_mapping = {};
  for (const [entity, code] of Object.entries(mapping)) {
    if (!reverse_mapping[code]) {
      const preferred = (preferredVariants[code] || []).filter((variant) => mapping[variant] === code);
      reverse_mapping[code] = [...preferred];
    }
    if (!reverse_mapping[code].includes(entity)) reverse_mapping[code].push(entity);
  }
  return {
    file,
    sourceFiles: readableFiles,
    exists: readableFiles.length > 0,
    ...normalizeMappingDocument({ mapping, reverse_mapping, extracted_data, ignored, informations_dossier }),
  };
}

// ──────────────────────────────── Substitution ──────────────────────────────

/**
 * Entité → code. Les entrées passent de la plus longue à la plus courte pour
 * qu'un nom contenu dans un autre ne consomme jamais le plus long en premier
 * (« Dupont » dans « Jean Dupont-Martin »).
 */
function applyMapping(text, mapping) {
  if (typeof text !== 'string' || !text) return text;
  const entries = Object.entries(mapping || {});
  if (!entries.length) return text;

  let output = text;
  for (const [entity, code] of entries.sort(byDescendingEntityLength(([key]) => key))) {
    const regex = buildEntityRegex(entity);
    if (!regex) continue;
    output = output.replace(regex, code);
  }
  return output;
}

/**
 * Code → entité. Le premier variant du tableau fait foi : c'est l'orthographe
 * canonique retenue par `consolidate_duplicate_entities`, celle qu'un humain
 * doit lire.
 *
 * Les codes sont traités du plus long au plus court, sinon
 * `PERSONNE_PHYSIQUE_1` mangerait le préfixe de `PERSONNE_PHYSIQUE_12` et
 * laisserait un « Jean Dupont2 » derrière lui. La frontière de mot ne suffit
 * pas : `2` est un caractère de mot, donc `PERSONNE_PHYSIQUE_1` ne matche pas
 * `PERSONNE_PHYSIQUE_12` — mais le tri reste la garantie qui ne dépend pas de
 * la forme des codes.
 */
function revertMapping(text, reverseMapping) {
  if (typeof text !== 'string' || !text) return text;
  const entries = Object.entries(reverseMapping || {});
  if (!entries.length) return text;

  let output = text;
  for (const [code, variants] of entries.sort(byDescendingEntityLength(([key]) => key))) {
    const canonical = Array.isArray(variants) ? variants[0] : variants;
    if (!canonical) continue;
    // Un code est un identifiant ASCII : pas de variantes Unicode à gérer, mais
    // les mêmes frontières de mots, pour ne pas réécrire un code cité dans un
    // mot plus long.
    const regex = new RegExp(`${WORD_BOUNDARY_BEFORE}${escapeRegex(String(code))}${WORD_BOUNDARY_AFTER}`, 'gu');
    output = output.replace(regex, String(canonical));
  }
  return output;
}

/**
 * Retrouve le mapping du dossier juridique auquel `hint` appartient. `hint` est
 * un chemin de fichier (Read, Write, Edit) ou un répertoire de travail (Bash,
 * Telegram). Retourne `null` hors dossier juridique ou sans mapping utilisable :
 * les hooks n'ont alors rien à faire.
 */
function resolveCaseMapping(casesRoot, hint) {
  const located = locateCase(casesRoot, hint);
  if (!located) return null;
  const mapping = readCaseMapping(located.caseRoot);
  if (!mapping.exists) return null;
  return { caseRoot: located.caseRoot, caseName: located.caseName, ...mapping };
}

/** Resolve a mapping from the explicit folder registry plus legacy workspace. */
function resolveConfiguredCaseMapping(config, hint) {
  const located = locateConfiguredCase(config, hint);
  if (!located) return null;
  const mapping = readCaseMapping(located.caseRoot);
  if (!mapping.exists) return null;
  return { ...located, ...mapping };
}

module.exports = {
  applyMapping,
  buildEntityRegex,
  byDescendingEntityLength,
  caseMappingFile,
  escapeWithVariants,
  normalizeMappingDocument,
  normalizeProcedureInfo,
  readCaseMapping,
  readJsonFile,
  resolveConfiguredCaseMapping,
  resolveCaseMapping,
  revertMapping,
  sortedMapping,
  CANONICAL_MAPPING_FILE,
};

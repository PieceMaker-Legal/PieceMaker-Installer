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
// Le moteur de substitution est extrait dans un module autonome : il est aussi
// requis par le hook central global, distribué hors du plugin. Une seule
// implémentation, ré-exportée ici pour les appelants historiques.
const {
  applyMapping,
  buildEntityRegex,
  byDescendingEntityLength,
  escapeRegex,
  escapeWithVariants,
  revertMapping,
} = require('./substitution.cjs');

const CANONICAL_MAPPING_FILE = 'mapping_default.json';

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

/**
 * Un mapping d'anonymisation exploitable existe-t-il pour ce dossier ? C'est la
 * condition de la garantie « anonymisé à la lecture » : sans lui, `anonymize-read`
 * n'a rien à coder et une surface lisible partirait en clair. `protect-originals`
 * s'en sert pour refuser la lecture d'un dossier PieceMaker pas encore anonymisé.
 * On s'appuie sur `readCaseMapping` (et non sur la seule présence du fichier) pour
 * qu'un `mapping_default.json` illisible compte comme absent — c'est exactement ce
 * que voit `anonymize-read`, qui ne pourrait de toute façon rien en tirer.
 */
function caseHasMapping(caseRoot) {
  return readCaseMapping(caseRoot).exists;
}

// La substitution (`applyMapping` / `revertMapping`) vit dans `substitution.cjs`
// et est importée en tête de fichier. Elle est ré-exportée ci-dessous pour les
// appelants historiques de `mapping.cjs`.

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
  caseHasMapping,
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

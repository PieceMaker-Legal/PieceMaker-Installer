/**
 * Liste globale des entités institutionnelles à ne jamais anonymiser.
 *
 * GLiNER détecte volontiers comme « organisation » des institutions publiques —
 * juridictions, registres, publications officielles, administrations : « Tribunal
 * de Commerce », « Cour de cassation », « Registre du Commerce et des Sociétés »,
 * « BODACC », « RCS »… Ce ne sont pas des données personnelles ; les coder
 * rendrait un acte de procédure illisible et n'apporte aucune protection.
 *
 * On ne débranche pas la détection : GLiNER continue de les trouver. C'est au
 * moment de bâtir le mapping qu'elles sont écartées — `normalizeMappingDocument`
 * (mapping.cjs) appelle `isInstitutionalEntity` sur chaque entité, à la lecture
 * comme à l'écriture. Une entité bannie ne persiste donc jamais dans
 * `mapping_default.json` et n'est jamais substituée par les hooks.
 *
 * La liste est globale (tous dossiers confondus), éditable depuis les paramètres
 * de l'administration, et la comparaison est insensible à la casse et aux
 * accents. Un terme correspond dès qu'il apparaît comme groupe de mots complet
 * dans l'entité : « Tribunal de Commerce » écarte « Tribunal de Commerce de
 * Nanterre ».
 *
 * Le module vit dans le plugin parce que les hooks, distribués seuls, en ont
 * besoin via `mapping.cjs` et ne peuvent require `websocket-server/`.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_VERSION = 1;

function piecemakerHome() {
  return process.env.PIECEMAKER_HOME || path.join(os.homedir(), '.piecemaker');
}

/** Fichier de stockage — global, hors dossier juridique. Surchargeable pour les tests. */
function institutionalTermsFile() {
  return process.env.PIECEMAKER_INSTITUTIONAL_TERMS || path.join(piecemakerHome(), 'institutional-terms.json');
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Forme comparable : sans accents, minuscules, apostrophes et espaces unifiés. */
function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’ʼ´`]/g, "'")
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Forme d'affichage : espaces normalisés, casse et accents d'origine conservés. */
function cleanTerm(value) {
  return String(value || '').replace(/[\s ]+/g, ' ').trim();
}

/** Termes nettoyés, dédupliqués (insensible casse/accents) et triés. */
function dedupeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(terms) ? terms : []) {
    const display = cleanTerm(raw);
    if (!display) continue;
    const key = normalizeForMatch(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out.sort((a, b) => normalizeForMatch(a).localeCompare(normalizeForMatch(b), 'fr'));
}

function readTermsFrom(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.terms) ? raw.terms : [];
    return dedupeTerms(list);
  } catch {
    return [];
  }
}

/** Liste courante et son emplacement — pour l'API d'administration. */
function readInstitutionalTerms() {
  const file = institutionalTermsFile();
  return { file, terms: readTermsFrom(file) };
}

/** Enregistre la liste (nettoyée, dédupliquée, triée) et invalide le cache. */
function writeInstitutionalTerms(terms) {
  const file = institutionalTermsFile();
  const clean = dedupeTerms(terms);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify({ version: STORE_VERSION, terms: clean }, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  cache = null;
  return { file, terms: clean };
}

// ── Détection ────────────────────────────────────────────────────────────────
// `isInstitutionalEntity` est appelé sur chaque entité à chaque lecture de
// mapping (donc à chaque hook Read) : les regex sont compilées une fois et le
// cache est invalidé dès que le fichier change (mtime + taille).

let cache = null;

function statSignature(file) {
  try {
    const stats = fs.statSync(file);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'absent';
  }
}

function compileMatchers(terms) {
  const matchers = [];
  for (const term of terms) {
    const normalized = normalizeForMatch(term);
    if (!normalized) continue;
    const body = normalized.split(' ').map(escapeRegex).join('\\s+');
    // Le terme doit former un groupe de mots complet dans l'entité, jamais un
    // fragment collé à d'autres lettres/chiffres.
    matchers.push(new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u'));
  }
  return matchers;
}

function currentMatchers() {
  const file = institutionalTermsFile();
  const key = `${file}#${statSignature(file)}`;
  if (!cache || cache.key !== key) {
    const terms = readTermsFrom(file);
    cache = { key, terms, matchers: compileMatchers(terms) };
  }
  return cache;
}

/** Vrai si `entity` contient un terme institutionnel banni (casse/accents ignorés). */
function isInstitutionalEntity(entity) {
  const { matchers } = currentMatchers();
  if (!matchers.length) return false;
  const normalized = normalizeForMatch(entity);
  if (!normalized) return false;
  return matchers.some((regex) => regex.test(normalized));
}

module.exports = {
  cleanTerm,
  dedupeTerms,
  institutionalTermsFile,
  isInstitutionalEntity,
  normalizeForMatch,
  readInstitutionalTerms,
  writeInstitutionalTerms,
};

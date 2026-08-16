/**
 * Moteur de substitution d'anonymisation — implémentation unique, sans dépendance.
 *
 * Extrait de `mapping.cjs`, qui le ré-exporte : une seule définition des
 * frontières de mots, des variantes Unicode et du tri longest-entity-first,
 * sinon deux moteurs de substitution divergent silencieusement.
 *
 * Ce fichier ne require RIEN (ni fs, ni les autres modules du plugin). C'est
 * volontaire : le hook central global (`~/.claude/hooks/piecemaker-central-anonymize.mjs`)
 * en a besoin et est distribué hors du plugin ; il en require une copie posée à
 * un emplacement stable (`~/.piecemaker/lib/substitution.cjs`). Garder ce module
 * autonome permet de le copier tel quel sans traîner de chaîne de dépendances.
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

module.exports = {
  applyMapping,
  buildEntityRegex,
  byDescendingEntityLength,
  escapeRegex,
  escapeWithVariants,
  revertMapping,
  MIN_ENTITY_LENGTH,
  WORD_BOUNDARY_BEFORE,
  WORD_BOUNDARY_AFTER,
};

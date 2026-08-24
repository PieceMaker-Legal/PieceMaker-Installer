/**
 * Moteur de substitution d'anonymisation — implémentation unique, sans
 * dépendance au dépôt (modules Node natifs uniquement).
 *
 * Extrait de `mapping.cjs`, qui le ré-exporte : une seule définition des
 * frontières de mots, des variantes Unicode et du tri longest-entity-first,
 * sinon deux moteurs de substitution divergent silencieusement.
 *
 * Le hook central global (`~/.claude/hooks/piecemaker-central-anonymize.mjs`)
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

const fs = require('node:fs');
const path = require('node:path');

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Longueur à partir de laquelle une entité est substituée EN SOUS-CHAÎNE, où
 * qu'elle apparaisse — même collée à d'autres lettres (« dURGOT ») ou soudée par
 * un underscore (« URGOT_SA », forme des noms de fichiers). Sous ce seuil (2
 * caractères), une sous-chaîne réécrirait l'intérieur d'un mot sur sept ("CA"
 * dans "capital", "us" dans "business") : on retombe alors sur un acronyme
 * délimité (voir `buildEntityRegex`). Les codes déjà posés sont protégés en
 * amont par `applyMapping`, donc une sous-chaîne ne peut jamais corrompre un code.
 */
const MIN_ENTITY_LENGTH = 3;

/**
 * Caractères de mot, Unicode : le \b de JS est ASCII et casse sur « Motté ».
 * L'underscore n'en fait PAS partie : il délimite (« US_SA » → « US » est isolé),
 * car les noms de fichiers soudent les termes par « _ ». La protection des codes
 * contre une réécriture interne ne repose plus sur « _ » (il séparait les
 * segments d'un code) mais sur le masquage préalable des codes dans `applyMapping`.
 */
const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}])';
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}])';

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
 *  - ≥ 3 caractères → substitution EN SOUS-CHAÎNE, sans frontière : c'est la
 *    seule façon d'attraper le nom soudé à d'autres caractères, notamment dans
 *    les noms de fichiers (« dURGOT_SA », « CAITLYN_SA »). Sur-coder n'expose
 *    rien ; sous-coder laisse un nom en clair — on penche du côté sûr.
 *  - 2 caractères → acronyme seulement, délimité des deux côtés (un « CA » nu
 *    réécrirait un septième du document depuis l'intérieur d'autres mots).
 *
 * Deux propriétés qu'un simple `new RegExp(escapeRegex(x), 'gi')` n'a pas :
 *  1. la tolérance aux espaces — les entités extraites du Markdown converti
 *     portent des retours à la ligne, doubles espaces et espaces insécables
 *     (« Board\nof  Directors ») ; échappées littéralement, elles ne
 *     correspondaient presque nulle part ;
 *  2. la sensibilité à la casse pour les acronymes de 2 lettres — « US » ne doit
 *     pas attraper le pronom « us ».
 *
 * @returns {RegExp|null} null quand l'entité est trop ambiguë pour être substituée.
 */
function buildEntityRegex(entity) {
  if (typeof entity !== 'string') return null;

  const trimmed = entity.trim();
  if (!trimmed) return null;

  // Au moins une lettre ou un chiffre : de la ponctuation pure n'est pas une entité.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;

  const pattern = trimmed
    .split(/\s+/)
    .map(escapeWithVariants)
    .join('\\s+');

  // ≥ 3 caractères : substitué en sous-chaîne, où qu'il apparaisse. Casse ignorée,
  // car le Markdown converti change la casse d'un même nom. La protection contre
  // la réécriture de l'intérieur d'un code est assurée par le masquage préalable
  // dans applyMapping, pas par des frontières.
  if (trimmed.length >= MIN_ENTITY_LENGTH) {
    return new RegExp(pattern, 'giu');
  }

  // 2 caractères : trop court pour une sous-chaîne. Acronyme seulement, délimité
  // par un non-alphanumérique (espace, underscore, ponctuation ou bord de texte)
  // des deux côtés, et sensible à la casse pour ne pas confondre « US »/« us ».
  const isAcronym = /^[\p{Lu}\p{N}][\p{Lu}\p{N}.&-]*$/u.test(trimmed);
  if (trimmed.length === 2 && isAcronym) {
    return new RegExp(WORD_BOUNDARY_BEFORE + pattern + WORD_BOUNDARY_AFTER, 'gu');
  }
  return null;
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

  // Masquage préalable des codes déjà présents dans le texte. La substitution en
  // sous-chaîne (≥ 3 car.) et l'underscore-séparateur (acronymes 2 car.)
  // pourraient sinon réécrire l'intérieur d'un code — « SA » dans « URGOT SA »,
  // « Moral » dans « PERSONNE_MORALE_01 » — et le corrompre. Chaque code distinct
  // est remplacé par un caractère de zone privée (ni lettre ni chiffre, absent des
  // documents, jamais matché par une regex d'entité), on anonymise, puis on
  // restaure. C'est aussi ce qui garantit l'idempotence : réappliquer le mapping à
  // un texte déjà codé masque ses codes et ne touche à rien. Codes triés du plus
  // long au plus court pour qu'un code contenu dans un autre ne soit pas masqué
  // en premier.
  const codes = [...new Set(entries.map(([, code]) => String(code)).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const restore = [];
  let masked = text;
  codes.forEach((code, idx) => {
    if (!masked.includes(code)) return;
    const token = String.fromCodePoint(0xE000 + idx);
    restore.push([token, code]);
    masked = masked.split(code).join(token);
  });

  let output = masked;
  for (const [entity, code] of entries.sort(byDescendingEntityLength(([key]) => key))) {
    const regex = buildEntityRegex(entity);
    if (!regex) continue;
    output = output.replace(regex, code);
  }

  for (const [token, code] of restore) output = output.split(token).join(code);
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

function normalizedPathName(value) {
  return String(value || '').normalize('NFC');
}

function pathExists(value) {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

/**
 * Résout un chemin codé vers le fichier réellement présent sur disque.
 *
 * Un code peut représenter plusieurs variantes d'une même entité. Le premier
 * élément du reverse mapping est canonique pour du texte produit, mais il ne
 * permet donc pas toujours de reconstruire un nom de fichier existant. La
 * résolution suit cet ordre, du plus déterministe au plus prudent :
 *
 *  1. le chemin littéral existe déjà (un fichier peut lui-même porter le code) ;
 *  2. le chemin obtenu par ré-identification canonique existe ;
 *  3. chaque segment manquant est recherché parmi les enfants du répertoire
 *     courant, et accepté seulement si UN SEUL nom s'anonymise vers le segment
 *     demandé.
 *
 * Si aucune correspondance unique n'existe, le chemin codé d'origine est
 * conservé. L'outil échouera alors avec un code, plutôt que de recevoir un nom
 * réel inventé ou le mauvais fichier.
 */
function resolveMappedPath(value, mapping, reverseMapping, cwd = process.cwd()) {
  if (typeof value !== 'string' || !value) return value;

  const base = typeof cwd === 'string' && cwd ? path.resolve(cwd) : process.cwd();
  const requestedAbsolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
  if (pathExists(requestedAbsolute)) return value;

  const canonical = revertMapping(value, reverseMapping);
  const canonicalAbsolute = path.isAbsolute(canonical)
    ? path.resolve(canonical)
    : path.resolve(base, canonical);
  if (canonical !== value && pathExists(canonicalAbsolute)) return canonical;

  const parsed = path.parse(requestedAbsolute);
  const segments = requestedAbsolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    const literal = path.join(current, segment);
    if (pathExists(literal)) {
      current = literal;
      continue;
    }

    const canonicalSegment = revertMapping(segment, reverseMapping);
    const canonicalCandidate = path.join(current, canonicalSegment);
    if (canonicalSegment !== segment && pathExists(canonicalCandidate)) {
      current = canonicalCandidate;
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return value;
    }

    const expected = normalizedPathName(segment);
    const matches = entries.filter((entry) => (
      normalizedPathName(applyMapping(entry.name, mapping)) === expected
    ));
    if (matches.length !== 1) return value;
    current = path.join(current, matches[0].name);
  }

  return path.isAbsolute(value) ? current : (path.relative(base, current) || '.');
}

module.exports = {
  applyMapping,
  buildEntityRegex,
  byDescendingEntityLength,
  escapeRegex,
  escapeWithVariants,
  resolveMappedPath,
  revertMapping,
  MIN_ENTITY_LENGTH,
  WORD_BOUNDARY_BEFORE,
  WORD_BOUNDARY_AFTER,
};

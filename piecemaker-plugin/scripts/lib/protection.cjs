/**
 * Protection des pièces d'un dossier juridique — par fichier, pas par dossier.
 *
 * L'ancienne règle protégeait le contenu d'un sous-dossier « Pièces
 * originales ». Elle ne protégeait donc rien dans un dossier organisé
 * autrement, ce qui est le cas courant : les PDF et DOCX y côtoient le Markdown
 * qu'on en a tiré. La protection est désormais une propriété du fichier,
 * décidée dans l'administration.
 *
 * **Protégé par défaut.** Le fichier `.piecemaker/protection.json` d'un dossier
 * n'enregistre que les *exceptions* — ce que l'utilisateur a explicitement
 * libéré. Une pièce déposée entre deux passages dans l'administration est donc
 * protégée sans action de sa part ; l'inverse (une liste de ce qu'il faut
 * protéger) laisserait fuiter tout nouveau document.
 *
 * `.md` et `.json` ne sont jamais protégés : ce sont les surfaces que le proxy
 * anonymise avant chaque appel LLM.
 *
 * Une exception, portée par `isMappingFile` : le mapping du dossier et les scans
 * PII sont interdits à l'IA en toute circonstance. Ils ne passent pas par
 * `isProtectedFile` — l'historique du cabinet doit continuer à versionner le
 * mapping (`commits.cjs`) — mais par un refus dédié dans `protect-originals.mjs`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { structuredMarkdownCounterpart } = require('./case-folder-structure.cjs');

const PROTECTION_DIR = '.piecemaker';
const PROTECTION_FILE = 'protection.json';

/**
 * Sous-dossier technique historique et emplacement du `mapping_default.json`.
 * Le Markdown courant vit dans les sous-dossiers de conversion de
 * Correspondance et Data Room ; ce repli reste nécessaire aux anciens dossiers
 * et aux espaces de travail OOXML. `mapping.cjs` et `commits.cjs` l'importent.
 */
const WORKSPACE_SUBDIR = 'Fichiers convertis PieceMaker';

/**
 * Suffixe d'un sous-dossier de travail OOXML : une copie extraite d'un `.docx`
 * (`unzip`), rangée sous `WORKSPACE_SUBDIR`. Ses parties (`word/document.xml`,
 * `_rels`, médias…) ne sont ni `.md` ni `.json` : sans règle dédiée elles
 * tomberaient dans le coffre-fort et l'édition OOXML serait impossible. On les
 * classe donc d'office en espace de travail (voir `isOoxmlWorkspacePath`).
 */
const OOXML_WORKDIR_SUFFIX = '-ooxml';

/** Extensions lisibles par l'IA, sous réserve du mapping appliqué à la lecture. */
const READABLE_EXTENSIONS = new Set(['.md', '.json']);

/**
 * JSON qui trahiraient la frontière s'ils étaient lus :
 *  - `mapping*.json` fait correspondre chaque code au nom réel — le lire, c'est
 *    dé-anonymiser le dossier entier d'un seul appel d'outil ;
 *  - `*_sensitive_map.json` est une ancienne sortie brute de GLiNER/Presidio.
 *    Le pipeline actuel la garde en espace temporaire, mais un ancien dossier
 *    peut encore en porter pendant sa migration.
 *
 * Appliquer le mapping à leur lecture ne suffirait pas : les entités trop courtes,
 * celles rangées sous `ignored` et les variantes d'`extracted_data` ressortiraient
 * telles quelles. Le seul traitement correct est le refus.
 */
const FORBIDDEN_JSON_PATTERNS = [/^mapping.*\.json$/i, /_sensitive_map\.json$/i, /^central-mapping\.json$/i];

/** Vrai pour un mapping de dossier ou un scan PII, où qu'il soit rangé. */
function isMappingFile(filePath) {
  const base = path.basename(String(filePath || ''));
  return FORBIDDEN_JSON_PATTERNS.some((pattern) => pattern.test(base));
}

function normalizeOriginalName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/** Clé stable reliant une pièce à son Markdown et à son scan PII. */
function documentKey(filePath) {
  return normalizeOriginalName(path.basename(filePath, path.extname(filePath))).replaceAll(' ', '-');
}

function protectionFile(caseRoot) {
  return path.join(caseRoot, PROTECTION_DIR, PROTECTION_FILE);
}

/**
 * Résout les liens symboliques en remontant jusqu'au premier ancêtre existant,
 * puis en rattachant le reste du chemin. Un chemin qui n'existe pas encore (le
 * Markdown attendu d'une pièce, un sous-dossier à créer) doit se comparer à une
 * racine résolue, sinon `/var/…` et `/private/var/…` ne se recouvrent jamais
 * sur macOS et le dossier passe pour hors racine.
 */
function realpathOrParent(target) {
  let current = target;
  const tail = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return path.join(fs.realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return target;
}

/**
 * Chemin relatif au dossier, séparateurs POSIX — la forme stockée et échangée.
 * Les deux côtés sont résolus : comparer un `/var/…` à un `/private/var/…`
 * (macOS) donnait un chemin remontant hors du dossier, donc « non protégé ».
 */
function relativeKey(absolutePath, caseRoot) {
  const relative = path.relative(realpathOrParent(path.resolve(caseRoot)), realpathOrParent(path.resolve(absolutePath)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Situe un chemin dans la racine PieceMaker : chaque enfant direct de cette
 * racine est un dossier juridique indépendant. Retourne `null` hors racine, ce
 * qui est le cas de la grande majorité des appels d'outil — c'est le chemin
 * rapide des hooks.
 */
function locateCase(casesRoot, target) {
  if (!casesRoot || !target) return null;
  let root;
  try {
    root = fs.realpathSync(path.resolve(String(casesRoot)));
  } catch {
    return null;
  }
  // Les deux côtés doivent être résolus : sur macOS `/var/…` est un lien vers
  // `/private/var/…`, si bien qu'une racine résolue et une cible qui ne l'est
  // pas ne se recouvrent jamais — le dossier passait alors pour hors racine et
  // rien n'était protégé.
  const absolute = realpathOrParent(path.resolve(String(target)));
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) return null;
  const [caseName, ...rest] = path.relative(root, absolute).split(path.sep);
  if (!caseName || caseName.startsWith('.')) return null;
  const caseRoot = path.join(root, caseName);
  try {
    if (!fs.statSync(caseRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  return { casesRoot: root, caseName, caseRoot, absolute, relative: rest.join('/') };
}

/** Normalise une liste de chemins relatifs en Set de clés POSIX. */
function normalizeKeySet(list) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((entry) => String(entry || '').replaceAll('\\', '/').trim())
      .filter(Boolean)
  );
}

/**
 * Trois états possibles pour une pièce, encodés comme deux listes d'exceptions
 * dans `protection.json` (le défaut, liste vide, est le coffre-fort) :
 *  - **Coffre-fort** : hors des deux listes — protégé, l'IA ne lit que le `.md` ;
 *  - **Espace de travail** : dans `unprotected` — accessible, anonymisé à la
 *    lecture par les hooks ;
 *  - **Ressource** : dans `resources` — accessible, et exclu du scan GLiNER et de
 *    la conversion Markdown (documents publics sans donnée personnelle).
 */
function readProtection(caseRoot) {
  const file = protectionFile(caseRoot);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    raw = null;
  }
  return {
    file,
    exists: raw !== null,
    unprotected: normalizeKeySet(raw?.unprotected),
    resources: normalizeKeySet(raw?.resources),
  };
}

/**
 * Écrit les deux listes d'exceptions. Une liste laissée à `undefined` est
 * *préservée* (relue depuis le disque) : un appelant historique qui ne connaît
 * que `unprotected` — l'initialisation d'un dossier — n'efface pas les
 * ressources déjà déclarées.
 */
function writeProtection(caseRoot, { unprotected, resources } = {}) {
  const file = protectionFile(caseRoot);
  const existing = readProtection(caseRoot);
  const clean = (list, fallback) => [...new Set(
    (Array.isArray(list) ? list : [...fallback])
      .map((entry) => String(entry || '').replaceAll('\\', '/').trim())
      .filter((entry) => entry && !entry.startsWith('../') && !path.isAbsolute(entry))
  )].sort((a, b) => a.localeCompare(b, 'fr'));
  // Une pièce ne peut être à la fois « espace de travail » et « ressource » :
  // `resources` a priorité, on la retire donc de `unprotected`.
  const resourcesList = clean(resources, existing.resources);
  const resourceSet = new Set(resourcesList);
  const unprotectedList = clean(unprotected, existing.unprotected).filter((key) => !resourceSet.has(key));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ version: 1, unprotected: unprotectedList, resources: resourcesList }, null, 2)}\n`,
    'utf8'
  );
  return { file, unprotected: new Set(unprotectedList), resources: resourceSet };
}

/** Vrai pour un chemin recevable dans une des deux listes d'exceptions. */
function exceptionKey(absolutePath, caseRoot) {
  const key = relativeKey(absolutePath, caseRoot);
  if (!key) return null;
  // Les dotfiles sont de la configuration du dossier, jamais des pièces —
  // `.piecemaker/protection.json` inclus, qui doit rester lisible par l'admin.
  if (key.split('/').some((segment) => segment.startsWith('.'))) return null;
  if (READABLE_EXTENSIONS.has(path.extname(key).toLowerCase())) return null;
  return key;
}

/**
 * Vrai pour un chemin situé dans un sous-dossier de travail OOXML — la copie
 * extraite d'un `.docx`, rangée sous `WORKSPACE_SUBDIR` dans un sous-dossier
 * dont le nom finit par `OOXML_WORKDIR_SUFFIX`. Tout son sous-arbre est classé
 * espace de travail (accessible, filtré à la lecture) sans inscription dans
 * `protection.json`. Le `.docx` original n'est pas dans ce sous-dossier : il
 * reste protégé. Seul un *dossier* intermédiaire compte — un fichier isolé
 * nommé `…-ooxml` sous `WORKSPACE_SUBDIR` reste, lui, protégé.
 */
function isOoxmlWorkspacePath(absolutePath, caseRoot) {
  const key = relativeKey(absolutePath, caseRoot);
  if (!key) return false;
  const segments = key.split('/');
  if (segments[0] !== WORKSPACE_SUBDIR) return false;
  return segments.slice(1, -1).some((segment) => segment.toLowerCase().endsWith(OOXML_WORKDIR_SUFFIX));
}

/**
 * Un fichier est protégé s'il est dans le dossier, qu'il n'est ni Markdown ni
 * JSON, et qu'il ne figure dans *aucune* des deux listes d'exceptions (espace
 * de travail ou ressource, toutes deux accessibles à l'IA). `state` évite de
 * relire le fichier d'exceptions à chaque appel dans une boucle.
 */
function isProtectedFile(absolutePath, caseRoot, state = null) {
  if (!absolutePath || !caseRoot) return false;
  const key = exceptionKey(absolutePath, caseRoot);
  if (!key) return false;
  // Copie extraite d'un .docx : espace de travail implicite, jamais coffre-fort.
  if (isOoxmlWorkspacePath(absolutePath, caseRoot)) return false;
  const { unprotected, resources } = state || readProtection(caseRoot);
  return !unprotected.has(key) && !(resources && resources.has(key));
}

/**
 * Vrai pour une pièce marquée « ressource » : accessible à l'IA et exclue du
 * scan GLiNER comme de la conversion Markdown.
 */
function isResourceFile(absolutePath, caseRoot, state = null) {
  if (!absolutePath || !caseRoot) return false;
  const key = exceptionKey(absolutePath, caseRoot);
  if (!key) return false;
  const { resources } = state || readProtection(caseRoot);
  return Boolean(resources && resources.has(key));
}

/**
 * Le Markdown à lire à la place d'une pièce protégée. Les dossiers structurés
 * l'écrivent dans la zone de conversion de Correspondance ou Data Room ; les
 * anciens dossiers utilisent encore `WORKSPACE_SUBDIR`, la racine ou le dossier
 * de la pièce. À défaut, le chemin attendu rend le refus actionnable.
 */
function markdownCounterpart(absolutePath, caseRoot) {
  const stem = path.basename(absolutePath, path.extname(absolutePath));
  const structured = structuredMarkdownCounterpart(absolutePath, caseRoot);
  const workspaceMarkdown = path.join(caseRoot, WORKSPACE_SUBDIR, `${stem}.md`);
  const candidates = [
    ...(structured ? [structured.path] : []),
    workspaceMarkdown,
    path.join(path.dirname(absolutePath), `${stem}.md`),
    path.join(caseRoot, `${stem}.md`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, exists: true };
  }
  // Repli : une conversion antérieure a pu normaliser le nom (accents, casse).
  const key = documentKey(absolutePath);
  for (const dir of [path.join(caseRoot, WORKSPACE_SUBDIR), caseRoot]) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
        if (documentKey(entry.name) === key) return { path: path.join(dir, entry.name), exists: true };
      }
    } catch {
      // dossier illisible : on essaie l'emplacement suivant
    }
  }
  return structured || { path: workspaceMarkdown, exists: false };
}

/**
 * Classe une pièce en « espace de travail » : accessible à l'IA, anonymisée à
 * la lecture. C'est l'écriture ciblée dont a besoin le hook
 * `classify-ai-documents.mjs` — un document produit par l'IA n'a aucune raison
 * de naître au coffre-fort, elle ne pourrait plus se relire.
 *
 * Ne fait rien, et retourne pourquoi, quand le chemin n'est pas une pièce
 * classable : hors dossier, `.md`/`.json` (déjà lisibles), dotfile, mapping ou
 * scan PII (jamais déclassés), espace de travail OOXML implicite, ou clé déjà
 * inscrite. `resources` est prioritaire : une ressource n'est jamais
 * rétrogradée en espace de travail. Idempotent, ne lève jamais.
 */
function classifyAsWorkspace(absolutePath, caseRoot) {
  try {
    if (!absolutePath || !caseRoot) return { classified: false, key: null, reason: 'arguments' };
    if (isMappingFile(absolutePath)) return { classified: false, key: null, reason: 'mapping' };
    const key = exceptionKey(absolutePath, caseRoot);
    if (!key) return { classified: false, key: null, reason: 'non-classable' };
    if (isOoxmlWorkspacePath(absolutePath, caseRoot)) return { classified: false, key, reason: 'ooxml' };
    const { unprotected, resources } = readProtection(caseRoot);
    if (resources.has(key)) return { classified: false, key, reason: 'ressource' };
    if (unprotected.has(key)) return { classified: false, key, reason: 'déjà classée' };
    writeProtection(caseRoot, { unprotected: [...unprotected, key] });
    return { classified: true, key, reason: null };
  } catch (error) {
    return { classified: false, key: null, reason: error?.message || 'erreur' };
  }
}

module.exports = {
  classifyAsWorkspace,
  documentKey,
  exceptionKey,
  isMappingFile,
  locateCase,
  isProtectedFile,
  isOoxmlWorkspacePath,
  isResourceFile,
  markdownCounterpart,
  normalizeOriginalName,
  protectionFile,
  readProtection,
  relativeKey,
  writeProtection,
  PROTECTION_DIR,
  PROTECTION_FILE,
  READABLE_EXTENSIONS,
  FORBIDDEN_JSON_PATTERNS,
  WORKSPACE_SUBDIR,
  OOXML_WORKDIR_SUFFIX,
};

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
 * `.md` et `.json` ne sont jamais protégés : ce sont les surfaces que les hooks
 * anonymisent à la volée (`anonymize-read.mjs`).
 *
 * Une exception, portée par `isMappingFile` : le mapping du dossier et les scans
 * PII sont interdits à l'IA en toute circonstance. Ils ne passent pas par
 * `isProtectedFile` — l'historique du cabinet doit continuer à versionner le
 * mapping (`commits.cjs`) — mais par un refus dédié dans `protect-originals.mjs`.
 */
const fs = require('node:fs');
const path = require('node:path');

const PROTECTION_DIR = '.piecemaker';
const PROTECTION_FILE = 'protection.json';

/**
 * Sous-dossier où le pipeline range les fichiers *produits* (Markdown converti
 * et `mapping_default.json`), pour que la racine du dossier juridique ne garde
 * que les originaux et les documents de travail. La constante vit ici parce que
 * le plugin est distribué seul : les hooks en dépendent et ne peuvent pas
 * requérir `websocket-server/`. `mapping.cjs` et `commits.cjs` l'importent.
 */
const WORKSPACE_SUBDIR = 'Fichiers convertis PieceMaker';

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

function readProtection(caseRoot) {
  const file = protectionFile(caseRoot);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    raw = null;
  }
  const list = Array.isArray(raw?.unprotected) ? raw.unprotected : [];
  const unprotected = new Set(
    list
      .map((entry) => String(entry || '').replaceAll('\\', '/').trim())
      .filter(Boolean)
  );
  return { file, exists: raw !== null, unprotected };
}

function writeProtection(caseRoot, { unprotected = [] } = {}) {
  const file = protectionFile(caseRoot);
  const list = [...new Set(
    (Array.isArray(unprotected) ? unprotected : [])
      .map((entry) => String(entry || '').replaceAll('\\', '/').trim())
      .filter((entry) => entry && !entry.startsWith('../') && !path.isAbsolute(entry))
  )].sort((a, b) => a.localeCompare(b, 'fr'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, unprotected: list }, null, 2)}\n`, 'utf8');
  return { file, unprotected: new Set(list) };
}

/**
 * Un fichier est protégé s'il est dans le dossier, qu'il n'est ni Markdown ni
 * JSON, et qu'il ne figure pas dans les exceptions. `state` évite de relire le
 * fichier d'exceptions à chaque appel dans une boucle.
 */
function isProtectedFile(absolutePath, caseRoot, state = null) {
  if (!absolutePath || !caseRoot) return false;
  const key = relativeKey(absolutePath, caseRoot);
  if (!key) return false;
  // Les dotfiles sont de la configuration du dossier, jamais des pièces —
  // `.piecemaker/protection.json` inclus, qui doit rester lisible par l'admin.
  if (key.split('/').some((segment) => segment.startsWith('.'))) return false;
  if (READABLE_EXTENSIONS.has(path.extname(key).toLowerCase())) return false;
  const { unprotected } = state || readProtection(caseRoot);
  return !unprotected.has(key);
}

/**
 * Le Markdown à lire à la place d'une pièce protégée. Le pipeline écrit le `.md`
 * dans le sous-dossier `WORKSPACE_SUBDIR`, mais d'anciens dossiers l'ont encore à
 * la racine (ou à côté de la pièce). On regarde le sous-dossier d'abord, puis les
 * emplacements historiques, et à défaut on renvoie l'emplacement *attendu* (le
 * sous-dossier) pour que le message de refus reste actionnable.
 */
function markdownCounterpart(absolutePath, caseRoot) {
  const stem = path.basename(absolutePath, path.extname(absolutePath));
  const workspaceMarkdown = path.join(caseRoot, WORKSPACE_SUBDIR, `${stem}.md`);
  const candidates = [
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
  return { path: workspaceMarkdown, exists: false };
}

module.exports = {
  documentKey,
  isMappingFile,
  locateCase,
  isProtectedFile,
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
};

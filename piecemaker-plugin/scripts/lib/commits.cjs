/** Git commit history for independent PieceMaker legal matters. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const { Worker } = require('node:worker_threads');

const {
  documentKey,
  isProtectedFile,
  isResourceFile,
  readProtection,
  WORKSPACE_SUBDIR,
} = require('./protection.cjs');
const {
  isAnonymizedEntry,
  isConvertedEntry,
  readAnonymizationState,
  stateKey,
} = require('./anonymization-state.cjs');
const { formatDurationFr } = require('./session-timing.cjs');

const fsp = fs.promises;

// Root commits (first commit of a case, diffed against the empty tree) can
// produce patches well into the tens of MB even though only MAX_PATCH_BYTES
// of it is ever kept (see revisionDetails/worktreeDetails). This ceiling only
// exists to bound memory on a runaway/corrupt diff, so it must stay well
// above realistic patch sizes — a 16MB cap was killing legitimate large
// root-commit diffs (e.g. ~33MB) and turning them into a 400 error.
const MAX_GIT_BUFFER = 128 * 1024 * 1024;
const MAX_PATCH_BYTES = 768 * 1024;
const MAX_SAFE_FILES = 10_000;
const MAX_SAFE_BYTES = 250 * 1024 * 1024;
const HISTORY_REF = 'refs/heads/main';
const LEGACY_HISTORY_REF = 'refs/heads/checkpoints';
// Le hook PostToolUse commite à chaque Write/Edit : un mois d'activité peut
// donc contenir des milliers de commits. `listHistory` plafonne à 250 pour un
// affichage récent ; l'export mensuel a besoin de tout, mais reste borné pour
// ne jamais renvoyer un volume qui exploserait MAX_GIT_BUFFER.
const MAX_HISTORY_PERIOD_COMMITS = 5000;
const SAFE_EXTENSIONS = new Set(['.md', '.json']);
const DOCX_MANIFEST_PATH = '.piecemaker/history-docx-ooxml.json';
const DOCX_MANIFEST_VERSION = 1;
const DOCX_FINGERPRINT_ALGORITHM = 'ooxml-central-directory-crc32-v1';
const MAX_DOCX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_DOCX_PARTS = 20_000;
const MAX_DOCX_TEXT_XML_BYTES = 32 * 1024 * 1024;
const TECHNICAL_CASE_NAMES = new Set(['piecemaker_output']);
/**
 * Arborescences techniques jamais parcourues. Un dossier juridique finit par
 * héberger autre chose que des pièces : le dossier de test embarque une copie
 * complète d'un projet Node, dont les 53 000 fichiers noyaient la liste de
 * l'administration (47 000 entrées) et faisaient entrer les `package.json` de
 * `node_modules` dans l'historique du dossier.
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', '__pycache__', 'venv',
]);
/** Plafond de la liste de l'administration ; au-delà, `truncated` le signale. */
const MAX_ORIGINALS = 2000;
const PERF_SLOW_MS = 250;
const PERF_LOG_ALL = process.env.PIECEMAKER_PERF_LOG === '1';
const COMMIT_USER_NAME_KEY = 'PIECEMAKER_USER_NAME';
const TECHNICAL_COMMIT_EMAIL = 'commits@piecemaker.local';
const GLOBAL_ENV_FILE = path.resolve(__dirname, '..', '..', '..', '.env');
// Identité de commit partagée par tous les clones. `GLOBAL_ENV_FILE` est résolu
// relativement à ce module : lancé depuis le cache du plugin (hook d'édition),
// il pointe à côté du clone runtime et n'existe pas — le `.env` de l'identité
// vit dans le clone runtime, hors de portée. `config.json` sous ~/.piecemaker
// est le seul emplacement stable que le hook lit à coup sûr, quel que soit le
// clone d'où il tourne.
const IDENTITY_CONFIG_FILE = path.join(os.homedir(), '.piecemaker', 'config.json');
const inflateRaw = promisify(zlib.inflateRaw);
const deflateRaw = promisify(zlib.deflateRaw);

function validateCommitUserName(value) {
  const cleaned = String(value || '').trim();
  if (!cleaned) {
    throw new Error('Identité utilisateur absente : renseignez votre nom dans les paramètres administrateur.');
  }
  if (cleaned.length > 160 || /[\x00-\x1f\x7f<>]/.test(cleaned)) {
    throw new Error('Nom utilisateur invalide pour la signature des commits.');
  }
  return cleaned;
}

function unquoteEnvValue(value) {
  const raw = String(value || '').trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function readCommitIdentityEnv(file = GLOBAL_ENV_FILE) {
  let value = '';
  try {
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*PIECEMAKER_USER_NAME\s*=(.*)$/);
        if (match) value = unquoteEnvValue(match[1]);
      }
    }
  } catch {
    // Le processus peut encore avoir reçu l'identité depuis son environnement.
  }
  return value || process.env[COMMIT_USER_NAME_KEY] || '';
}

/** Nom de l'utilisateur mémorisé dans ~/.piecemaker/config.json (tous clones). */
function readCommitIdentityConfig(file = IDENTITY_CONFIG_FILE) {
  try {
    if (file && fs.existsSync(file)) {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const name = config?.commits?.userName ?? config?.userName;
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
  } catch {
    // Config illisible : on retombe sur les autres sources d'identité.
  }
  return '';
}

/** Identité personnelle appliquée à l'auteur et au validateur Git. */
function resolveCommitIdentity({ identity = null, envFile = GLOBAL_ENV_FILE, configFile = IDENTITY_CONFIG_FILE } = {}) {
  const requestedName = typeof identity === 'string' ? identity : identity?.name;
  // Sans identité explicite (hook d'édition), on tente le `.env` du clone
  // courant puis, à défaut, config.json — le hook tourne depuis le cache du
  // plugin où `envFile` par défaut n'existe pas.
  const name = validateCommitUserName(
    identity ? requestedName : readCommitIdentityEnv(envFile) || readCommitIdentityConfig(configFile)
  );
  return {
    name,
    // Git exige une adresse dans son format d'identité, mais PieceMaker ne
    // collecte aucune adresse personnelle pour signer les tâches.
    email: TECHNICAL_COMMIT_EMAIL,
  };
}

/**
 * Journal de performance volontairement compact : aucun contenu de dossier ni
 * argument Git n'est journalisé. Les opérations lentes sont visibles par
 * défaut ; PIECEMAKER_PERF_LOG=1 affiche aussi les étapes rapides pendant un
 * diagnostic ponctuel.
 */
function logPerformance(operation, startedAt, details = {}, slowMs = PERF_SLOW_MS) {
  const durationMs = Number((performance.now() - startedAt).toFixed(1));
  if (PERF_LOG_ALL || durationMs >= slowMs) {
    const write = durationMs >= slowMs ? console.warn : console.log;
    write(`[PM-PERF] ${operation}`, { durationMs, ...details });
  }
  return durationMs;
}

async function runGit(cwd, args, {
  gitDir,
  workTree,
  env = {},
  input,
  allowFailure = false,
  encoding = 'utf8',
  maxOutputBytes = MAX_GIT_BUFFER,
  truncateOutput = false,
} = {}) {
  const startedAt = performance.now();
  const command = [
    ...(gitDir ? [`--git-dir=${gitDir}`] : []),
    ...(workTree ? [`--work-tree=${workTree}`] : []),
    '-c',
    'core.quotePath=false',
    ...args,
  ];
  // `spawn` plutôt que `spawnSync` : le serveur d'administration sert aussi le
  // task pane et le WebSocket depuis la même boucle d'événements, qu'un git
  // synchrone bloquerait le temps du parcours complet du dossier.
  return new Promise((resolve, reject) => {
    const child = spawn('git', command, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let failure = null;
    let truncated = false;

    child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const nextBytes = outBytes + chunk.length;
      if (nextBytes > maxOutputBytes) {
        if (truncateOutput) {
          const remaining = Math.max(maxOutputBytes - outBytes, 0);
          if (remaining) outChunks.push(chunk.subarray(0, remaining));
          outBytes += remaining;
          truncated = true;
          child.kill();
          return;
        }
        if (!failure) {
          failure = new Error(`git ${args[0]} a produit une sortie trop volumineuse`);
          child.kill();
        }
        return;
      }
      outBytes = nextBytes;
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => errChunks.push(chunk));
    child.on('error', (error) => { failure = failure || error; });
    child.on('close', (code) => {
      const rawStdout = Buffer.concat(outChunks);
      const rawStderr = Buffer.concat(errChunks).toString('utf8');
      const stdout = encoding === null ? rawStdout : rawStdout.toString('utf8').trimEnd();
      const stderr = encoding === null ? rawStderr : rawStderr.trim();
      const status = failure ? null : truncated && truncateOutput ? 0 : code;
      logPerformance('git', startedAt, {
        command: args[0] || 'unknown',
        status: status ?? 1,
        stdoutBytes: rawStdout.length,
        truncated,
      });
      if (!allowFailure && ((status ?? 1) !== 0 || failure)) {
        reject(new Error(stderr.trim() || rawStdout.toString('utf8') || failure?.message || `git ${args[0]} a échoué`));
        return;
      }
      resolve({ code: status ?? 1, stdout, stderr, error: failure, truncated });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

/** `PieceMaker_Output` et consorts ne sont pas des dossiers juridiques. */
function isTechnicalCaseDirectoryName(value) {
  return TECHNICAL_CASE_NAMES.has(String(value || '').trim().toLowerCase());
}

function isIgnoredDirectoryName(value) {
  const name = String(value || '').trim().toLowerCase();
  return IGNORED_DIRECTORY_NAMES.has(name) || TECHNICAL_CASE_NAMES.has(name);
}

function isDocxPath(value) {
  return path.extname(String(value || '')).toLowerCase() === '.docx';
}

function emptyDocxManifest() {
  return { version: DOCX_MANIFEST_VERSION, algorithm: DOCX_FINGERPRINT_ALGORITHM, files: {} };
}

function findZipEnd(buffer) {
  const first = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

async function parseCentralDirectory(buffer, entries) {
  if (entries > MAX_DOCX_PARTS) return null;
  const parts = [];
  let offset = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return null;
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16).toString(16).padStart(8, '0');
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    if (next > buffer.length) return null;
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength)
      .toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
      .replaceAll('\\', '/');
    if (name && !name.endsWith('/')) {
      parts.push({
        name,
        crc32,
        size,
        compressedSize,
        compression,
        localOffset: buffer.readUInt32LE(offset + 42),
      });
    }
    offset = next;
    if (index > 0 && index % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  parts.sort((left, right) => left.name.localeCompare(right.name));
  return parts;
}

/** Empreinte canonique des entrées OOXML, indépendante du conteneur ZIP. */
async function fingerprintCentralDirectory(buffer, entries) {
  const parts = await parseCentralDirectory(buffer, entries);
  if (!parts) return null;
  const hash = crypto.createHash('sha256');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    hash.update(`${part.name}\0${part.crc32}\0${part.size}\n`);
    if (index > 0 && index % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { fingerprint: hash.digest('hex'), format: 'ooxml', partCount: parts.length };
}

const docxFingerprintCache = new Map();
const docxTreeCache = new Map();
const docxTextCache = new Map();

function boundedCacheSet(cache, key, value, max) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  if (cache.size > max) cache.delete(cache.keys().next().value);
}

function docxStat(stat) {
  return {
    size: stat.size,
    mtimeMs: Number(stat.mtimeMs.toFixed(3)),
    ctimeMs: Number(stat.ctimeMs.toFixed(3)),
  };
}

function sameDocxStat(entry, stat) {
  return entry?.size === stat.size && entry?.mtimeMs === stat.mtimeMs && entry?.ctimeMs === stat.ctimeMs;
}

async function readRange(handle, length, position) {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

function normalizeWordSections(sections) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'docx-text-worker.cjs'), { workerData: sections });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Extraction DOCX interrompue (${code}).`));
    });
  });
}

async function readZipPart(handle, part) {
  if (![0, 8].includes(part.compression)
    || part.compressedSize > MAX_DOCX_TEXT_XML_BYTES
    || part.size > MAX_DOCX_TEXT_XML_BYTES) return null;
  const header = await readRange(handle, 30, part.localOffset);
  if (header.length !== 30 || header.readUInt32LE(0) !== 0x04034b50) return null;
  const dataOffset = part.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const compressed = await readRange(handle, part.compressedSize, dataOffset);
  if (compressed.length !== part.compressedSize) return null;
  if (part.compression === 0) return compressed;
  try {
    return await inflateRaw(compressed, { maxOutputLength: MAX_DOCX_TEXT_XML_BYTES });
  } catch {
    return null;
  }
}

function docxPartTitle(name) {
  if (name === 'word/document.xml') return 'Corps du document';
  if (/^word\/header\d*\.xml$/i.test(name)) return 'En-tête';
  if (/^word\/footer\d*\.xml$/i.test(name)) return 'Pied de page';
  if (name === 'word/footnotes.xml') return 'Notes de bas de page';
  if (name === 'word/endnotes.xml') return 'Notes de fin';
  if (name === 'word/comments.xml') return 'Commentaires';
  return name;
}

async function extractDocxText(file, stat) {
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
  if (docxTextCache.has(key)) return docxTextCache.get(key);
  let handle;
  let text = '';
  try {
    handle = await fsp.open(file, 'r');
    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readRange(handle, tailLength, stat.size - tailLength);
    const end = findZipEnd(tail);
    if (end < 0) return '';
    const entries = tail.readUInt16LE(end + 10);
    const centralSize = tail.readUInt32LE(end + 12);
    const centralOffset = tail.readUInt32LE(end + 16);
    if (entries === 0xffff || centralSize > MAX_DOCX_CENTRAL_BYTES || centralOffset + centralSize > stat.size) return '';
    const parts = await parseCentralDirectory(await readRange(handle, centralSize, centralOffset), entries);
    if (!parts) return '';
    const readable = parts.filter((part) => part.name === 'word/document.xml'
      || /^word\/(?:header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(part.name));
    const sections = [];
    let totalBytes = 0;
    for (const part of readable) {
      totalBytes += part.size;
      if (totalBytes > MAX_DOCX_TEXT_XML_BYTES) break;
      const xml = await readZipPart(handle, part);
      if (!xml) continue;
      sections.push({ title: docxPartTitle(part.name), xml: xml.toString('utf8') });
    }
    text = await normalizeWordSections(sections);
  } finally {
    await handle?.close().catch(() => {});
  }
  boundedCacheSet(docxTextCache, key, text, 2_000);
  return text;
}

async function encodeTextSnapshot(text) {
  const compressed = await deflateRaw(Buffer.from(String(text || ''), 'utf8'), { level: 6 });
  return compressed.toString('base64');
}

async function decodeTextSnapshot(entry) {
  if (!entry?.textDeflate) return null;
  try {
    return (await inflateRaw(Buffer.from(entry.textDeflate, 'base64'), { maxOutputLength: MAX_DOCX_TEXT_XML_BYTES })).toString('utf8');
  } catch {
    return null;
  }
}

async function addDocxTextSnapshot(caseRoot, relative, entry) {
  const absolute = path.join(caseRoot, ...relative.split('/'));
  const stat = docxStat(await fsp.stat(absolute));
  const text = await extractDocxText(absolute, stat);
  return {
    ...entry,
    textDeflate: await encodeTextSnapshot(text),
    textHash: crypto.createHash('sha256').update(text).digest('hex'),
  };
}

async function fingerprintDocx(file, stat) {
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
  if (docxFingerprintCache.has(key)) return docxFingerprintCache.get(key);
  let fingerprint = null;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const tailLength = Math.min(stat.size, 65_557);
    const tail = await readRange(handle, tailLength, stat.size - tailLength);
    const end = findZipEnd(tail);
    if (end >= 0) {
      const entries = tail.readUInt16LE(end + 10);
      const centralSize = tail.readUInt32LE(end + 12);
      const centralOffset = tail.readUInt32LE(end + 16);
      if (entries !== 0xffff && centralSize <= MAX_DOCX_CENTRAL_BYTES && centralOffset + centralSize <= stat.size) {
        fingerprint = await fingerprintCentralDirectory(await readRange(handle, centralSize, centralOffset), entries);
      }
    }
  } catch {
    fingerprint = null;
  } finally {
    await handle?.close().catch(() => {});
  }
  // Repli pour un faux/ZIP64 DOCX : métadonnées seulement, jamais le binaire.
  fingerprint ||= {
    fingerprint: crypto.createHash('sha256').update(`metadata\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`).digest('hex'),
    format: 'metadata-fallback',
    partCount: 0,
  };
  boundedCacheSet(docxFingerprintCache, key, fingerprint, 20_000);
  return fingerprint;
}

async function currentDocxManifest(caseRoot, baseline = emptyDocxManifest(), { includeText = false } = {}) {
  const root = await fsp.realpath(caseRoot);
  const protection = includeText ? readProtection(root) : null;
  const files = {};
  let count = 0;
  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !isDocxPath(entry.name)) continue;
      if (count >= MAX_SAFE_FILES) throw new Error('Ce dossier contient trop de documents Word pour calculer leur historique.');
      const stat = docxStat(await fsp.stat(absolute));
      const previous = baseline.files[relative];
      let current;
      if (sameDocxStat(previous, stat)) {
        current = previous;
      } else {
        const fingerprint = await fingerprintDocx(absolute, stat);
        current = previous?.fingerprint === fingerprint.fingerprint ? previous : { ...stat, ...fingerprint };
      }
      if (includeText) {
        if (isProtectedFile(absolute, root, protection)) {
          const { textDeflate: _textDeflate, textHash: _textHash, ...withoutText } = current;
          current = withoutText;
        } else if (!current.textDeflate) {
          current = await addDocxTextSnapshot(root, relative, current);
        }
      }
      files[relative] = current;
      count += 1;
      if (count % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await visit(root);
  return {
    version: DOCX_MANIFEST_VERSION,
    algorithm: DOCX_FINGERPRINT_ALGORITHM,
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right, 'fr'))),
  };
}

function serializeDocxManifest(manifest) {
  return `${JSON.stringify(manifest)}\n`;
}

function parseDocxManifest(value) {
  try {
    const manifest = JSON.parse(String(value || ''));
    return manifest?.version === DOCX_MANIFEST_VERSION && manifest.files && typeof manifest.files === 'object'
      ? manifest
      : emptyDocxManifest();
  } catch {
    return emptyDocxManifest();
  }
}

function resolveCasesRoot(casesRoot) {
  if (!casesRoot) throw new Error('Le dossier racine PieceMaker n’est pas configuré.');
  const root = path.resolve(String(casesRoot));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Le dossier racine PieceMaker est introuvable : ${root}`);
  }
  return fs.realpathSync(root);
}

function resolveCase(casesRoot, caseName) {
  const root = resolveCasesRoot(casesRoot);
  const name = String(caseName || '').trim();
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.startsWith('.')) {
    throw new Error('Dossier juridique invalide.');
  }
  const candidate = path.join(root, name);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`Le dossier juridique « ${name} » est introuvable.`);
  }
  const caseRoot = fs.realpathSync(candidate);
  if (path.dirname(caseRoot) !== root) {
    throw new Error('Le dossier juridique résout hors de la racine PieceMaker.');
  }
  return { casesRoot: root, name, root: caseRoot };
}

function locateCaseFile(casesRoot, filePath) {
  const root = resolveCasesRoot(casesRoot);
  const requested = path.resolve(String(filePath || ''));
  let absolute = requested;
  try {
    absolute = fs.realpathSync(requested);
  } catch {
    try {
      absolute = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
    } catch {}
  }
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) return null;
  const relativeToRoot = path.relative(root, absolute);
  const [caseName, ...parts] = relativeToRoot.split(path.sep);
  if (!caseName || parts.length === 0) return null;
  const legalCase = resolveCase(root, caseName);
  if (isProtectedFile(absolute, legalCase.root)) {
    return { ...legalCase, absolute, protected: true, relative: parts.join('/') };
  }
  if (path.extname(absolute).toLowerCase() && !SAFE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
    return { ...legalCase, absolute, protected: false, safe: false, relative: parts.join('/') };
  }
  const relative = path.relative(legalCase.root, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('../')) return null;
  return { ...legalCase, absolute, protected: false, safe: SAFE_EXTENSIONS.has(path.extname(relative).toLowerCase()), relative };
}

async function safeCaseFiles(caseRoot) {
  const startedAt = performance.now();
  const root = await fsp.realpath(caseRoot);
  const files = [];
  let bytes = 0;

  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile() || !SAFE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const size = (await fsp.stat(absolute)).size;
      bytes += size;
      files.push(relative);
      if (files.length > MAX_SAFE_FILES) throw new Error('Ce dossier contient trop de fichiers Markdown/JSON pour un commit sûr.');
      if (bytes > MAX_SAFE_BYTES) throw new Error('Les fichiers accessibles à l’IA dépassent 250 Mo ; commit annulé.');
    }
  }

  await visit(root);
  const sorted = files.sort((a, b) => a.localeCompare(b, 'fr'));
  logPerformance('safeCaseFiles', startedAt, { files: sorted.length, bytes });
  return sorted;
}

/**
 * Les pièces d'un dossier juridique, sous-dossiers compris.
 *
 * Le recensement ne dépend plus d'un sous-dossier « Pièces originales » : un
 * cabinet range ses pièces à plat, à côté du Markdown qu'il en tire, et cette
 * organisation-là ne protégeait donc rien. Est une pièce tout fichier qui n'est
 * ni Markdown ni JSON — le reste, ce sont les dérivés que l'IA a le droit de
 * lire (sous mapping) et le mapping lui-même.
 *
 * `converted` / `scanned` restent l'état du pipeline ; `protected` est la
 * décision prise dans l'administration et appliquée par les hooks. Le scan
 * n'est plus déduit de la présence d'un mapping sensible par pièce : le
 * manifeste technique `.piecemaker/anonymization-state.json`, dépourvu de PII,
 * mémorise les empreintes de conversion et de scan. Les anciens sensitive maps
 * ne servent que de compatibilité pendant leur migration.
 */
async function originalFilesOverview(caseRoot, { safeFiles: knownSafeFiles = null } = {}) {
  const startedAt = performance.now();
  const root = await fsp.realpath(caseRoot);
  const safeFiles = knownSafeFiles || await safeCaseFiles(root);
  const markdownKeys = new Set(safeFiles.filter((file) => path.extname(file).toLowerCase() === '.md').map(documentKey));
  const scanKeys = new Set(
    safeFiles
      .filter((file) => file.toLowerCase().endsWith('_sensitive_map.json'))
      .map((file) => documentKey(file).replace(/-sensitive-map$/, ''))
  );
  const anonymizationState = readAnonymizationState(root);
  const protection = readProtection(root);
  const originals = [];
  let truncated = false;

  async function visit(directory, prefix = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    // MinerU écrit sa sortie dans `<nom de la pièce>/auto/` à côté de la pièce.
    // Ces dérivés portent le même contenu que l'original — ils restent donc
    // protégés par défaut — mais les lister doublerait chaque pièce dans
    // l'administration.
    const conversionOutputs = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => documentKey(entry.name))
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('~$') || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Le sous-dossier des fichiers produits (Markdown, mapping) n'est jamais
        // une source de pièces : ses `.md`/`.json` sont déjà écartés par
        // `SAFE_EXTENSIONS`, mais d'éventuels dérivés non-Markdown (images
        // MinerU) qui y vivent ne doivent pas non plus être listés comme pièces.
        // `safeCaseFiles`, lui, continue de le parcourir pour repérer les `.md`.
        if (entry.name === WORKSPACE_SUBDIR) continue;
        if (isIgnoredDirectoryName(entry.name) || conversionOutputs.has(documentKey(entry.name))) continue;
        await visit(absolute, relative);
        continue;
      }
      if (originals.length >= MAX_ORIGINALS) {
        truncated = true;
        return;
      }
      if (!entry.isFile()) continue;
      if (SAFE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fsp.stat(absolute);
      const key = documentKey(entry.name);
      const stateEntry = anonymizationState.files[stateKey(relative)];
      // Un dossier ancien sans manifeste conserve le comportement historique
      // (Markdown présent = converti). Dès qu'une empreinte existe, elle rend un
      // Markdown périmé visible au lieu de le réutiliser silencieusement.
      const converted = markdownKeys.has(key) && (!stateEntry || isConvertedEntry(stateEntry, stat));
      const scanned = converted && (
        isAnonymizedEntry(stateEntry, stat)
        || scanKeys.has(key)
      );
      originals.push({
        name: entry.name,
        path: relative,
        extension: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        converted,
        scanned,
        protected: isProtectedFile(absolute, root, protection),
        resource: isResourceFile(absolute, root, protection),
        status: converted ? (scanned ? 'ready' : 'awaiting-scan') : 'not-converted',
      });
    }
  }

  await visit(root);
  const sorted = originals.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  if (truncated) sorted.truncated = true;
  logPerformance('originalFilesOverview', startedAt, {
    safeFiles: safeFiles.length,
    originals: sorted.length,
    truncated,
  });
  return sorted;
}

function historyId(legalCase) {
  const slug = legalCase.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 60) || 'dossier';
  const digest = crypto.createHash('sha256').update(legalCase.root).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

const caseStateCache = new Map();

function caseStateCacheKey(homeDir, legalCase) {
  return `${path.resolve(homeDir)}:${historyId(legalCase)}`;
}

function historyDirectory(homeDir = path.join(os.homedir(), '.piecemaker')) {
  return path.join(homeDir, 'case-history');
}

function historyRepo(homeDir, legalCase) {
  return path.join(historyDirectory(homeDir), `${historyId(legalCase)}.git`);
}

async function ensureHistoryRepo(homeDir, legalCase) {
  const gitDir = historyRepo(homeDir, legalCase);
  if (!fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(gitDir), { recursive: true });
    await runGit(legalCase.root, ['init', '--bare', gitDir]);
    await runGit(legalCase.root, ['symbolic-ref', 'HEAD', HISTORY_REF], { gitDir });
  }
  const main = await runGit(legalCase.root, ['rev-parse', '--verify', HISTORY_REF], { gitDir, allowFailure: true });
  if (main.code !== 0) {
    const legacy = await runGit(legalCase.root, ['rev-parse', '--verify', LEGACY_HISTORY_REF], { gitDir, allowFailure: true });
    if (legacy.code === 0) await runGit(legalCase.root, ['update-ref', HISTORY_REF, legacy.stdout], { gitDir });
  }
  const head = await runGit(legalCase.root, ['symbolic-ref', '-q', 'HEAD'], { gitDir, allowFailure: true });
  const headCommit = head.code === 0
    ? await runGit(legalCase.root, ['rev-parse', '--verify', head.stdout], { gitDir, allowFailure: true })
    : { code: 1 };
  const migratedMain = await runGit(legalCase.root, ['rev-parse', '--verify', HISTORY_REF], { gitDir, allowFailure: true });
  if (head.code !== 0 || !head.stdout.startsWith('refs/heads/') || (headCommit.code !== 0 && migratedMain.code === 0)) {
    await runGit(legalCase.root, ['symbolic-ref', 'HEAD', HISTORY_REF], { gitDir });
  }
  return gitDir;
}

async function activeHistoryRef(legalCase, gitDir) {
  const result = await runGit(legalCase.root, ['symbolic-ref', '-q', 'HEAD'], { gitDir, allowFailure: true });
  return result.code === 0 && result.stdout.startsWith('refs/heads/') ? result.stdout : HISTORY_REF;
}

async function latestCommit(legalCase, gitDir) {
  const result = await runGit(legalCase.root, ['rev-parse', '--verify', await activeHistoryRef(legalCase, gitDir)], { gitDir, allowFailure: true });
  return result.code === 0 ? result.stdout : '';
}

async function historyBranches(casesRoot, homeDir, caseName) {
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const activeRef = await activeHistoryRef(legalCase, gitDir);
  const active = activeRef.slice('refs/heads/'.length);
  const result = await runGit(legalCase.root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { gitDir });
  const branches = [...new Set([active, ...result.stdout.split('\n').map((name) => name.trim()).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b, 'fr'));
  return { active, branches };
}

async function validatedBranchName(legalCase, gitDir, value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120) throw new Error('Le nom de branche est requis.');
  const valid = await runGit(legalCase.root, ['check-ref-format', '--branch', name], { gitDir, allowFailure: true });
  if (valid.code !== 0) throw new Error('Nom de branche Git invalide.');
  return name;
}

async function createHistoryBranch({ casesRoot, caseName, homeDir = path.join(os.homedir(), '.piecemaker'), name } = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  return withCaseLock(homeDir, legalCase, async () => {
    const gitDir = await ensureHistoryRepo(homeDir, legalCase);
    const branch = await validatedBranchName(legalCase, gitDir, name);
    const ref = `refs/heads/${branch}`;
    const exists = await runGit(legalCase.root, ['show-ref', '--verify', '--quiet', ref], { gitDir, allowFailure: true });
    if (exists.code === 0) throw new Error(`La branche « ${branch} » existe déjà.`);
    const parent = await latestCommit(legalCase, gitDir);
    if (parent) await runGit(legalCase.root, ['update-ref', ref, parent], { gitDir });
    await runGit(legalCase.root, ['symbolic-ref', 'HEAD', ref], { gitDir });
    caseStateCache.delete(caseStateCacheKey(homeDir, legalCase));
    return historyBranches(casesRoot, homeDir, legalCase.name);
  }, { waitMs: 10_000 });
}

async function checkoutHistoryBranch({ casesRoot, caseName, homeDir = path.join(os.homedir(), '.piecemaker'), name } = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  return withCaseLock(homeDir, legalCase, async () => {
    const gitDir = await ensureHistoryRepo(homeDir, legalCase);
    const branch = await validatedBranchName(legalCase, gitDir, name);
    const ref = `refs/heads/${branch}`;
    const exists = await runGit(legalCase.root, ['show-ref', '--verify', '--quiet', ref], { gitDir, allowFailure: true });
    const current = await activeHistoryRef(legalCase, gitDir);
    if (exists.code !== 0 && current !== ref) throw new Error(`La branche « ${branch} » n’existe pas.`);
    await runGit(legalCase.root, ['symbolic-ref', 'HEAD', ref], { gitDir });
    caseStateCache.delete(caseStateCacheKey(homeDir, legalCase));
    return historyBranches(casesRoot, homeDir, legalCase.name);
  }, { waitMs: 10_000 });
}

async function withCaseLock(homeDir, legalCase, callback, { waitMs = 0 } = {}) {
  const directory = historyDirectory(homeDir);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, `${historyId(legalCase)}.lock`);
  const deadline = Date.now() + Math.max(Number(waitMs) || 0, 0);
  let fd;
  try {
    while (fd === undefined) {
      try {
        fd = fs.openSync(lock, 'wx');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (age >= 60_000) {
          try { fs.unlinkSync(lock); } catch {}
          continue;
        }
        if (Date.now() >= deadline) return { created: false, skipped: 'busy' };
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(deadline - Date.now(), 1))));
      }
    }
    fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
    return await callback();
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lock); } catch {}
    }
  }
}

async function putDocxManifestInIndex(legalCase, gitDir, env, manifest) {
  if (!Object.keys(manifest.files).length) return;
  const blob = (await runGit(legalCase.root, ['hash-object', '-w', '--stdin'], {
    gitDir,
    input: serializeDocxManifest(manifest),
  })).stdout;
  await runGit(legalCase.root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${DOCX_MANIFEST_PATH}`], {
    gitDir,
    workTree: legalCase.root,
    env,
  });
}

async function treeDocxManifest(legalCase, gitDir, treeish) {
  if (!treeish) return emptyDocxManifest();
  const key = `${gitDir}\0${treeish}`;
  if (docxTreeCache.has(key)) return docxTreeCache.get(key);
  const result = await runGit(legalCase.root, ['show', `${treeish}:${DOCX_MANIFEST_PATH}`], { gitDir, allowFailure: true });
  const manifest = result.code === 0 ? parseDocxManifest(result.stdout) : emptyDocxManifest();
  boundedCacheSet(docxTreeCache, key, manifest, 2_000);
  return manifest;
}

function docxChanges(beforeManifest, afterManifest) {
  const before = beforeManifest.files;
  const after = afterManifest.files;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => left.localeCompare(right, 'fr'))
    .flatMap((filePath) => {
      if (!before[filePath]) return [{ status: 'A', path: filePath, previousPath: null, kind: 'added' }];
      if (!after[filePath]) return [{ status: 'D', path: filePath, previousPath: null, kind: 'deleted' }];
      return before[filePath].fingerprint === after[filePath].fingerprint
        ? []
        : [{ status: 'M', path: filePath, previousPath: null, kind: 'modified' }];
    });
}

async function liveDocxText(legalCase, filePath, entry) {
  if (!entry) return '';
  const absolute = path.join(legalCase.root, ...filePath.split('/'));
  try {
    const stat = docxStat(await fsp.stat(absolute));
    const fingerprint = await fingerprintDocx(absolute, stat);
    if (fingerprint.fingerprint !== entry.fingerprint) return null;
    return extractDocxText(absolute, stat);
  } catch {
    return null;
  }
}

async function entryDocxText(legalCase, filePath, entry) {
  if (!entry) return '';
  return await decodeTextSnapshot(entry) ?? liveDocxText(legalCase, filePath, entry);
}

function limitPatch(value) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  if (buffer.length <= MAX_PATCH_BYTES) return { stdout: buffer.toString('utf8'), truncated: false };
  return { stdout: `${buffer.subarray(0, MAX_PATCH_BYTES).toString('utf8')}…`, truncated: true };
}

async function docxTextDiff(legalCase, beforeManifest, afterManifest, filePath) {
  const before = beforeManifest.files[filePath];
  const after = afterManifest.files[filePath];
  const absolute = path.join(legalCase.root, ...filePath.split('/'));
  if (isProtectedFile(absolute, legalCase.root)) {
    return {
      stdout: `diff --text a/${filePath} b/${filePath}\n@@ Document protégé @@\n  Le texte n’est pas extrait des pièces protégées.\n`,
      truncated: false,
      stats: { files: 1, added: 0, deleted: 0 },
    };
  }

  const [beforeText, afterText] = await Promise.all([
    entryDocxText(legalCase, filePath, before),
    entryDocxText(legalCase, filePath, after),
  ]);
  if (beforeText === null || afterText === null) {
    const available = afterText ?? beforeText ?? '';
    const prefix = afterText !== null ? '+' : '-';
    const lines = available.split('\n').map((line) => `${prefix}${line}`);
    const patch = limitPatch([
      `diff --text a/${filePath} b/${filePath}`,
      `--- ${before ? `a/${filePath}` : '/dev/null'}`,
      `+++ ${after ? `b/${filePath}` : '/dev/null'}`,
      '@@ Texte partiellement disponible @@',
      '  Le prochain commit servira de référence textuelle complète.',
      ...lines,
      '',
    ].join('\n'));
    return {
      ...patch,
      stats: {
        files: 1,
        added: prefix === '+' ? lines.length : 0,
        deleted: prefix === '-' ? lines.length : 0,
      },
    };
  }

  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'piecemaker-docx-diff-'));
  const beforeFile = path.join(temporary, 'avant.txt');
  const afterFile = path.join(temporary, 'apres.txt');
  try {
    await Promise.all([
      fsp.writeFile(beforeFile, `${beforeText}\n`, { encoding: 'utf8', mode: 0o600 }),
      fsp.writeFile(afterFile, `${afterText}\n`, { encoding: 'utf8', mode: 0o600 }),
    ]);
    const result = await runGit(legalCase.root, [
      'diff', '--no-index', '--text', '--unified=3', '--', beforeFile, afterFile,
    ], { allowFailure: true, maxOutputBytes: MAX_PATCH_BYTES, truncateOutput: true });
    const hunk = String(result.stdout || '').match(/^@@[\s\S]*$/m)?.[0] || '';
    const patch = [
      `diff --text a/${filePath} b/${filePath}`,
      `--- ${before ? `a/${filePath}` : '/dev/null'}`,
      `+++ ${after ? `b/${filePath}` : '/dev/null'}`,
      hunk,
    ].filter(Boolean).join('\n');
    const body = hunk.split('\n');
    return {
      stdout: patch,
      truncated: result.truncated,
      stats: {
        files: 1,
        added: body.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        deleted: body.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
      },
    };
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function buildCurrentTree(legalCase, gitDir, homeDir, baselineDocx = emptyDocxManifest(), { includeDocx = true } = {}) {
  const startedAt = performance.now();
  const temporaryIndex = path.join(historyDirectory(homeDir), `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  const [files, docxManifest] = await Promise.all([
    safeCaseFiles(legalCase.root),
    currentDocxManifest(legalCase.root, baselineDocx, { includeText: includeDocx }),
  ]);
  try {
    await runGit(legalCase.root, ['read-tree', '--empty'], { gitDir, workTree: legalCase.root, env });
    if (files.length) {
      // Un seul processus Git reçoit les chemins en NUL sur stdin. L'ancien
      // découpage par groupes de 100 relançait Git 38 fois sur un gros dossier.
      await runGit(legalCase.root, [
        'add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul',
      ], {
        gitDir,
        workTree: legalCase.root,
        env,
        // Apple Git stocke les chemins précomposés dans l'index alors qu'APFS
        // les renvoie souvent décomposés. Les arguments argv étaient convertis
        // implicitement ; les pathspec lus sur stdin doivent l'être ici.
        input: Buffer.from(`${files.map((file) => process.platform === 'darwin' ? file.normalize('NFC') : file).join('\0')}\0`, 'utf8'),
      });
    }
    if (includeDocx) await putDocxManifestInIndex(legalCase, gitDir, env, docxManifest);
    const tree = (await runGit(legalCase.root, ['write-tree'], { gitDir, workTree: legalCase.root, env })).stdout;
    if (includeDocx) boundedCacheSet(docxTreeCache, `${gitDir}\0${tree}`, docxManifest, 2_000);
    const snapshot = includeDocx
      ? tree
      : crypto.createHash('sha1').update(`${tree}\0${serializeDocxManifest(docxManifest)}`).digest('hex');
    logPerformance('buildCurrentTree', startedAt, {
      files: files.length,
      gitAddBatches: files.length ? 1 : 0,
    });
    return { tree, snapshot, files, docxManifest };
  } finally {
    try { fs.unlinkSync(temporaryIndex); } catch {}
  }
}

/**
 * Construit un arbre à partir du parent en n'y appliquant que les chemins de
 * l'opération courante. Les autres modifications présentes dans le work-tree
 * restent donc locales et ne peuvent pas fuiter dans un commit automatique.
 */
async function buildSelectedTree(legalCase, gitDir, homeDir, parent, selectedPaths) {
  const startedAt = performance.now();
  const temporaryIndex = path.join(historyDirectory(homeDir), `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    await runGit(legalCase.root, ['read-tree', ...(parent ? [parent] : ['--empty'])], {
      gitDir,
      workTree: legalCase.root,
      env,
    });
    if (selectedPaths.length) {
      await runGit(legalCase.root, [
        'add', '-f', '-A', '--pathspec-from-file=-', '--pathspec-file-nul',
      ], {
        gitDir,
        workTree: legalCase.root,
        env,
        input: Buffer.from(`${selectedPaths.map((file) => process.platform === 'darwin' ? file.normalize('NFC') : file).join('\0')}\0`, 'utf8'),
      });
    }
    const tree = (await runGit(legalCase.root, ['write-tree'], { gitDir, workTree: legalCase.root, env })).stdout;
    logPerformance('buildSelectedTree', startedAt, { files: selectedPaths.length });
    return { tree, files: selectedPaths };
  } finally {
    try { fs.unlinkSync(temporaryIndex); } catch {}
  }
}

async function emptyTree(legalCase, gitDir) {
  return (await runGit(legalCase.root, ['mktree'], { gitDir, input: '' })).stdout;
}

function parseNameStatus(raw) {
  return String(raw || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const columns = line.split('\t');
    return { status: columns[0] || 'M', path: columns.at(-1) || '', previousPath: columns.length > 2 ? columns[1] : null };
  });
}

function statusKind(code) {
  const value = String(code || '').trim();
  if (value.includes('A') || value === '??') return 'added';
  if (value.includes('D')) return 'deleted';
  if (value.includes('R')) return 'renamed';
  return 'modified';
}

async function diffTrees(legalCase, gitDir, from, to, manifests = null) {
  const raw = (await runGit(legalCase.root, ['diff-tree', '--no-commit-id', '--name-status', '-r', from, to], { gitDir })).stdout;
  const parsed = parseNameStatus(raw);
  const regular = parsed
    .filter((file) => file.path !== DOCX_MANIFEST_PATH)
    .map((file) => ({ ...file, kind: statusKind(file.status) }));
  let wordChanges = [];
  if (manifests) {
    wordChanges = docxChanges(manifests.before, manifests.after);
  } else if (parsed.some((file) => file.path === DOCX_MANIFEST_PATH)) {
    wordChanges = docxChanges(await treeDocxManifest(legalCase, gitDir, from), await treeDocxManifest(legalCase, gitDir, to));
  }
  return [...regular, ...wordChanges].sort((left, right) => left.path.localeCompare(right.path, 'fr'));
}

async function workingState(casesRoot, homeDir, caseName) {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const latest = await latestCommit(legalCase, gitDir);
  const base = latest || await emptyTree(legalCase, gitDir);
  const baselineDocx = latest ? await treeDocxManifest(legalCase, gitDir, base) : emptyDocxManifest();
  // L'admin compare le manifeste en mémoire. Il n'est écrit dans l'index Git
  // qu'au commit : aucun processus Git supplémentaire sur le chemin chaud.
  const current = await buildCurrentTree(legalCase, gitDir, homeDir, baselineDocx, { includeDocx: false });
  const changes = await diffTrees(legalCase, gitDir, base, current.tree, { before: baselineDocx, after: current.docxManifest });
  logPerformance('workingState', startedAt, { files: current.files.length, changes: changes.length });
  const state = { legalCase, gitDir, latest, current, base, baselineDocx, changes };
  caseStateCache.set(caseStateCacheKey(homeDir, legalCase), state);
  return state;
}

/**
 * Structured git trailers appended at the end of a commit message.
 *
 * `PieceMaker-Session` is the durable join key between a case's commits and the
 * billing ledger (which records the authoritative final duration at session
 * Stop). `PieceMaker-Temps-Session` is the session time elapsed at the instant
 * of the commit — so the last commit of a session carries ~its full duration,
 * and every commit is self-documenting without needing the ledger. Both stay
 * parseable (`Clé: valeur`) and are read back by `listHistory` via `%b`.
 */
function buildCommitTrailers({ sessionId, durationMs }) {
  const trailers = [];
  const session = String(sessionId || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 120);
  if (session) trailers.push(`PieceMaker-Session: ${session}`);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    const human = formatDurationFr(durationMs);
    if (human) trailers.push(`PieceMaker-Temps-Session: ${human} (${Math.round(durationMs)} ms)`);
  }
  return trailers;
}

async function createCommit({
  casesRoot,
  caseName,
  homeDir = path.join(os.homedir(), '.piecemaker'),
  label = 'Commit PieceMaker',
  description = '',
  sessionId = null,
  durationMs = null,
  event = 'manual',
  paths = null,
  waitForLockMs = 0,
  identity = null,
  envFile = GLOBAL_ENV_FILE,
} = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  caseStateCache.delete(caseStateCacheKey(homeDir, legalCase));
  const safeLabel = String(label || 'Commit PieceMaker').replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
  const safeDescription = String(description || '').replaceAll('\0', '').replaceAll('\r\n', '\n').trim().slice(0, 4000);
  const selectedPaths = paths == null
    ? null
    : [...new Set((Array.isArray(paths) ? paths : [paths]).map((file) => validateRelativeSafePath(legalCase, file)))];
  return withCaseLock(homeDir, legalCase, async () => {
    const gitDir = await ensureHistoryRepo(homeDir, legalCase);
    const parent = await latestCommit(legalCase, gitDir);
    const parentTree = parent
      ? (await runGit(legalCase.root, ['rev-parse', `${parent}^{tree}`], { gitDir })).stdout
      : await emptyTree(legalCase, gitDir);
    const baselineDocx = selectedPaths === null && parent
      ? await treeDocxManifest(legalCase, gitDir, parentTree)
      : emptyDocxManifest();
    const current = selectedPaths === null
      ? await buildCurrentTree(legalCase, gitDir, homeDir, baselineDocx)
      : await buildSelectedTree(legalCase, gitDir, homeDir, parent, selectedPaths);
    if (current.tree === parentTree) {
      return { created: false, commit: parent || null, caseName: legalCase.name, files: [] };
    }

    const timestamp = new Date().toISOString();
    const trailers = buildCommitTrailers({ sessionId, durationMs });
    const message = `${safeLabel || 'Commit PieceMaker'}\n${safeDescription ? `\n${safeDescription}\n` : ''}${trailers.length ? `\n${trailers.join('\n')}\n` : ''}`;
    const commitIdentity = resolveCommitIdentity({ identity, envFile });
    const gitIdentity = {
      GIT_AUTHOR_NAME: commitIdentity.name,
      GIT_AUTHOR_EMAIL: commitIdentity.email,
      GIT_COMMITTER_NAME: commitIdentity.name,
      GIT_COMMITTER_EMAIL: commitIdentity.email,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    };
    const args = ['commit-tree', current.tree, ...(parent ? ['-p', parent] : [])];
    const commit = (await runGit(legalCase.root, args, { gitDir, env: gitIdentity, input: message })).stdout;
    await runGit(legalCase.root, ['update-ref', await activeHistoryRef(legalCase, gitDir), commit, ...(parent ? [parent] : [])], { gitDir });
    const files = await diffTrees(
      legalCase,
      gitDir,
      parentTree,
      current.tree,
      selectedPaths === null ? { before: baselineDocx, after: current.docxManifest } : null,
    );
    return {
      created: true,
      commit,
      parent: parent || null,
      timestamp,
      label: safeLabel || 'Commit PieceMaker',
      sessionId,
      durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
      event,
      author: commitIdentity.name,
      caseName: legalCase.name,
      files,
    };
  }, { waitMs: waitForLockMs });
}

function parseLog(raw) {
  return String(raw || '').split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [hash, shortHash, author, timestamp, subject, ...body] = record.split('\x1f');
    return {
      hash,
      shortHash,
      author,
      timestamp,
      subject,
      body: body.join('\x1f').trim(),
      kind: 'commit',
    };
  }).filter((entry) => entry.hash);
}

async function listHistory(casesRoot, homeDir, { caseName, limit = 120 } = {}) {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  if (!await latestCommit(legalCase, gitDir)) {
    logPerformance('listHistory', startedAt, { commits: 0 });
    return [];
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 250);
  const historyRef = await activeHistoryRef(legalCase, gitDir);
  const raw = (await runGit(legalCase.root, [
    'log', `--max-count=${safeLimit}`, '--date=iso-strict',
    '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b', historyRef,
  ], { gitDir })).stdout;
  const history = parseLog(raw);
  logPerformance('listHistory', startedAt, { commits: history.length, limit: safeLimit });
  return history;
}

/**
 * Les mois `YYYY-MM` où le dossier a des commits, du plus récent au plus
 * ancien — alimente le menu déroulant de l'export mensuel. Une seule colonne
 * (`%aI`) suffit : dériver le mois ne demande que les 7 premiers caractères
 * d'une date ISO stricte, pas un `git log` structuré comme `listHistory`.
 */
async function historyMonths(casesRoot, homeDir, { caseName } = {}) {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  if (!await latestCommit(legalCase, gitDir)) {
    logPerformance('historyMonths', startedAt, { months: 0 });
    return [];
  }
  const historyRef = await activeHistoryRef(legalCase, gitDir);
  const raw = (await runGit(legalCase.root, ['log', '--date=iso-strict', '--pretty=format:%aI', historyRef], { gitDir })).stdout;
  const months = [...new Set(
    raw.split('\n').map((line) => line.trim().slice(0, 7)).filter(Boolean)
  )].sort((left, right) => right.localeCompare(left));
  logPerformance('historyMonths', startedAt, { months: months.length });
  return months;
}

/**
 * Variante de `parseLog` avec la liste des fichiers touchés par chaque
 * commit. Le format ajoute un `%x1f` terminal après le corps (`%b`) : ce
 * séparateur referme le champ « corps », multi-ligne, sans ambiguïté avec la
 * liste de fichiers de `--name-only` qui le suit jusqu'au `\x1e` du commit
 * suivant. `parseLog` reste inchangé pour `listHistory` (son format n'a pas
 * ce dernier séparateur).
 */
function parseLogWithFiles(raw) {
  return String(raw || '').split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const fields = record.split('\x1f');
    const [hash, shortHash, author, timestamp, subject] = fields;
    // Entre le 5e séparateur et le dernier se trouve le corps (`%b`), qui ne
    // devrait jamais contenir de \x1f mais est rejoint par défense, comme le
    // fait déjà `parseLog` ; le tout dernier segment est la liste des
    // fichiers, un par ligne.
    const body = fields.slice(5, -1).join('\x1f').trim();
    const files = String(fields.at(-1) || '').split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      hash,
      shortHash,
      author,
      timestamp,
      subject,
      body,
      kind: 'commit',
      files,
      filesCount: files.length,
    };
  }).filter((entry) => entry.hash);
}

/**
 * Sépare les trailers techniques `PieceMaker-*` du corps d'un commit (voir
 * `buildCommitTrailers`). Miroir du parsing côté client
 * (`admin/app.js` → `parsePieceMakerTrailers`), avec en plus la durée brute
 * en millisecondes que l'affichage seul n'a pas besoin de connaître mais
 * qu'un export chiffré (temps facturable par mois) exploite directement.
 */
function parseCommitTrailers(body) {
  const lines = String(body || '').split('\n');
  const kept = [];
  let sessionId = null;
  let durationMs = null;
  for (const line of lines) {
    const session = line.match(/^PieceMaker-Session:\s*(.+)$/);
    if (session) { sessionId = session[1].trim(); continue; }
    const time = line.match(/^PieceMaker-Temps-Session:\s*.+?\((\d+)\s*ms\)\s*$/);
    if (time) { durationMs = Number(time[1]); continue; }
    kept.push(line);
  }
  return { comment: kept.join('\n').trim(), sessionId, durationMs };
}

/**
 * Commits d'une période `[since, until)`, fichiers touchés compris. `until`
 * est exclusif côté appelant (premier jour du mois suivant, typiquement) :
 * cette fonction ne fait aucune arithmétique de date, elle transmet telles
 * quelles à `--since`/`--until`. Pas de plafond façon `listHistory` — le hook
 * `PostToolUse` commite à chaque Write/Edit, un mois peut en compter des
 * milliers — seulement un plafond de sécurité large pour ne pas exploser
 * `MAX_GIT_BUFFER` sur un dossier anormalement actif.
 */
async function listHistoryPeriod(casesRoot, homeDir, { caseName, since, until } = {}) {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  if (!await latestCommit(legalCase, gitDir)) {
    logPerformance('listHistoryPeriod', startedAt, { commits: 0 });
    return [];
  }
  const historyRef = await activeHistoryRef(legalCase, gitDir);
  const raw = (await runGit(legalCase.root, [
    'log', `--max-count=${MAX_HISTORY_PERIOD_COMMITS}`, '--date=iso-strict', '--name-only',
    ...(since ? [`--since=${since}`] : []),
    ...(until ? [`--until=${until}`] : []),
    '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1f', historyRef,
  ], { gitDir })).stdout;
  const history = parseLogWithFiles(raw).map((entry) => {
    const { sessionId, durationMs } = parseCommitTrailers(entry.body);
    return { ...entry, sessionId, durationMs };
  });
  logPerformance('listHistoryPeriod', startedAt, { commits: history.length, since, until });
  return history;
}

function normalizeRelativeHistoryPath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('Chemin de fichier invalide.');
  }
  return normalized;
}

function validateRelativeSafePath(legalCase, relativePath) {
  const normalized = normalizeRelativeHistoryPath(relativePath);
  const absolute = path.join(legalCase.root, ...normalized.split('/'));
  if (isProtectedFile(absolute, legalCase.root) || !SAFE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    throw new Error('Ce fichier n’est pas accessible à l’IA.');
  }
  return normalized;
}

function validateRelativeHistoryPath(legalCase, relativePath) {
  const normalized = normalizeRelativeHistoryPath(relativePath);
  return isDocxPath(normalized) ? normalized : validateRelativeSafePath(legalCase, normalized);
}

async function revisionMetadata(legalCase, gitDir, hash) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(hash || ''))) throw new Error('Identifiant de révision invalide.');
  const commit = (await runGit(legalCase.root, ['rev-parse', '--verify', `${hash}^{commit}`], { gitDir })).stdout;
  if ((await runGit(legalCase.root, ['merge-base', '--is-ancestor', commit, await activeHistoryRef(legalCase, gitDir)], { gitDir, allowFailure: true })).code !== 0) {
    throw new Error('Cette révision ne fait pas partie de ce dossier juridique.');
  }
  const raw = (await runGit(legalCase.root, ['show', '-s', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b', commit], { gitDir })).stdout;
  const [fullHash, shortHash, author, timestamp, subject, ...body] = raw.split('\x1f');
  return { commit, hash: fullHash, shortHash, author, timestamp, subject, body: body.join('\x1f').trim() };
}

function parseShortStat(raw) {
  const value = String(raw || '');
  return {
    files: Number(value.match(/(\d+) files? changed/)?.[1] || 0),
    added: Number(value.match(/(\d+) insertions?\(\+\)/)?.[1] || 0),
    deleted: Number(value.match(/(\d+) deletions?\(-\)/)?.[1] || 0),
  };
}

async function revisionDetails(casesRoot, homeDir, caseName, hash, filePath = '') {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const meta = await revisionMetadata(legalCase, gitDir, hash);
  const commitTree = (await runGit(legalCase.root, ['rev-parse', `${meta.commit}^{tree}`], { gitDir })).stdout;
  const parent = await runGit(legalCase.root, ['rev-parse', '--verify', `${meta.commit}^`], { gitDir, allowFailure: true });
  const parentTree = parent.code === 0
    ? (await runGit(legalCase.root, ['rev-parse', `${parent.stdout}^{tree}`], { gitDir })).stdout
    : await emptyTree(legalCase, gitDir);
  const files = await diffTrees(legalCase, gitDir, parentTree, commitTree);
  const selectedPath = filePath ? validateRelativeHistoryPath(legalCase, filePath) : '';
  const selectedFile = selectedPath ? files.find((file) => file.path === selectedPath) : null;
  if (selectedPath && !selectedFile) throw new Error('Ce fichier ne fait pas partie de cette révision.');
  // Sur un commit complet, Git doit parcourir tous les blobs une deuxième fois
  // pour produire le shortstat. Le patch contient déjà l'information utile et
  // est borné ci-dessous : ne calculer les statistiques que pour un fichier
  // explicitement sélectionné évite ce parcours redondant.
  const wordDiff = isDocxPath(selectedPath)
    ? await docxTextDiff(
      legalCase,
      await treeDocxManifest(legalCase, gitDir, parentTree),
      await treeDocxManifest(legalCase, gitDir, commitTree),
      selectedPath,
    )
    : null;
  const stats = wordDiff?.stats || (selectedPath
    ? parseShortStat((await runGit(legalCase.root, [
      'diff-tree', '--root', '--no-commit-id', '--shortstat', '-r', meta.commit, '--', selectedPath,
    ], { gitDir })).stdout)
    : { files: 0, added: 0, deleted: 0 });
  // Le premier clic sur un commit ne calcule que sa liste de fichiers. Le
  // patch, potentiellement volumineux, n'est demandé qu'après sélection d'un
  // fichier dans la colonne dédiée.
  const patchResult = wordDiff || (selectedPath
    ? await runGit(legalCase.root, [
      'show', '--format=', '--no-ext-diff', '--unified=3', meta.commit, '--', selectedPath,
    ], {
      gitDir,
      maxOutputBytes: MAX_PATCH_BYTES,
      truncateOutput: true,
    })
    : { stdout: '', truncated: false });
  const result = {
    ...meta,
    kind: 'commit',
    files,
    filesCount: files.length,
    stats,
    selectedFile,
    selectedPath,
    patch: patchResult.stdout,
    truncated: patchResult.truncated,
  };
  logPerformance('revisionDetails', startedAt, {
    files: result.filesCount,
    selectedFile: Boolean(selectedPath),
    patchBytes: Buffer.byteLength(result.patch, 'utf8'),
    truncated: result.truncated,
  });
  return result;
}

async function worktreeDetails(casesRoot, homeDir, caseName, filePath = '', snapshot = '') {
  const startedAt = performance.now();
  const legalCase = resolveCase(casesRoot, caseName);
  const cached = caseStateCache.get(caseStateCacheKey(homeDir, legalCase));
  const state = snapshot && cached?.current.snapshot === snapshot
    ? cached
    : await workingState(casesRoot, homeDir, caseName);
  const selectedPath = filePath ? validateRelativeHistoryPath(state.legalCase, filePath) : '';
  if (selectedPath && !state.changes.some((file) => file.path === selectedPath)) {
    throw new Error('Ce fichier ne fait pas partie des modifications actuelles.');
  }
  const selectedFile = selectedPath ? state.changes.find((file) => file.path === selectedPath) : null;
  const wordDiff = isDocxPath(selectedPath)
    ? await docxTextDiff(state.legalCase, state.baselineDocx, state.current.docxManifest, selectedPath)
    : null;
  const statsRaw = wordDiff || !selectedPath ? '' : (await runGit(state.legalCase.root, [
    'diff', '--shortstat', state.base, state.current.tree, '--', selectedPath,
  ], { gitDir: state.gitDir })).stdout;
  const stats = wordDiff?.stats || parseShortStat(statsRaw);
  const patchResult = wordDiff || (!selectedPath
    ? { stdout: '', truncated: false }
    : await runGit(state.legalCase.root, [
      'diff', '--no-ext-diff', '--unified=3', state.base, state.current.tree, '--', selectedPath,
    ], {
      gitDir: state.gitDir,
      maxOutputBytes: MAX_PATCH_BYTES,
      truncateOutput: true,
    }));
  const result = {
    hash: 'WORKTREE',
    shortHash: '',
    author: 'Modifications locales',
    timestamp: new Date().toISOString(),
    subject: 'Modifications depuis le dernier commit',
    kind: 'worktree',
    files: state.changes,
    filesCount: state.changes.length,
    stats,
    selectedFile,
    selectedPath,
    patch: patchResult.stdout,
    truncated: patchResult.truncated,
  };
  logPerformance('worktreeDetails', startedAt, {
    files: state.changes.length,
    selectedFile: Boolean(selectedPath),
    patchBytes: Buffer.byteLength(result.patch, 'utf8'),
    truncated: result.truncated,
  });
  return result;
}

function listCases(casesRoot) {
  const requestedRoot = path.resolve(String(casesRoot || ''));
  if (!fs.existsSync(requestedRoot)) {
    return { name: 'PieceMaker', root: requestedRoot, branch: 'Dossiers indépendants', head: '', shortHead: '', folders: [], changes: [] };
  }
  const root = resolveCasesRoot(requestedRoot);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && !entry.isSymbolicLink()
      && !entry.name.startsWith('.')
      && !isTechnicalCaseDirectoryName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return {
    name: path.basename(root),
    root,
    branch: 'Dossiers indépendants',
    head: '',
    shortHead: '',
    folders: entries.map((entry) => ({ name: entry.name, path: entry.name })),
    changes: [],
  };
}

async function caseOverview(casesRoot, homeDir, caseName) {
  const startedAt = performance.now();
  const state = await workingState(casesRoot, homeDir, caseName);
  const originals = await originalFilesOverview(state.legalCase.root, { safeFiles: state.current.files });
  const folder = {
    name: state.legalCase.name,
    path: state.legalCase.name,
    changes: state.changes.length,
    workingChanges: state.changes,
    head: state.latest,
    shortHead: state.latest.slice(0, 7),
    snapshot: state.current.snapshot,
    originals,
    protectedOriginals: originals.filter((file) => file.protected).length,
  };
  logPerformance('caseOverview', startedAt, {
    files: state.current.files.length,
    changes: state.changes.length,
    originals: originals.length,
  });
  return folder;
}

async function repositoryOverview(casesRoot, homeDir = path.join(os.homedir(), '.piecemaker')) {
  const startedAt = performance.now();
  const repository = listCases(casesRoot);
  if (!repository.folders.length) {
    logPerformance('repositoryOverview', startedAt, { folders: 0 });
    return repository;
  }
  // Séquentiel : chaque dossier lance déjà une série de processus git, les
  // paralléliser en ferait exploser le nombre sur un poste de travail.
  const folders = [];
  for (const entry of repository.folders) {
    folders.push(await caseOverview(repository.root, homeDir, entry.name));
  }
  const result = { ...repository, folders };
  logPerformance('repositoryOverview', startedAt, {
    folders: folders.length,
    workingChanges: folders.reduce((count, folder) => count + folder.workingChanges.length, 0),
    originals: folders.reduce((count, folder) => count + folder.originals.length, 0),
  });
  return result;
}

function safeDestination(legalCase, relativePath) {
  const normalized = validateRelativeSafePath(legalCase, relativePath);
  let current = legalCase.root;
  const parts = normalized.split('/');
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Restauration refusée à travers un lien symbolique.');
  }
  return { normalized, absolute: path.join(legalCase.root, ...parts) };
}

async function restoreRevision({ casesRoot, caseName, homeDir = path.join(os.homedir(), '.piecemaker'), hash } = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const meta = await revisionMetadata(legalCase, gitDir, hash);
  const safety = await createCommit({
    casesRoot: legalCase.casesRoot,
    caseName: legalCase.name,
    homeDir,
    label: `Sauvegarde avant restauration de ${meta.shortHash}`,
    event: 'before-restore',
  });
  if (safety.skipped === 'busy') throw new Error('Un commit est déjà en cours. Réessayez dans quelques secondes.');

  const targetFiles = (await runGit(legalCase.root, ['ls-tree', '-r', '--name-only', meta.commit], { gitDir })).stdout
    .split(/\r?\n/)
    .filter((relative) => relative && relative !== DOCX_MANIFEST_PATH);
  const targetSet = new Set(targetFiles);
  for (const relative of await safeCaseFiles(legalCase.root)) {
    if (!targetSet.has(relative)) fs.unlinkSync(safeDestination(legalCase, relative).absolute);
  }
  for (const relative of targetFiles) {
    const destination = safeDestination(legalCase, relative);
    fs.mkdirSync(path.dirname(destination.absolute), { recursive: true });
    const content = (await runGit(legalCase.root, ['show', `${meta.commit}:${destination.normalized}`], { gitDir, encoding: null })).stdout;
    const temporary = `${destination.absolute}.piecemaker-${process.pid}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, destination.absolute);
  }

  const restoredState = await createCommit({
    casesRoot: legalCase.casesRoot,
    caseName: legalCase.name,
    homeDir,
    label: `Restauration de ${meta.shortHash} · ${meta.subject}`,
    event: 'restore',
  });
  return {
    restored: true,
    revision: meta.commit,
    safetyCommit: safety.commit || null,
    restorationCommit: restoredState.commit || null,
    changes: (await workingState(legalCase.casesRoot, homeDir, legalCase.name)).changes,
    originalsPreserved: true,
  };
}

module.exports = {
  COMMIT_USER_NAME_KEY,
  GLOBAL_ENV_FILE,
  IDENTITY_CONFIG_FILE,
  SAFE_EXTENSIONS,
  readCommitIdentityConfig,
  caseOverview,
  checkoutHistoryBranch,
  createCommit,
  createHistoryBranch,
  historyBranches,
  historyMonths,
  historyRepo,
  isProtectedFile,
  isTechnicalCaseDirectoryName,
  listCases,
  logPerformance,
  listHistory,
  listHistoryPeriod,
  locateCaseFile,
  parseCommitTrailers,
  originalFilesOverview,
  repositoryOverview,
  resolveCommitIdentity,
  resolveCase,
  resolveCasesRoot,
  restoreRevision,
  revisionDetails,
  runGit,
  safeCaseFiles,
  worktreeDetails,
};

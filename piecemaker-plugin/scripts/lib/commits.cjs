/** Full-state Git commit history for independent PieceMaker legal matters. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
const SAFE_EXTENSIONS = new Set(['.md', '.json']);

async function runGit(cwd, args, { gitDir, workTree, env = {}, input, allowFailure = false, encoding = 'utf8' } = {}) {
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

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > MAX_GIT_BUFFER) {
        if (!failure) {
          failure = new Error(`git ${args[0]} a produit une sortie trop volumineuse`);
          child.kill();
        }
        return;
      }
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => errChunks.push(chunk));
    child.on('error', (error) => { failure = failure || error; });
    child.on('close', (code) => {
      const rawStdout = Buffer.concat(outChunks);
      const rawStderr = Buffer.concat(errChunks).toString('utf8');
      const stdout = encoding === null ? rawStdout : rawStdout.toString('utf8').trimEnd();
      const stderr = encoding === null ? rawStderr : rawStderr.trim();
      const status = failure ? null : code;
      if (!allowFailure && ((status ?? 1) !== 0 || failure)) {
        reject(new Error(stderr.trim() || rawStdout.toString('utf8') || failure?.message || `git ${args[0]} a échoué`));
        return;
      }
      resolve({ code: status ?? 1, stdout, stderr, error: failure });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : input);
  });
}

function normalizeOriginalName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

function isOriginalDirectoryName(value) {
  return normalizeOriginalName(value) === 'pieces originales';
}

function isProtectedOriginalPath(filePath, casesRoot = '') {
  if (!filePath) return false;
  const candidate = path.resolve(String(filePath));
  const root = casesRoot ? path.resolve(String(casesRoot)) : null;
  if (root && candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return false;
  const relative = root ? path.relative(root, candidate) : candidate;
  return relative.split(path.sep).some(isOriginalDirectoryName);
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
  if (isProtectedOriginalPath(absolute, legalCase.root)) {
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
  const root = await fsp.realpath(caseRoot);
  const files = [];
  let bytes = 0;

  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || isOriginalDirectoryName(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
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
  return files.sort((a, b) => a.localeCompare(b, 'fr'));
}

function documentKey(filePath) {
  return normalizeOriginalName(path.basename(filePath, path.extname(filePath))).replaceAll(' ', '-');
}

async function originalFilesOverview(caseRoot) {
  const root = await fsp.realpath(caseRoot);
  const safeFiles = await safeCaseFiles(root);
  const markdownKeys = new Set(safeFiles.filter((file) => path.extname(file).toLowerCase() === '.md').map(documentKey));
  const scanKeys = new Set(
    safeFiles
      .filter((file) => file.toLowerCase().endsWith('_sensitive_map.json'))
      .map((file) => documentKey(file).replace(/-sensitive-map$/, ''))
  );
  const originals = [];

  async function visit(directory, prefix = '') {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(absolute);
      const key = documentKey(entry.name);
      const converted = markdownKeys.has(key);
      const scanned = converted && scanKeys.has(key);
      originals.push({
        name: entry.name,
        path: relative,
        extension: path.extname(entry.name).toLowerCase(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        converted,
        scanned,
        protected: converted && scanned,
        status: converted ? (scanned ? 'protected' : 'awaiting-scan') : 'not-converted',
      });
    }
  }

  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && isOriginalDirectoryName(entry.name)) {
      await visit(path.join(root, entry.name));
    }
  }
  return originals.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
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
  }
  const main = await runGit(legalCase.root, ['rev-parse', '--verify', HISTORY_REF], { gitDir, allowFailure: true });
  if (main.code !== 0) {
    const legacy = await runGit(legalCase.root, ['rev-parse', '--verify', LEGACY_HISTORY_REF], { gitDir, allowFailure: true });
    if (legacy.code === 0) await runGit(legalCase.root, ['update-ref', HISTORY_REF, legacy.stdout], { gitDir });
  }
  return gitDir;
}

async function latestCommit(legalCase, gitDir) {
  const result = await runGit(legalCase.root, ['rev-parse', '--verify', HISTORY_REF], { gitDir, allowFailure: true });
  return result.code === 0 ? result.stdout : '';
}

async function withCaseLock(homeDir, legalCase, callback) {
  const directory = historyDirectory(homeDir);
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, `${historyId(legalCase)}.lock`);
  let fd;
  try {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age < 60_000) return { created: false, skipped: 'busy' };
      fs.unlinkSync(lock);
      fd = fs.openSync(lock, 'wx');
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

async function buildCurrentTree(legalCase, gitDir, homeDir) {
  const temporaryIndex = path.join(historyDirectory(homeDir), `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: temporaryIndex };
  const files = await safeCaseFiles(legalCase.root);
  try {
    await runGit(legalCase.root, ['read-tree', '--empty'], { gitDir, workTree: legalCase.root, env });
    for (let index = 0; index < files.length; index += 100) {
      await runGit(legalCase.root, ['add', '-f', '--', ...files.slice(index, index + 100)], { gitDir, workTree: legalCase.root, env });
    }
    const tree = (await runGit(legalCase.root, ['write-tree'], { gitDir, workTree: legalCase.root, env })).stdout;
    return { tree, files };
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

async function diffTrees(legalCase, gitDir, from, to) {
  const raw = (await runGit(legalCase.root, ['diff-tree', '--no-commit-id', '--name-status', '-r', from, to], { gitDir })).stdout;
  return parseNameStatus(raw).map((file) => ({ ...file, kind: statusKind(file.status) }));
}

async function workingState(casesRoot, homeDir, caseName) {
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const latest = await latestCommit(legalCase, gitDir);
  const current = await buildCurrentTree(legalCase, gitDir, homeDir);
  const base = latest || await emptyTree(legalCase, gitDir);
  return { legalCase, gitDir, latest, current, base, changes: await diffTrees(legalCase, gitDir, base, current.tree) };
}

async function createCommit({
  casesRoot,
  caseName,
  homeDir = path.join(os.homedir(), '.piecemaker'),
  label = 'Commit PieceMaker',
  sessionId = null,
  event = 'manual',
} = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  const safeLabel = String(label || 'Commit PieceMaker').replace(/[\r\n]+/g, ' ').trim().slice(0, 140);
  return withCaseLock(homeDir, legalCase, async () => {
    const gitDir = await ensureHistoryRepo(homeDir, legalCase);
    const parent = await latestCommit(legalCase, gitDir);
    const current = await buildCurrentTree(legalCase, gitDir, homeDir);
    const parentTree = parent
      ? (await runGit(legalCase.root, ['rev-parse', `${parent}^{tree}`], { gitDir })).stdout
      : await emptyTree(legalCase, gitDir);
    if (current.tree === parentTree) {
      return { created: false, commit: parent || null, caseName: legalCase.name, files: [] };
    }

    const timestamp = new Date().toISOString();
    const message = `${safeLabel || 'Commit PieceMaker'}\n`;
    const identity = {
      GIT_AUTHOR_NAME: 'PieceMaker',
      GIT_AUTHOR_EMAIL: 'commits@piecemaker.local',
      GIT_COMMITTER_NAME: 'PieceMaker',
      GIT_COMMITTER_EMAIL: 'commits@piecemaker.local',
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    };
    const args = ['commit-tree', current.tree, ...(parent ? ['-p', parent] : [])];
    const commit = (await runGit(legalCase.root, args, { gitDir, env: identity, input: message })).stdout;
    await runGit(legalCase.root, ['update-ref', HISTORY_REF, commit, ...(parent ? [parent] : [])], { gitDir });
    const files = await diffTrees(legalCase, gitDir, parentTree, current.tree);
    return {
      created: true,
      commit,
      parent: parent || null,
      timestamp,
      label: safeLabel || 'Commit PieceMaker',
      sessionId,
      event,
      caseName: legalCase.name,
      files,
    };
  });
}

function parseLog(raw) {
  return String(raw || '').split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const lines = record.split(/\r?\n/).filter(Boolean);
    const [hash, shortHash, author, timestamp, ...subject] = (lines.shift() || '').split('\x1f');
    return {
      hash,
      shortHash,
      author,
      timestamp,
      subject: subject.join(' '),
      kind: 'commit',
      files: lines,
      filesCount: lines.length,
    };
  }).filter((entry) => entry.hash);
}

async function listHistory(casesRoot, homeDir, { caseName, limit = 120 } = {}) {
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  if (!await latestCommit(legalCase, gitDir)) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 250);
  const raw = (await runGit(legalCase.root, [
    'log', `--max-count=${safeLimit}`, '--date=iso-strict', '--no-renames',
    '--pretty=format:%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s', '--name-only', HISTORY_REF,
  ], { gitDir })).stdout;
  return parseLog(raw);
}

function validateRelativeSafePath(legalCase, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('Chemin de fichier invalide.');
  }
  const absolute = path.join(legalCase.root, ...normalized.split('/'));
  if (isProtectedOriginalPath(absolute, legalCase.root) || !SAFE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    throw new Error('Ce fichier n’est pas accessible à l’IA.');
  }
  return normalized;
}

async function revisionMetadata(legalCase, gitDir, hash) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(hash || ''))) throw new Error('Identifiant de révision invalide.');
  const commit = (await runGit(legalCase.root, ['rev-parse', '--verify', `${hash}^{commit}`], { gitDir })).stdout;
  if ((await runGit(legalCase.root, ['merge-base', '--is-ancestor', commit, HISTORY_REF], { gitDir, allowFailure: true })).code !== 0) {
    throw new Error('Cette révision ne fait pas partie de ce dossier juridique.');
  }
  const raw = (await runGit(legalCase.root, ['show', '-s', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', commit], { gitDir })).stdout;
  const [fullHash, shortHash, author, timestamp, ...subject] = raw.split('\x1f');
  return { commit, hash: fullHash, shortHash, author, timestamp, subject: subject.join(' ') };
}

async function fileStats(legalCase, gitDir, commit) {
  const stats = new Map();
  const raw = (await runGit(legalCase.root, ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', commit], { gitDir })).stdout;
  for (const line of raw.split(/\r?\n/)) {
    const [added, deleted, changedPath] = line.split('\t');
    if (changedPath) stats.set(changedPath, { added: added === '-' ? null : Number(added), deleted: deleted === '-' ? null : Number(deleted) });
  }
  return stats;
}

async function revisionDetails(casesRoot, homeDir, caseName, hash, filePath = '') {
  const legalCase = resolveCase(casesRoot, caseName);
  const gitDir = await ensureHistoryRepo(homeDir, legalCase);
  const meta = await revisionMetadata(legalCase, gitDir, hash);
  const stats = await fileStats(legalCase, gitDir, meta.commit);
  const nameStatus = (await runGit(legalCase.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', meta.commit], { gitDir })).stdout;
  const files = parseNameStatus(nameStatus)
    .map((file) => ({ ...file, kind: statusKind(file.status), ...(stats.get(file.path) || {}) }));
  const selectedPath = filePath ? validateRelativeSafePath(legalCase, filePath) : '';
  if (selectedPath && !files.some((file) => file.path === selectedPath)) throw new Error('Ce fichier ne fait pas partie de cette révision.');
  const args = ['show', '--format=', '--no-ext-diff', '--unified=3', meta.commit, ...(selectedPath ? ['--', selectedPath] : [])];
  const patchRaw = (await runGit(legalCase.root, args, { gitDir })).stdout;
  return {
    ...meta,
    kind: 'commit',
    files,
    selectedPath,
    patch: patchRaw.slice(0, MAX_PATCH_BYTES),
    truncated: patchRaw.length > MAX_PATCH_BYTES,
  };
}

async function worktreeDetails(casesRoot, homeDir, caseName, filePath = '') {
  const state = await workingState(casesRoot, homeDir, caseName);
  const selectedPath = filePath ? validateRelativeSafePath(state.legalCase, filePath) : '';
  if (selectedPath && !state.changes.some((file) => file.path === selectedPath)) {
    throw new Error('Ce fichier ne fait pas partie des modifications actuelles.');
  }
  const patchRaw = (await runGit(state.legalCase.root, [
    'diff', '--no-ext-diff', '--unified=3', state.base, state.current.tree,
    ...(selectedPath ? ['--', selectedPath] : []),
  ], { gitDir: state.gitDir })).stdout;
  return {
    hash: 'WORKTREE',
    shortHash: '',
    author: 'Modifications locales',
    timestamp: new Date().toISOString(),
    subject: 'Modifications depuis le dernier commit',
    kind: 'worktree',
    files: state.changes,
    selectedPath,
    patch: patchRaw.slice(0, MAX_PATCH_BYTES),
    truncated: patchRaw.length > MAX_PATCH_BYTES,
  };
}

async function repositoryOverview(casesRoot, homeDir = path.join(os.homedir(), '.piecemaker')) {
  const requestedRoot = path.resolve(String(casesRoot || ''));
  if (!fs.existsSync(requestedRoot)) {
    return { name: 'PieceMaker', root: requestedRoot, branch: 'Dossiers indépendants', head: '', shortHead: '', folders: [], changes: [] };
  }
  const root = resolveCasesRoot(requestedRoot);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !isOriginalDirectoryName(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  // Séquentiel : chaque dossier lance déjà une série de processus git, les
  // paralléliser en ferait exploser le nombre sur un poste de travail.
  const folders = [];
  for (const entry of entries) {
    const state = await workingState(root, homeDir, entry.name);
    const originals = await originalFilesOverview(state.legalCase.root);
    folders.push({
      name: entry.name,
      path: entry.name,
      changes: state.changes.length,
      workingChanges: state.changes,
      head: state.latest,
      shortHead: state.latest.slice(0, 7),
      originals,
      protectedOriginals: originals.filter((file) => file.protected).length,
    });
  }
  return { name: path.basename(root), root, branch: 'Dossiers indépendants', head: '', shortHead: '', folders, changes: [] };
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

  const targetFiles = (await runGit(legalCase.root, ['ls-tree', '-r', '--name-only', meta.commit], { gitDir })).stdout.split(/\r?\n/).filter(Boolean);
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
  SAFE_EXTENSIONS,
  createCommit,
  historyRepo,
  isOriginalDirectoryName,
  isProtectedOriginalPath,
  listHistory,
  locateCaseFile,
  originalFilesOverview,
  repositoryOverview,
  resolveCase,
  resolveCasesRoot,
  restoreRevision,
  revisionDetails,
  runGit,
  safeCaseFiles,
  worktreeDetails,
};

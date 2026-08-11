const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('node:perf_hooks');
const { configuredWorkspacePath } = require('./workspace-paths.cjs');
const {
  listConfiguredCases,
  readRegistryConfig,
  registerCaseFolder,
  resolveCaseReference,
  validateSelectedCaseFolder,
} = require('./case-registry.cjs');
const { stampedPiecesDirectory } = require('./lib/stamping.cjs');
const {
  COMMIT_USER_NAME_KEY,
  caseOverview,
  checkoutHistoryBranch,
  createCommit,
  createHistoryBranch,
  historyBranches,
  isTechnicalCaseDirectoryName,
  listCases,
  listHistory,
  resolveCase,
  resolveCasesRoot,
  resolveCommitIdentity,
  restoreRevision,
  revisionDetails,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const {
  cancelOriginalsJob,
  getJob,
  listOriginals,
  readCaseMapping,
  rebuildCaseMapping,
  saveCaseMapping,
  startOriginalsJob,
  writeCaseMapping,
} = require('./originals-pipeline.cjs');
const {
  readProtection,
  writeProtection,
} = require('../piecemaker-plugin/scripts/lib/protection.cjs');
const {
  readInstitutionalTerms,
  writeInstitutionalTerms,
} = require('../piecemaker-plugin/scripts/lib/institutional-terms.cjs');
const {
  claudeAssetStatus,
  registerClaudeAsset,
  syncClaudeAssets,
} = require('./claude-assets.cjs');
const {
  controlDossierBot,
  controlTelegram,
  getTelegramState,
  saveDossierBot,
  saveTelegramConfig,
} = require('./telegram-admin.cjs');

const MAX_MARKDOWN_BYTES = 1024 * 1024;
const SECRET_KEYS = new Set([
  'LEGIFRANCE_CLIENT_ID',
  'LEGIFRANCE_CLIENT_SECRET',
]);
const ENV_KEYS = new Set([
  COMMIT_USER_NAME_KEY,
  'LEGIFRANCE_CLIENT_ID',
  'LEGIFRANCE_CLIENT_SECRET',
  'LEGIFRANCE_ENV',
  'PYTHON_PATH',
  'SMART_CONVERTER_PATH',
]);

function validateNewCaseName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 120 || name === '.' || name === '..' || path.basename(name) !== name
      || name.startsWith('.') || /[\x00-\x1f\x7f]/.test(name) || isTechnicalCaseDirectoryName(name)) {
    throw new Error('Nom de dossier juridique invalide.');
  }
  return name;
}

async function createLegalCase({ casesRoot, homeDir, name }) {
  const root = resolveCasesRoot(casesRoot);
  const safeName = validateNewCaseName(name);
  const directory = path.join(root, safeName);
  if (fs.existsSync(directory)) throw new Error(`Le dossier juridique « ${safeName} » existe déjà.`);
  fs.mkdirSync(directory);
  try {
    writeProtection(directory, { unprotected: [] });
    const mapping = writeCaseMapping(directory, { mapping: {}, reverse_mapping: {} });
    await createCommit({
      casesRoot: root,
      caseName: safeName,
      homeDir,
      label: 'Création du dossier juridique',
      event: 'admin-case-create',
      // Le mapping vit dans le sous-dossier des fichiers produits : le commit doit
      // viser son chemin relatif au dossier, pas seulement son nom de base.
      paths: [path.relative(directory, mapping.file).split(path.sep).join('/')],
      waitForLockMs: 10_000,
    });
    const folder = await caseOverview(root, homeDir, safeName);
    folder.branches = await historyBranches(root, homeDir, safeName);
    return folder;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Native folder-picker commands. Arguments stay separate from the shell. */
function folderPickerCommands(platform, initialFolder) {
  const start = path.resolve(initialFolder || os.homedir());
  if (platform === 'darwin') {
    return [{
      command: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'set initialFolder to POSIX file (item 1 of argv)',
        '-e', 'set selectedFolder to choose folder with prompt "Choisir un dossier juridique PieceMaker" default location initialFolder',
        '-e', 'return POSIX path of selectedFolder',
        '-e', 'end run',
        start,
      ],
    }];
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choisir un dossier juridique PieceMaker"',
      '$dialog.ShowNewFolderButton = $false',
      'if (Test-Path -LiteralPath $args[0]) { $dialog.SelectedPath = $args[0] }',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
    ].join('; ');
    return [{ command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script, start] }];
  }
  const withSlash = start.endsWith(path.sep) ? start : `${start}${path.sep}`;
  return [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=Choisir un dossier juridique PieceMaker', `--filename=${withSlash}`] },
    { command: 'kdialog', args: ['--getexistingdirectory', start, '--title', 'Choisir un dossier juridique PieceMaker'] },
  ];
}

function captureProcess(command, args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => resolve({ code: null, stdout: '', stderr: '', error }));
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8').trim(),
      stderr: Buffer.concat(stderr).toString('utf8').trim(),
      error: null,
    }));
  });
}

async function selectLocalFolder(platform = process.platform, initialFolder = os.homedir()) {
  let lastError = null;
  for (const candidate of folderPickerCommands(platform, initialFolder)) {
    const result = await captureProcess(candidate.command, candidate.args);
    if (result.code === 0) return result.stdout ? validateSelectedCaseFolder(result.stdout) : null;
    if (result.error?.code === 'ENOENT') {
      lastError = result.error;
      continue;
    }
    // Native dialogs use a non-zero status for an ordinary user cancellation.
    if (!result.stdout && (result.code === 1 || /cancel|annul/i.test(result.stderr))) return null;
    lastError = result.error || new Error(result.stderr || `Le sélecteur s’est arrêté avec le code ${result.code}.`);
  }
  throw new Error(`Aucun sélecteur de dossier n’est disponible sur ce poste (${lastError?.message || 'commande introuvable'}).`);
}

async function installProjectPlugin(folder) {
  const result = await captureProcess('claude', [
    'plugin', 'install', 'piecemaker@piecemaker', '--scope', 'project',
  ], { cwd: folder });
  if (result.code !== 0) {
    const detail = result.error?.code === 'ENOENT'
      ? 'Claude Code est introuvable.'
      : result.stderr || result.stdout || 'installation refusée';
    throw new Error(`Le plugin PieceMaker n’a pas pu être activé pour ce dossier : ${detail}`);
  }
  return true;
}

function caseRuleContent(repoRoot) {
  const template = path.join(repoRoot, 'installer', 'templates', 'workspace-CLAUDE.md');
  if (!fs.existsSync(template)) throw new Error('Le modèle d’instructions PieceMaker est introuvable.');
  return fs.readFileSync(template, 'utf8')
    .replace('# PieceMaker — dossiers juridiques', '# PieceMaker — dossier juridique actif')
    .replace(
      /Ce fichier est à la racine du workspace PieceMaker\.[\s\S]*?\*\*Chaque sous-dossier immédiat de cette racine est un dossier juridique\nindépendant\.\*\* Rien ne circule d'un dossier à l'autre : ni historique, ni\nmapping d'anonymisation, ni facturation\./,
      'Cette règle est installée dans le dossier juridique sélectionné. Toute session Claude Code ouverte dans ce dossier ou dans un de ses sous-dossiers la charge automatiquement. Ce répertoire constitue un dossier juridique PieceMaker indépendant : son historique, son mapping d’anonymisation et sa facturation ne circulent vers aucun autre dossier.',
    )
    .replace(
      '| Racine des dossiers | ce répertoire (`workspacePath` de `~/.piecemaker/config.json`) |',
      '| Dossier juridique actif | ce répertoire (`caseFolders` de `~/.piecemaker/config.json`) |',
    );
}

function ensureCaseRule(repoRoot, folder) {
  const target = path.join(folder, '.claude', 'rules', 'piecemaker.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // This file is PieceMaker-owned and can be refreshed safely on re-register.
  fs.writeFileSync(target, caseRuleContent(repoRoot), 'utf8');
  return target;
}

async function registerLegalCase({
  folder,
  configFile,
  repoRoot,
  homeDir,
  projectPluginInstaller = installProjectPlugin,
} = {}) {
  const root = validateSelectedCaseFolder(folder);
  await projectPluginInstaller(root);
  const rule = ensureCaseRule(repoRoot, root);
  const protection = readProtection(root);
  if (!protection.exists) writeProtection(root, { unprotected: [] });
  const currentMapping = readCaseMapping(root);
  const mapping = currentMapping.exists
    ? currentMapping
    : writeCaseMapping(root, { mapping: {}, reverse_mapping: {} });

  const previous = readRegistryConfig(configFile);
  const registered = registerCaseFolder(previous, root);
  atomicWrite(configFile, `${JSON.stringify(registered.config, null, 2)}\n`);

  const commit = await createCommit({
    casesRoot: path.dirname(root),
    caseName: path.basename(root),
    homeDir,
    label: 'Enregistrement du dossier juridique',
    event: 'admin-case-register',
    paths: [path.relative(root, mapping.file).split(path.sep).join('/')],
    waitForLockMs: 10_000,
    envFile: path.join(repoRoot, '.env'),
  });
  const folderOverview = await caseOverview(path.dirname(root), homeDir, path.basename(root));
  folderOverview.path = registered.entry.id;
  folderOverview.location = root;
  folderOverview.registered = true;
  folderOverview.branches = await historyBranches(path.dirname(root), homeDir, path.basename(root));
  return {
    folder: folderOverview,
    installed: {
      plugin: true,
      rule: path.relative(root, rule).split(path.sep).join('/'),
      mapping: path.relative(root, mapping.file).split(path.sep).join('/'),
      protection: path.relative(root, protection.file).split(path.sep).join('/'),
      commit: commit.commit || null,
    },
  };
}

function defaultConfig(repoRoot, homeDir = path.join(os.homedir(), '.piecemaker')) {
  return {
    workspacePath: null,
    outputPath: null,
    port: 43098,
    pythonPath: null,
    venvPath: path.join(homeDir, 'venv'),
  };
}

function readJson(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, content, mode = undefined) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content, { encoding: 'utf8', ...(mode ? { mode } : {}) });
  fs.renameSync(temp, file);
  if (mode) {
    try {
      fs.chmodSync(file, mode);
    } catch {
      // Windows does not implement POSIX file modes.
    }
  }
}

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function updateEnvFile(file, updates, clearKeys = []) {
  const clear = new Set(clearKeys.filter((key) => SECRET_KEYS.has(key)));
  const cleanUpdates = new Map();
  for (const [key, rawValue] of Object.entries(updates || {})) {
    if (!ENV_KEYS.has(key)) continue;
    const value = String(rawValue ?? '').trim();
    if (!value || SECRET_KEYS.has(key) && value === '********') continue;
    if (/\r|\n/.test(value)) throw new Error(`Valeur invalide pour ${key}`);
    cleanUpdates.set(key, value);
  }

  if (cleanUpdates.has(COMMIT_USER_NAME_KEY)) {
    resolveCommitIdentity({ identity: { name: cleanUpdates.get(COMMIT_USER_NAME_KEY) } });
  }

  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const lines = [];
  for (const line of original) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) {
      if (line || lines.length) lines.push(line);
      continue;
    }
    const key = match[1];
    if (clear.has(key)) continue;
    if (cleanUpdates.has(key)) {
      lines.push(`${key}=${cleanUpdates.get(key)}`);
      cleanUpdates.delete(key);
      seen.add(key);
    } else {
      lines.push(line);
      seen.add(key);
    }
  }
  for (const [key, value] of cleanUpdates) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  while (lines.at(-1) === '') lines.pop();
  atomicWrite(file, `${lines.join('\n')}\n`, 0o600);
}

function maskSecret(value) {
  if (!value) return { configured: false, hint: '' };
  const suffix = value.length > 4 ? value.slice(-4) : '';
  return { configured: true, hint: suffix ? `••••${suffix}` : 'configurée' };
}

function normalizeManagedPath(relativePath) {
  return String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function managedFileKind(relativePath) {
  const normalized = normalizeManagedPath(relativePath);
  if (normalized === 'AGENTS.md' || normalized === 'CLAUDE.md') return 'instructions';
  if (/^piecemaker-plugin\/agents\/[^/]+\.md$/.test(normalized)) return 'agent';
  if (/^piecemaker-plugin\/skills\/[^/]+\/SKILL\.md$/.test(normalized)) return 'skill';
  if (/^billing\/synthese\/[^/]+\.md$/.test(normalized)) return 'billing';
  if (/^billing\/\d{4}-\d{2}\.jsonl$/.test(normalized)) return 'billing';
  return null;
}

function nearestExistingPath(value) {
  let current = value;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}

function managedAbsolutePath(repoRoot, relativePath, homeDir = path.join(os.homedir(), '.piecemaker')) {
  const normalized = normalizeManagedPath(relativePath);
  const kind = managedFileKind(normalized);
  if (!kind) throw new Error('Ce fichier ne fait pas partie des fichiers administrables.');
  const synthesis = normalized.startsWith('billing/synthese/');
  const root = kind === 'billing'
    ? path.resolve(homeDir, 'billing', ...(synthesis ? ['synthese'] : []))
    : path.resolve(repoRoot);
  const relative = kind === 'billing'
    ? normalized.replace(/^billing\/(?:synthese\/)?/, '')
    : normalized;
  const absolute = path.resolve(root, ...relative.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('Chemin de fichier invalide.');
  }
  const existing = nearestExistingPath(absolute);
  const realRoot = fs.realpathSync(nearestExistingPath(root));
  const realExisting = fs.realpathSync(existing);
  if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Le fichier résout vers un emplacement extérieur au dépôt.');
  }
  if (kind === 'billing' && !fs.existsSync(absolute)) throw new Error('Rapport de facturation introuvable.');
  return { normalized, absolute };
}

// Les instructions, skills et agents seulement : les aperçus de facturation
// vivent dans ~/.piecemaker/billing, une hiérarchie distincte du dépôt, et ne
// sont pas listés dans l'éditeur « Skills et agents ».
function listManagedFiles(repoRoot, homeDir = path.join(os.homedir(), '.piecemaker'), userHome = os.homedir()) {
  const candidates = ['AGENTS.md', 'CLAUDE.md'];
  const agentsDir = path.join(repoRoot, 'piecemaker-plugin', 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const name of fs.readdirSync(agentsDir).filter((entry) => entry.endsWith('.md')).sort()) {
      candidates.push(`piecemaker-plugin/agents/${name}`);
    }
  }
  const skillsDir = path.join(repoRoot, 'piecemaker-plugin', 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir).sort()) {
      const relative = `piecemaker-plugin/skills/${name}/SKILL.md`;
      if (fs.existsSync(path.join(repoRoot, ...relative.split('/')))) candidates.push(relative);
    }
  }

  return candidates.map((relativePath) => {
    const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
    const kind = managedFileKind(normalized);
    return {
      path: normalized,
      name: normalized === 'AGENTS.md' || normalized === 'CLAUDE.md'
        ? normalized
        : path.basename(path.dirname(normalized)) === 'agents'
          ? path.basename(normalized, '.md')
          : path.basename(path.dirname(normalized)),
      kind,
      exists: fs.existsSync(absolute),
      readonly: false,
      // Visibilité côté Claude Code (voir claude-assets.cjs) — null pour les
      // fichiers qui ne sont pas des composants de plugin.
      claudeCode: claudeAssetStatus(repoRoot, userHome, normalized),
    };
  });
}

function billingLedgerToMarkdown(file) {
  const month = path.basename(file, '.jsonl');
  const entries = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const clean = (value) => String(value ?? '—').replace(/[\r\n|]+/g, ' ').trim() || '—';
  const duration = (ms) => Number.isFinite(ms)
    ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`
    : '—';
  const rows = entries.map((entry) => {
    const date = entry.timestamp ? new Date(entry.timestamp).toLocaleString('fr-FR') : '—';
    const tools = Object.entries(entry.tool_counts || {}).map(([name, count]) => `${name} (${count})`).join(', ') || '—';
    return `| ${clean(date)} | ${clean(entry.event)} | ${clean(entry.task_label)} | ${clean(entry.dossier)} | ${duration(entry.duration_ms)} | ${clean(tools)} |`;
  });
  return [
    `# Suivi de facturation — ${month}`,
    '',
    `${entries.length} événement(s) enregistré(s). Aperçu généré depuis le journal mensuel en lecture seule.`,
    '',
    '| Date | Événement | Tâche | Dossier | Durée | Outils |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function readManagedFile(repoRoot, relativePath, homeDir = path.join(os.homedir(), '.piecemaker')) {
  const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  const exists = fs.existsSync(absolute);
  const kind = managedFileKind(normalized);
  return {
    path: normalized,
    kind,
    exists,
    content: exists
      ? normalized.endsWith('.jsonl') ? billingLedgerToMarkdown(absolute) : fs.readFileSync(absolute, 'utf8')
      : '',
    readonly: kind === 'billing',
    sourceType: normalized.endsWith('.jsonl') ? 'billing-ledger' : 'markdown',
  };
}

function backupFile(source, relativePath, homeDir) {
  if (!fs.existsSync(source)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(homeDir, 'backups', stamp, ...normalizeManagedPath(relativePath).split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function saveManagedFile(repoRoot, homeDir, relativePath, content) {
  if (typeof content !== 'string') throw new Error('Le contenu Markdown est requis.');
  if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('Le fichier dépasse la limite de 1 Mo.');
  }
  if (managedFileKind(relativePath) === 'billing') throw new Error('Les rapports de facturation sont en lecture seule.');
  const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  const backup = backupFile(absolute, normalized, homeDir);
  atomicWrite(absolute, content.endsWith('\n') ? content : `${content}\n`);
  return { path: normalized, backup, savedAt: new Date().toISOString() };
}

// Modèles acceptés dans le front matter d'un agent Claude Code. « inherit »
// reprend le modèle de la session appelante.
const AGENT_MODELS = ['inherit', 'haiku', 'sonnet', 'opus'];
const DEFAULT_AGENT_TOOLS = 'Read, Grep, Glob';

/**
 * Un agent n'a pas le même front matter qu'un skill : il déclare en plus les
 * outils auxquels il a droit et le modèle qui l'exécute. On valide donc ces
 * deux champs ici plutôt que de recopier le gabarit d'un skill.
 * Une liste d'outils vide signifie « hérite de tous les outils » : la clé est
 * alors omise, ce que Claude Code interprète ainsi.
 */
function normalizeAgentTools(value) {
  if (value === undefined || value === null) return DEFAULT_AGENT_TOOLS;
  const tools = String(value)
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
  const seen = [];
  for (const tool of tools) {
    // « Bash(git status:*) » : nom d'outil, éventuellement suivi d'un motif.
    if (!/^[A-Za-z][A-Za-z0-9_-]*(\([^()\n]*\))?$/.test(tool)) {
      throw new Error(`Outil invalide : « ${tool} ». Utilisez des noms comme Read, Grep, Glob ou Bash(git *).`);
    }
    if (!seen.includes(tool)) seen.push(tool);
  }
  if (seen.length > 30) throw new Error('Trop d\u2019outils déclarés pour un agent (30 maximum).');
  return seen.join(', ');
}

function normalizeAgentModel(value) {
  const model = String(value ?? 'sonnet').trim().toLowerCase() || 'sonnet';
  if (!AGENT_MODELS.includes(model)) {
    throw new Error(`Modèle inconnu : « ${model} ». Choisissez ${AGENT_MODELS.join(', ')}.`);
  }
  return model;
}

function agentTemplate(slug, title, summary, tools, model) {
  const metadata = [
    `name: ${slug}`,
    `description: ${JSON.stringify(summary)}`,
    ...(tools ? [`tools: ${tools}`] : []),
    `model: ${model}`,
  ].join('\n');
  const toolLine = tools
    ? `Outils autorisés : ${tools}.`
    : 'Aucune restriction d\u2019outils : l\u2019agent hérite de ceux de la session.';
  return `---\n${metadata}\n---\n\n# ${title}\n\n`
    + `Vous êtes un sous-agent PieceMaker lancé pour une tâche précise, dans sa\n`
    + `propre fenêtre de contexte. Décrivez ci-dessous votre rôle et vos règles.\n\n`
    + `## Mission\n\n${summary}\n\n`
    + `## Déroulé attendu\n\n`
    + `1. Rassemblez le contexte nécessaire (documents, mapping, dossier).\n`
    + `2. Effectuez l\u2019analyse ou la production demandée.\n`
    + `3. Renvoyez un rapport final autonome : l\u2019agent appelant ne voit pas vos étapes intermédiaires.\n\n`
    + `## Contraintes\n\n`
    + `- ${toolLine}\n`
    + `- Ne levez jamais une anonymisation existante : travaillez sur les codes tels quels.\n`
    + `- Ne citez aucun texte de loi ni jurisprudence de mémoire.\n`;
}

function skillTemplate(slug, title, summary) {
  const metadata = `name: ${slug}\ndescription: ${JSON.stringify(summary)}`;
  return `---\n${metadata}\n---\n\n# ${title}\n\n`
    + `${summary}\n\n`
    + `## Quand utiliser ce skill\n\nDécrivez les situations qui doivent déclencher ce skill.\n\n`
    + `## Déroulé\n\n1. Première étape.\n2. Deuxième étape.\n\n`
    + `## Points de vigilance\n\n- Ce qu\u2019il ne faut jamais faire.\n`;
}

function createManagedFile(repoRoot, homeDir, { kind, slug, name, description, tools, model } = {}) {
  if (!['skill', 'agent'].includes(kind)) throw new Error('Choisissez « skill » ou « agent ».');
  const safeSlug = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeSlug)) {
    throw new Error('L\u2019identifiant doit contenir uniquement des minuscules, chiffres et tirets.');
  }
  const title = String(name || safeSlug).replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || safeSlug;
  const summary = String(description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
  if (!summary) throw new Error('Une description est requise pour que l\u2019agent sache quand utiliser ce fichier.');
  const relativePath = kind === 'skill'
    ? `piecemaker-plugin/skills/${safeSlug}/SKILL.md`
    : `piecemaker-plugin/agents/${safeSlug}.md`;
  const { absolute } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  if (fs.existsSync(absolute)) throw new Error('Un fichier portant cet identifiant existe déjà.');
  const content = kind === 'skill'
    ? skillTemplate(safeSlug, title, summary)
    : agentTemplate(safeSlug, title, summary, normalizeAgentTools(tools), normalizeAgentModel(model));
  saveManagedFile(repoRoot, homeDir, relativePath, content);
  return readManagedFile(repoRoot, relativePath, homeDir);
}

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

function legalWorkspaceDirectory(repoRoot, homeDir) {
  return configuredWorkspacePath(homeDir);
}

function finishAdminTiming(res, metric, startedAt, details = {}) {
  const durationMs = Number((performance.now() - startedAt).toFixed(1));
  res.set('Server-Timing', `${metric};dur=${durationMs}`);
  if (process.env.PIECEMAKER_PERF_LOG === '1' || durationMs >= 250) {
    const write = durationMs >= 250 ? console.warn : console.log;
    write(`[PM-PERF] admin.${metric}`, { durationMs, ...details });
  }
}

/**
 * Dossiers tamponnables : un par `compilation_dossier_<documentId>.json` écrit
 * dans le dossier de sortie (voir server.cjs). `folder` est le dossier de
 * travail (celui du document Word), où les pièces tamponnées sont écrites dans
 * le sous-dossier « Pièces tamponnées ». Seules les métadonnées utiles au bordereau sont
 * renvoyées — jamais `texte_integral`, qui contient les pièces en clair.
 */
// Les pièces à tamponner ne viennent plus d'un `compilation_dossier_*.json`
// (produit par l'ancien chargement de dossier depuis Word) : la logique s'appuie
// désormais sur les dossiers juridiques enregistrés, quelle que soit leur place
// dans l'arborescence. Chaque dossier expose ses pièces originales — tout fichier
// qui n'est ni `.md` ni `.json` —, identifiées par leur chemin relatif au dossier.
async function listDossiers(repoRoot, homeDir) {
  const config = readRegistryConfig(path.join(homeDir, 'config.json'));
  const dossiers = [];
  for (const entry of listConfiguredCases(config)) {
    let originals;
    try {
      originals = await listOriginals(entry.root);
    } catch {
      // Dossier déplacé/illisible pendant l'inventaire : on l'omet simplement.
      continue;
    }
    if (!originals.length) continue;
    dossiers.push({
      documentId: entry.id,
      informations: { intitule: entry.name },
      folder: entry.root,
      stampedDir: stampedPiecesDirectory(entry.root),
      documents: originals.map((file) => ({
        id: file.path,
        filename: file.path,
        type_document: (file.extension || '').replace(/^\./, '').toUpperCase(),
        date_document: '',
      })),
    });
  }
  return dossiers;
}

const REVEAL_TARGETS = new Set(['files', 'terminal']);

/**
 * Commandes candidates pour montrer un dossier du poste de travail, essayées
 * dans l'ordre jusqu'à ce que l'une démarre. Fonction pure : `platform` suit la
 * convention de `process.platform`, aucun chemin n'est concaténé dans une
 * chaîne de shell (les arguments partent tels quels à `spawn`, sans `shell`).
 */
function revealCommands(platform, target, absolutePath) {
  if (!REVEAL_TARGETS.has(target)) throw new Error('Action de dossier inconnue.');
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (!isAbsolute(String(absolutePath || ''))) throw new Error('Chemin de dossier invalide.');
  if (platform === 'darwin') {
    return target === 'terminal'
      ? [{ command: 'open', args: ['-a', 'Terminal', absolutePath] }]
      // `-R` révèle le dossier dans sa fenêtre parente, comme « Afficher dans le Finder ».
      : [{ command: 'open', args: ['-R', absolutePath] }];
  }
  if (platform === 'win32') {
    return target === 'terminal'
      ? [
        { command: 'wt.exe', args: ['-d', absolutePath] },
        // Repli sans Windows Terminal : PowerShell ouvre l'invite de commandes
        // dans le dossier, `-WorkingDirectory` évite tout `cd` à échapper.
        { command: 'powershell.exe', args: ['-NoProfile', '-Command', `Start-Process -FilePath cmd.exe -WorkingDirectory '${absolutePath.replace(/'/g, "''")}'`] },
      ]
      : [{ command: 'explorer.exe', args: [`/select,${absolutePath}`] }];
  }
  return target === 'terminal'
    ? [
      { command: 'x-terminal-emulator', args: [`--working-directory=${absolutePath}`] },
      { command: 'gnome-terminal', args: [`--working-directory=${absolutePath}`] },
      { command: 'konsole', args: ['--workdir', absolutePath] },
      { command: 'xterm', args: ['-e', 'sh', '-c', 'cd "$0" && exec "${SHELL:-/bin/sh}"', absolutePath] },
    ]
    : [{ command: 'xdg-open', args: [absolutePath] }];
}

function spawnDetached({ command, args }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    // `spawn` confirme le démarrage : le processus survit ensuite à PieceMaker.
    child.once('spawn', () => {
      child.unref();
      resolve(command);
    });
  });
}

async function revealLocalFolder(platform, target, absolutePath) {
  const candidates = revealCommands(platform, target, absolutePath);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await spawnDetached(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(target === 'terminal'
    ? `Aucun terminal n’a pu être ouvert sur ce poste (${lastError?.message || 'commande introuvable'}).`
    : `Le gestionnaire de fichiers n’a pas pu être ouvert (${lastError?.message || 'commande introuvable'}).`);
}

function createAdminRouter({
  repoRoot = path.resolve(__dirname, '..'),
  homeDir = path.join(os.homedir(), '.piecemaker'),
  userHome = os.homedir(),
  getRuntimeStatus = () => ({}),
  pickFolder = selectLocalFolder,
  projectPluginInstaller = installProjectPlugin,
} = {}) {
  // Lazy import keeps the pure filesystem/Git helpers testable before npm
  // dependencies are installed. The running server already depends on Express.
  const express = require('express');
  const router = express.Router();
  const configFile = path.join(homeDir, 'config.json');
  const envFile = path.join(repoRoot, '.env');
  const casesRoot = () => configuredWorkspacePath(homeDir);
  const registryConfig = () => readRegistryConfig(configFile);
  const selectedCase = (reference) => resolveCaseReference(registryConfig(), reference);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isLocalOrigin(req.get('Origin'))) {
      return res.status(403).json({ error: 'L’administration PieceMaker est réservée à une page locale.' });
    }
    next();
  });

  router.get('/status', (req, res) => {
    const pkg = readJson(path.join(repoRoot, 'package.json'), {});
    const files = listManagedFiles(repoRoot, homeDir, userHome);
    res.json({
      ok: true,
      version: pkg.version || 'inconnue',
      repoRoot,
      certificatesReady:
        fs.existsSync(path.join(repoRoot, 'websocket-server', 'localhost.crt')) &&
        fs.existsSync(path.join(repoRoot, 'websocket-server', 'localhost.key')),
      files: {
        skills: files.filter((file) => file.kind === 'skill').length,
        agents: files.filter((file) => file.kind === 'agent').length,
        registered: files.filter((file) => ['linked', 'copied'].includes(file.claudeCode?.state)).length,
      },
      ...getRuntimeStatus(),
    });
  });

  router.get('/settings', (req, res) => {
    const config = { ...defaultConfig(repoRoot, homeDir), ...readJson(configFile, {}) };
    const env = readEnvFile(envFile);
    const publicEnv = {};
    const secrets = {};
    for (const key of ENV_KEYS) {
      if (SECRET_KEYS.has(key)) secrets[key] = maskSecret(env[key]);
      else publicEnv[key] = env[key] || '';
    }
    res.json({ config, env: publicEnv, secrets });
  });

  router.put('/settings', (req, res) => {
    try {
      const current = { ...defaultConfig(repoRoot, homeDir), ...readJson(configFile, {}) };
      const patch = req.body?.config || {};
      const next = { ...current };

      if (patch.workspacePath !== undefined) {
        const workspacePath = String(patch.workspacePath).trim();
        if (!workspacePath || !path.isAbsolute(workspacePath)) throw new Error('Le dossier racine PieceMaker doit être un chemin absolu.');
        next.workspacePath = workspacePath;
        next.outputPath = workspacePath;
        if (next.anonymization) {
          next.anonymization = { ...next.anonymization, watchPaths: [workspacePath] };
        }
      }
      if (patch.port !== undefined) {
        const port = Number(patch.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Le port doit être compris entre 1024 et 65535.');
        next.port = port;
      }
      if (patch.pythonPath !== undefined) next.pythonPath = String(patch.pythonPath || '').trim() || null;

      atomicWrite(configFile, `${JSON.stringify(next, null, 2)}\n`);
      updateEnvFile(envFile, req.body?.env || {}, req.body?.clearSecrets || []);
      res.json({ ok: true, restartRequired: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Entités institutionnelles à ne jamais anonymiser — liste globale, éditable.
  // La détection GLiNER n'est pas touchée : ces termes sont écartés au moment de
  // bâtir le mapping (voir mapping.cjs / institutional-terms.cjs).
  router.get('/institutional-terms', (req, res) => {
    try {
      res.json(readInstitutionalTerms());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put('/institutional-terms', (req, res) => {
    try {
      const terms = req.body?.terms;
      if (!Array.isArray(terms)) throw new Error('Le corps doit contenir un tableau « terms ».');
      if (terms.length > 1000) throw new Error('Liste trop longue (1000 termes maximum).');
      res.json({ ok: true, ...writeInstitutionalTerms(terms) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/files', (req, res) => {
    res.json({ files: listManagedFiles(repoRoot, homeDir, userHome) });
  });

  router.post('/files', (req, res) => {
    try {
      const file = createManagedFile(repoRoot, homeDir, req.body);
      // Enregistrement immédiat auprès de Claude Code : sans cela le skill ou
      // l'agent n'apparaîtrait qu'après publication et « claude plugin update ».
      const claudeCode = registerClaudeAsset(repoRoot, userHome, file.path);
      res.status(201).json({ ok: true, file: { ...file, claudeCode } });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/files/sync', (req, res) => {
    try {
      res.json({ ok: true, ...syncClaudeAssets(repoRoot, userHome) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/file', (req, res) => {
    try {
      res.json(readManagedFile(repoRoot, req.query.path, homeDir));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/file', (req, res) => {
    try {
      const saved = saveManagedFile(repoRoot, homeDir, req.body?.path, req.body?.content);
      res.json({ ok: true, ...saved, claudeCode: registerClaudeAsset(repoRoot, userHome, saved.path) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/dossiers', async (req, res) => {
    try {
      res.json({
        dossiers: await listDossiers(repoRoot, homeDir),
        tamponConfigured: fs.existsSync(path.join(legalWorkspaceDirectory(repoRoot, homeDir), '.piecemaker', 'tampon.png')),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/repository', async (req, res) => {
    const startedAt = performance.now();
    try {
      const config = registryConfig();
      const entries = listConfiguredCases(config);
      const overview = {
        name: 'PieceMaker',
        root: config.workspacePath || '',
        branch: 'Dossiers enregistrés',
        head: '',
        shortHead: '',
        folders: entries.map((entry) => ({
          name: entry.name,
          path: entry.id,
          location: entry.root,
          registered: entry.registered,
        })),
        changes: [],
      };
      finishAdminTiming(res, 'repository', startedAt, { folders: overview.folders.length });
      res.json(overview);
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  router.post('/repository/cases', async (req, res) => {
    try {
      const config = registryConfig();
      const initial = config.workspacePath && fs.existsSync(config.workspacePath)
        ? config.workspacePath
        : userHome;
      const selected = await pickFolder(process.platform, initial);
      if (!selected) return res.json({ ok: true, cancelled: true });
      const result = await registerLegalCase({
        folder: selected,
        configFile,
        repoRoot,
        homeDir,
        projectPluginInstaller,
      });
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/repository/case', async (req, res) => {
    const startedAt = performance.now();
    try {
      const legalCase = selectedCase(req.query.case);
      const folder = await caseOverview(legalCase.casesRoot, homeDir, legalCase.caseName);
      folder.path = legalCase.id;
      folder.location = legalCase.root;
      folder.registered = legalCase.registered;
      // Les Markdown convertis vivent déjà dans l'historique ; ce cadre ne
      // présente que les pièces originales et un résumé non sensible du mapping.
      folder.originals = folder.originals.filter((file) => file.extension !== '.md');
      const mapping = readCaseMapping(legalCase.root);
      folder.mapping = {
        exists: mapping.exists,
        name: path.basename(mapping.file),
        entries: Object.keys(mapping.mapping).length,
      };
      folder.branches = await historyBranches(legalCase.casesRoot, homeDir, legalCase.caseName);
      finishAdminTiming(res, 'case', startedAt, {
        changes: folder.changes,
        originals: folder.originals.length,
      });
      res.json({ folder });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/branches', async (req, res) => {
    try {
      const legalCase = selectedCase(req.body?.case);
      const branches = await createHistoryBranch({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        name: req.body?.name,
      });
      if (branches.skipped === 'busy') throw new Error('L’historique est occupé. Réessayez dans quelques secondes.');
      res.status(201).json({ ok: true, ...branches });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/branches/current', async (req, res) => {
    try {
      const legalCase = selectedCase(req.body?.case);
      const branches = await checkoutHistoryBranch({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        name: req.body?.name,
      });
      if (branches.skipped === 'busy') throw new Error('L’historique est occupé. Réessayez dans quelques secondes.');
      res.json({ ok: true, ...branches });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Ouvre le dossier juridique sélectionné (ou la racine PieceMaker) dans le
  // gestionnaire de fichiers ou le terminal du poste. Le chemin est toujours
  // résolu par `resolveCase`, jamais reçu du navigateur.
  router.post('/reveal', async (req, res) => {
    try {
      const target = String(req.body?.target || '');
      if (!REVEAL_TARGETS.has(target)) throw new Error('Action de dossier inconnue.');
      const caseName = String(req.body?.case || '').trim();
      const absolute = caseName
        ? selectedCase(caseName).root
        : resolveCasesRoot(casesRoot());
      await revealLocalFolder(process.platform, target, absolute);
      res.json({ ok: true, target, path: absolute });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // ── Pièces originales : conversion Markdown et pipeline d'anonymisation ──
  // Les deux traitements sont longs (OCR, modèles NER) : la route rend la main
  // avec un identifiant de travail que l'administration interroge ensuite.

  router.post('/originals/pipeline', async (req, res) => {
    try {
      const legalCase = selectedCase(req.body?.case);
      const job = await startOriginalsJob({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        action: String(req.body?.action || ''),
        files: Array.isArray(req.body?.files) ? req.body.files : [],
        options: {
          // Sans `force`, un travail sans sélection ne refait que les pièces
          // dont le Markdown ou le scan PII manque.
          force: req.body?.force === true,
          engine: String(req.body?.engine || '').trim() || undefined,
          mode: String(req.body?.mode || '').trim() || undefined,
          lang: String(req.body?.lang || '').trim() || undefined,
        },
      });
      job.reference = legalCase.id;
      res.status(202).json({ ok: true, job });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/originals/job', (req, res) => {
    const job = getJob(req.query.id);
    if (!job) return res.status(404).json({ error: 'Travail inconnu ou expiré.' });
    res.json({ job });
  });

  router.delete('/originals/job', (req, res) => {
    const job = cancelOriginalsJob(req.query.id);
    if (!job) return res.status(404).json({ error: 'Aucun traitement en cours pour cet identifiant.' });
    res.json({ ok: true, job });
  });

  // ── Protection des pièces ────────────────────────────────────────────────
  // La protection est une propriété du fichier, pas de son emplacement : c'est
  // ici qu'on la décide, et les hooks Claude Code l'appliquent
  // (`piecemaker-plugin/scripts/protect-originals.mjs`). Tout est protégé par
  // défaut ; `protection.json` n'enregistre que les exceptions.

  router.get('/protection', async (req, res) => {
    const startedAt = performance.now();
    try {
      const legalCase = selectedCase(req.query.case);
      const files = await listOriginals(legalCase.root);
      finishAdminTiming(res, 'protection', startedAt, { files: files.length });
      res.json({
        case: legalCase.id,
        files,
        protectedCount: files.filter((file) => file.protected).length,
        truncated: Boolean(files.truncated),
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/protection', (req, res) => {
    try {
      if (!Array.isArray(req.body?.unprotected)) {
        throw new Error('« unprotected » doit être la liste des pièces laissées accessibles à l’IA.');
      }
      const legalCase = selectedCase(req.body?.case);
      const saved = writeProtection(legalCase.root, { unprotected: req.body.unprotected });
      res.json({
        ok: true,
        case: legalCase.id,
        unprotected: [...saved.unprotected],
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Le mapping du dossier est le seul fichier de l'administration qui contient
  // des données personnelles en clair : il n'est jamais journalisé, seulement
  // rendu au navigateur local qui l'a demandé.
  router.get('/mapping', (req, res) => {
    try {
      const legalCase = selectedCase(req.query.case);
      const mapping = readCaseMapping(legalCase.root);
      res.json({
        case: legalCase.id,
        name: path.basename(mapping.file),
        exists: mapping.exists,
        mapping: mapping.mapping,
        reverse_mapping: mapping.reverse_mapping,
        informations_dossier: mapping.informations_dossier,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/mapping', async (req, res) => {
    try {
      if (!req.body?.mapping || typeof req.body.mapping !== 'object' || Array.isArray(req.body.mapping)) {
        throw new Error('Le mapping doit être un objet { entité: code }.');
      }
      const legalCase = selectedCase(req.body?.case);
      const saved = saveCaseMapping(legalCase.root, {
        mapping: req.body.mapping,
        reverse_mapping: req.body.reverse_mapping,
        ...(req.body.informations_dossier !== undefined
          ? { informations_dossier: req.body.informations_dossier }
          : {}),
      });
      const commit = await createCommit({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        label: 'Modification du mapping d’anonymisation',
        event: 'admin-mapping-edit',
        paths: [path.relative(legalCase.root, saved.file).split(path.sep).join('/')],
        waitForLockMs: 10_000,
      });
      if (commit.skipped === 'busy') throw new Error('Mapping enregistré, mais historique occupé : commit automatique non créé.');
      res.json({
        ok: true,
        case: legalCase.id,
        name: path.basename(saved.file),
        exists: true,
        mapping: saved.mapping,
        reverse_mapping: saved.reverse_mapping,
        informations_dossier: saved.informations_dossier,
        commit: { created: commit.created, hash: commit.commit || null },
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/mapping/rebuild', async (req, res) => {
    try {
      const legalCase = selectedCase(req.body?.case);
      const rebuilt = await rebuildCaseMapping(legalCase.root);
      const commit = await createCommit({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        label: 'Régénération du mapping d’anonymisation',
        event: 'admin-mapping-rebuild',
        paths: [path.relative(legalCase.root, rebuilt.file).split(path.sep).join('/')],
        waitForLockMs: 10_000,
      });
      if (commit.skipped === 'busy') throw new Error('Mapping régénéré, mais historique occupé : commit automatique non créé.');
      res.json({
        ok: true,
        case: legalCase.id,
        name: path.basename(rebuilt.file),
        added: rebuilt.added,
        total: rebuilt.total,
        mapping: rebuilt.mapping,
        reverse_mapping: rebuilt.reverse_mapping,
        informations_dossier: rebuilt.informations_dossier,
        commit: { created: commit.created, hash: commit.commit || null },
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/history', async (req, res) => {
    const startedAt = performance.now();
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
      const legalCase = selectedCase(req.query.case);
      const history = await listHistory(legalCase.casesRoot, homeDir, { limit, caseName: legalCase.caseName });
      finishAdminTiming(res, 'history', startedAt, { commits: history.length, limit });
      res.json({ history });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/revision', async (req, res) => {
    const startedAt = performance.now();
    try {
      const hash = String(req.query.hash || '');
      const filePath = String(req.query.path || '');
      const snapshot = String(req.query.snapshot || '');
      const legalCase = selectedCase(req.query.case);
      const revision = hash === 'WORKTREE'
        ? await worktreeDetails(legalCase.casesRoot, homeDir, legalCase.caseName, filePath, snapshot)
        : await revisionDetails(legalCase.casesRoot, homeDir, legalCase.caseName, hash, filePath);
      finishAdminTiming(res, 'revision', startedAt, {
        files: revision.filesCount,
        patchBytes: Buffer.byteLength(revision.patch || '', 'utf8'),
        truncated: revision.truncated,
      });
      res.json(revision);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/commits', async (req, res) => {
    try {
      const legalCase = selectedCase(req.body?.case);
      const label = String(req.body?.label || 'Commit manuel').trim().slice(0, 140);
      const description = String(req.body?.description || '').trim().slice(0, 4000);
      const result = await createCommit({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        label,
        description,
        event: 'manual',
        waitForLockMs: 10_000,
      });
      if (result.skipped === 'busy') throw new Error('L’historique est occupé. Réessayez dans quelques secondes.');
      res.status(result.created ? 201 : 200).json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/restore', async (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: 'La confirmation explicite de la restauration est requise.' });
      }
      const legalCase = selectedCase(req.body?.case);
      const result = await restoreRevision({
        casesRoot: legalCase.casesRoot,
        caseName: legalCase.caseName,
        homeDir,
        hash: req.body?.hash,
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/telegram', (req, res) => {
    res.json(getTelegramState({ repoRoot, homeDir, userHome }));
  });

  router.put('/telegram', (req, res) => {
    try {
      res.json({ ok: true, ...saveTelegramConfig({ repoRoot, homeDir, userHome }, req.body) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/telegram/:role/:action', (req, res) => {
    try {
      res.json(controlTelegram({ repoRoot, homeDir, userHome }, req.params.role, req.params.action));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/telegram/dossiers/:id', (req, res) => {
    try {
      res.json({ ok: true, dossier: saveDossierBot({ repoRoot, homeDir, userHome }, req.params.id, req.body) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/telegram/dossiers/:id/:action', (req, res) => {
    try {
      res.json(controlDossierBot({ repoRoot, homeDir, userHome }, req.params.id, req.params.action));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  createLegalCase,
  createAdminRouter,
  createManagedFile,
  folderPickerCommands,
  installProjectPlugin,
  isLocalOrigin,
  legalWorkspaceDirectory,
  listDossiers,
  listManagedFiles,
  managedFileKind,
  normalizeAgentModel,
  normalizeAgentTools,
  readManagedFile,
  registerLegalCase,
  revealCommands,
  saveManagedFile,
  selectLocalFolder,
  updateEnvFile,
};

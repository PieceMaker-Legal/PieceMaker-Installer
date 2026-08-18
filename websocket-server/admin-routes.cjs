const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('child_process');
const { performance } = require('node:perf_hooks');
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
  safeCaseFiles,
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
  documentKey,
  readProtection,
  writeProtection,
} = require('../piecemaker-plugin/scripts/lib/protection.cjs');
const { buildChronology } = require('./document-index.cjs');
const {
  buildGraphifyDocumentGraph,
  graphifyErrorGraph,
} = require('./graphify-document-graph.cjs');
const {
  readInstitutionalTerms,
  writeInstitutionalTerms,
} = require('../piecemaker-plugin/scripts/lib/institutional-terms.cjs');
const {
  claudeAssetOf,
  claudeAssetStatus,
  registerClaudeAsset,
  repositoryAssets,
  syncClaudeAssets,
  unregisterClaudeAsset,
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
    port: 43098,
    pythonPath: null,
    venvPath: path.join(homeDir, 'venv'),
    adminTheme: 'light',
  };
}

function validateAdminTheme(value) {
  const theme = String(value || '');
  if (theme !== 'light' && theme !== 'dark') throw new Error('Le thème doit être « light » ou « dark ».');
  return theme;
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

function captureCommand(command, args = [], timeout = 3000) {
  const executable = process.platform === 'win32' && !command.endsWith('.exe')
    ? `${command}.cmd`
    : command;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    // Windows cannot execute a .cmd shim directly. The command and arguments
    // are constants owned by PieceMaker, never values supplied by the browser.
    shell: process.platform === 'win32',
  });
  return {
    ok: result.status === 0 && !result.error,
    output: String(result.stdout || result.stderr || '').trim(),
  };
}

function installedClaudePlugin() {
  const result = captureCommand('claude', ['plugin', 'list', '--json'], 5000);
  if (!result.ok) return null;
  try {
    const plugins = JSON.parse(result.output);
    return Array.isArray(plugins)
      ? plugins.find((plugin) => plugin?.id === 'piecemaker@piecemaker' && plugin.enabled !== false) || null
      : null;
  } catch {
    return null;
  }
}

// Coordonnées marketplace/plugin — mêmes valeurs que
// installer/lib/plugin-refresh.mjs (MARKETPLACE_NAME/PLUGIN_NAME) et
// installer/steps/09-claude-assets.mjs (REPO_SLUG), dupliquées ici en
// constantes plutôt qu'importées : ce fichier reste CommonJS pur pour tout
// ce qui ne touche pas explicitement à l'installation du plugin.
const CLAUDE_MARKETPLACE_NAME = 'piecemaker';
const CLAUDE_PLUGIN_NAME = 'piecemaker';
const CLAUDE_PLUGIN_SPEC = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`;
const CLAUDE_MARKETPLACE_SLUG = 'PieceMaker-Legal/PieceMaker-Installer';

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

// installer/lib/service.mjs (ESM) is the existing, tested implementation of
// "refresh an already-installed plugin and verify convergence by content
// fingerprint" (see its doc comment). It is loaded lazily via dynamic
// import() — the one interop path that works from this CommonJS file — and
// cached, since it is pure/side-effect-free at import time.
let cachedRefreshClaudePlugin = null;
async function loadRefreshClaudePlugin() {
  if (!cachedRefreshClaudePlugin) {
    const modulePath = path.join(__dirname, '..', 'installer', 'lib', 'service.mjs');
    const mod = await import(pathToFileURL(modulePath).href);
    cachedRefreshClaudePlugin = mod.refreshClaudePlugin;
  }
  return cachedRefreshClaudePlugin;
}

/**
 * Installe ou rafraîchit le plugin Claude Code PieceMaker (marketplace +
 * plugin), pour le bouton « Ajouter le plugin legal Claude » de l'onglet
 * « Skills et agents ». Deux chemins :
 *  - Plugin déjà installé : délègue à `refreshClaudePlugin()`
 *    (installer/lib/service.mjs) — la même vérification de convergence par
 *    empreinte de contenu que `piecemaker update` utilise déjà pour éviter de
 *    laisser un cache Claude Code périmé (voir plugin-refresh.mjs). Best
 *    effort, jamais levée.
 *  - Jamais installé : reprend la séquence de
 *    `installer/steps/09-claude-assets.mjs` (marketplace add — GitHub puis
 *    repli sur la copie locale du dépôt — puis install), sans les invites
 *    interactives de l'installeur : ce chemin doit pouvoir tourner depuis une
 *    requête HTTP de l'administration.
 * `runCommand` et `refreshInstalledPlugin` sont injectables pour les tests,
 * afin de ne jamais dépendre d'un vrai CLI `claude` en CI.
 */
async function ensureClaudePluginActive({
  repoRoot,
  userHome = os.homedir(),
  runCommand = captureCommand,
  refreshInstalledPlugin = null,
} = {}) {
  const listPlugins = () => {
    const result = runCommand('claude', ['plugin', 'list', '--json']);
    return result.ok ? parseJsonOutput(result.output) : null;
  };
  const isPluginInstalled = (plugins) => Array.isArray(plugins)
    && plugins.some((entry) => entry?.id === CLAUDE_PLUGIN_SPEC && entry.enabled !== false);

  if (isPluginInstalled(listPlugins())) {
    const refresh = refreshInstalledPlugin || await loadRefreshClaudePlugin();
    const result = await refresh({ pluginDir: path.join(repoRoot, 'piecemaker-plugin'), userHome });
    return { ok: Boolean(result?.ok), action: 'refresh', installed: true, ...result };
  }

  const marketplaces = runCommand('claude', ['plugin', 'marketplace', 'list', '--json']);
  const marketplaceList = marketplaces.ok ? parseJsonOutput(marketplaces.output) : null;
  const marketplaceRegistered = Array.isArray(marketplaceList)
    && marketplaceList.some((entry) => entry?.name === CLAUDE_MARKETPLACE_NAME);

  let marketplaceSource = 'existing';
  if (marketplaceRegistered) {
    const updated = runCommand('claude', ['plugin', 'marketplace', 'update', CLAUDE_MARKETPLACE_NAME]);
    if (!updated.ok) {
      return {
        ok: false,
        action: 'marketplace-update',
        installed: false,
        reason: updated.output || 'Échec de l’actualisation du marketplace « piecemaker ».',
      };
    }
  } else {
    const fromGitHub = runCommand('claude', ['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE_SLUG]);
    if (fromGitHub.ok) {
      marketplaceSource = 'github';
    } else {
      const fromLocal = runCommand('claude', ['plugin', 'marketplace', 'add', repoRoot]);
      if (!fromLocal.ok) {
        return {
          ok: false,
          action: 'marketplace-add',
          installed: false,
          reason: fromLocal.output || 'Échec de l’enregistrement du marketplace (GitHub et copie locale).',
        };
      }
      marketplaceSource = 'local';
    }
  }

  const install = runCommand('claude', ['plugin', 'install', CLAUDE_PLUGIN_SPEC]);
  if (!install.ok) {
    return {
      ok: false,
      action: 'plugin-install',
      installed: false,
      reason: install.output || 'Échec de l’installation du plugin — le client « claude » est-il installé ?',
    };
  }

  return { ok: true, action: 'installed', installed: true, marketplaceSource };
}

// -----------------------------------------------------------------------
// Marketplace officiel Claude Code — onglet « Marketplace officiel » du
// même pop-up. Constat d'investigation (voir docs/plugin-marketplace, sinon
// le rapport de cette fonctionnalité) : la CLI `claude` n'expose AUCUNE
// recherche distante — `claude plugin --help` n'a pas de sous-commande
// `search`, et ni `plugin list` ni `plugin marketplace list` n'acceptent de
// requête. Le seul catalogue énumérable programmatiquement est
// `claude plugin list --available --json`, qui renvoie les plugins NON
// installés des marketplaces déjà enregistrées localement (nom,
// description, marketplace, popularité `installCount`) à côté de la liste
// des plugins installés (`claude plugin list --json`, avec leur état
// enabled/disabled). Rien n'est donc inventé ici : la recherche du pop-up
// filtre côté client cette même liste (voir admin/app.js). Le seul
// marketplace enregistrable en un clic depuis ce pop-up est le marketplace
// premier-parti d'Anthropic (`claude-plugins-official`, dépôt
// anthropics/claude-plugins-official) — le même nom déjà utilisé comme
// référence dans installer/steps/09-claude-assets.mjs pour notre propre
// marketplace. Tout autre marketplace se déclare via
// `claude plugin marketplace add` en dehors de ce pop-up.
// -----------------------------------------------------------------------
const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official';
const OFFICIAL_MARKETPLACE_SLUG = 'anthropics/claude-plugins-official';
// Marketplace « Claude for Legal » d'Anthropic (dépôt anthropics/claude-for-legal),
// suite de plugins juridiques par domaine (commercial-legal, litigation-legal,
// ip-legal…). C'est le catalogue de l'onglet « Plugin legal Claude » du pop-up —
// distinct du marketplace généraliste claude-plugins-official (onglet
// « Marketplace officiel »). Même mécanique CLI que l'officiel : add / list /
// install / enable / disable, scoping par nom de marketplace.
const LEGAL_MARKETPLACE_NAME = 'claude-for-legal';
const LEGAL_MARKETPLACE_SLUG = 'anthropics/claude-for-legal';

// Les deux catalogues énumérables depuis le pop-up, indexés par le `scope`
// que le frontend passe (onglet legal vs officiel). Tout scope inconnu retombe
// sur l'officiel — le comportement historique.
const MARKETPLACE_SCOPES = {
  legal: { name: LEGAL_MARKETPLACE_NAME, slug: LEGAL_MARKETPLACE_SLUG },
  official: { name: OFFICIAL_MARKETPLACE_NAME, slug: OFFICIAL_MARKETPLACE_SLUG },
};
function marketplaceForScope(scope) {
  return MARKETPLACE_SCOPES[scope] || MARKETPLACE_SCOPES.official;
}

/** Marketplaces Claude Code enregistrées sur ce poste, hors la nôtre. */
function listRegisteredMarketplaces(runCommand = captureCommand) {
  const result = runCommand('claude', ['plugin', 'marketplace', 'list', '--json']);
  if (!result.ok) return [];
  const parsed = parseJsonOutput(result.output);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry?.name && entry.name !== CLAUDE_MARKETPLACE_NAME)
    .map((entry) => ({
      name: entry.name,
      repo: entry.repo || null,
      source: entry.source || null,
      // Heuristique locale, pas un champ renvoyé par la CLI : seul le
      // marketplace historique publié par Anthropic sous ce dépôt exact est
      // marqué « officiel » — voir le commentaire ci-dessus.
      official: entry.source === 'github' && entry.repo === OFFICIAL_MARKETPLACE_SLUG,
    }));
}

/**
 * Plugins-connecteurs des marketplaces déjà enregistrées (hors piecemaker),
 * fusion de `plugin list --json` (installés, avec enabled/scope) et
 * `plugin list --available --json` (catalogue non installé, avec
 * description/popularité) — seule source de données énumérable, voir le
 * commentaire au-dessus de OFFICIAL_MARKETPLACE_NAME. `runCommand`
 * injectable pour les tests.
 */
function listMarketplaceConnectors(runCommand = captureCommand, options = {}) {
  // `marketplaceName` restreint le catalogue à un seul marketplace (onglet
  // legal ↔ claude-for-legal, onglet officiel ↔ claude-plugins-official) ;
  // absent, on garde le comportement historique (tous les marketplaces hors
  // piecemaker). Un plugin d'un autre marketplace n'apparaît alors jamais dans
  // l'onglet, et `applyMarketplaceSelection` n'y touche pas.
  const scopeName = options.marketplaceName || null;
  const inScope = (marketplace) => !scopeName || marketplace === scopeName;
  const marketplaces = listRegisteredMarketplaces(runCommand);
  // `registered` : le marketplace de l'onglet est-il déjà déclaré sur ce poste ?
  // (scopé sur son nom, sinon sur l'officiel — comme avant.)
  const registered = marketplaces.some((entry) => entry.name === (scopeName || OFFICIAL_MARKETPLACE_NAME));
  const result = runCommand('claude', ['plugin', 'list', '--available', '--json'], 8000);
  if (!result.ok) {
    return {
      marketplaces,
      officialRegistered: registered,
      registered,
      plugins: [],
      reason: result.output || 'Échec de l’appel « claude plugin list --available --json ».',
    };
  }
  const parsed = parseJsonOutput(result.output) || {};
  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  const available = Array.isArray(parsed.available) ? parsed.available : [];

  const plugins = [];
  const seen = new Set();
  for (const entry of available) {
    if (!entry?.pluginId || entry.marketplaceName === CLAUDE_MARKETPLACE_NAME || seen.has(entry.pluginId)) continue;
    if (!inScope(entry.marketplaceName)) continue;
    seen.add(entry.pluginId);
    plugins.push({
      id: entry.pluginId,
      name: entry.name || entry.pluginId,
      description: entry.description || '',
      marketplace: entry.marketplaceName || '',
      installCount: Number.isFinite(entry.installCount) ? entry.installCount : null,
      installed: false,
      enabled: false,
    });
  }
  // `plugin list --json` ne fournit pas de description — seul le catalogue
  // « available » en a une. Un plugin déjà installé apparaît donc ici avec
  // une description vide (limite de la CLI, pas une omission de notre part).
  for (const entry of installed) {
    if (!entry?.id || entry.id.endsWith(`@${CLAUDE_MARKETPLACE_NAME}`) || seen.has(entry.id)) continue;
    const [name, marketplace] = entry.id.split('@');
    if (!inScope(marketplace)) continue;
    seen.add(entry.id);
    plugins.push({
      id: entry.id,
      name,
      description: '',
      marketplace: marketplace || '',
      installCount: null,
      installed: true,
      enabled: Boolean(entry.enabled),
    });
  }

  return { marketplaces, officialRegistered: registered, registered, plugins };
}

/**
 * Enregistre (ou rafraîchit s'il l'est déjà) un marketplace Anthropic —
 * bouton « Découvrir le marketplace… » des onglets du pop-up. `marketplace`
 * ({ name, slug }) désigne le catalogue voulu : par défaut le marketplace
 * officiel généraliste, ou celui du scope (legal → claude-for-legal), pour un
 * poste qui n'a encore que le marketplace piecemaker.
 */
function registerOfficialMarketplace(runCommand = captureCommand, marketplace = MARKETPLACE_SCOPES.official) {
  const alreadyRegistered = listRegisteredMarketplaces(runCommand)
    .some((entry) => entry.name === marketplace.name);
  const action = alreadyRegistered
    ? runCommand('claude', ['plugin', 'marketplace', 'update', marketplace.name], 8000)
    : runCommand('claude', ['plugin', 'marketplace', 'add', marketplace.slug], 15000);
  if (!action.ok) {
    return { ok: false, alreadyRegistered, reason: action.output || `Échec de l’enregistrement du marketplace « ${marketplace.name} ».` };
  }
  return { ok: true, alreadyRegistered };
}

/**
 * Applique une sélection de connecteurs marketplace « voulus actifs » —
 * même sémantique que `applyPluginComponentSelection` (coché = actif),
 * étendue à trois actions CLI selon l'état courant : `install` (jamais
 * installé), `enable` (installé mais désactivé), `disable` (actif et
 * décoché). Jamais `uninstall` : décocher désactive, ne supprime rien —
 * choix délibéré, réversible, cohérent avec le reste de PieceMaker qui ne
 * retire jamais un composant tiers de façon destructive. Idempotent : un
 * connecteur déjà dans l'état voulu n'appelle aucune commande. Chaque appel
 * est best-effort — un échec individuel n'empêche pas les suivants.
 */
function applyMarketplaceSelection(selection, runCommand = captureCommand, options = {}) {
  const wanted = new Set((Array.isArray(selection) ? selection : []).map(String));
  // Scopé au marketplace de l'onglet : décocher un plugin ne peut jamais
  // désactiver un connecteur d'un autre marketplace (l'univers considéré est
  // exactement celui listé dans l'onglet).
  const { plugins } = listMarketplaceConnectors(runCommand, options);
  const results = plugins.map((plugin) => {
    const shouldBeActive = wanted.has(plugin.id);
    const isActive = plugin.installed && plugin.enabled;
    if (shouldBeActive === isActive) return { id: plugin.id, action: 'none', ok: true };
    if (shouldBeActive) {
      const command = plugin.installed
        ? runCommand('claude', ['plugin', 'enable', plugin.id], 5000)
        : runCommand('claude', ['plugin', 'install', plugin.id, '-y'], 20000);
      return {
        id: plugin.id,
        action: plugin.installed ? 'enable' : 'install',
        ok: command.ok,
        reason: command.ok ? '' : command.output || 'Échec de la commande claude.',
      };
    }
    const command = runCommand('claude', ['plugin', 'disable', plugin.id], 5000);
    return { id: plugin.id, action: 'disable', ok: command.ok, reason: command.ok ? '' : command.output || 'Échec de la commande claude.' };
  });
  return {
    results,
    installed: results.filter((entry) => entry.action === 'install' && entry.ok).length,
    enabled: results.filter((entry) => entry.action === 'enable' && entry.ok).length,
    disabled: results.filter((entry) => entry.action === 'disable' && entry.ok).length,
    failed: results.filter((entry) => !entry.ok),
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeout = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaState(fetchImpl = global.fetch) {
  if (typeof fetchImpl !== 'function') return { installed: false, version: '', models: [] };
  try {
    const [versionResponse, tagsResponse] = await Promise.all([
      fetchWithTimeout(fetchImpl, 'http://127.0.0.1:11434/api/version', {}, 1800).catch(() => null),
      fetchWithTimeout(fetchImpl, 'http://127.0.0.1:11434/api/tags', {}, 2500),
    ]);
    if (!tagsResponse?.ok) return { installed: false, version: '', models: [] };
    const data = await tagsResponse.json();
    const versionData = versionResponse?.ok ? await versionResponse.json().catch(() => ({})) : {};
    const models = Array.isArray(data.models) ? data.models.map((model) => ({
      name: String(model.name || model.model || ''),
      digest: String(model.digest || ''),
      size: Number(model.size) || 0,
      modifiedAt: model.modified_at || '',
      family: model.details?.family || '',
      parameterSize: model.details?.parameter_size || '',
      quantization: model.details?.quantization_level || '',
    })).filter((model) => model.name) : [];
    return { installed: true, version: String(versionData.version || ''), models };
  } catch {
    return { installed: false, version: '', models: [] };
  }
}

function ollamaRegistryReference(modelName) {
  const value = String(modelName || '').trim();
  if (!value || value.length > 240 || !/^[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?$/.test(value)) {
    throw new Error('Nom de modèle Ollama invalide.');
  }
  const lastSlash = value.lastIndexOf('/');
  const tagSeparator = value.indexOf(':', lastSlash + 1);
  const repositoryName = tagSeparator >= 0 ? value.slice(0, tagSeparator) : value;
  const tag = tagSeparator >= 0 ? value.slice(tagSeparator + 1) : 'latest';
  // Names beginning with a registry host (notably hf.co/...) are imports, not
  // models published in Ollama's registry, so their update cannot be inferred.
  if (/^[^/]+\.[^/]+\//.test(repositoryName)) return null;
  const repository = repositoryName.includes('/') ? repositoryName : `library/${repositoryName}`;
  return { repository, tag };
}

async function checkOllamaModelUpdate(modelName, fetchImpl = global.fetch) {
  const reference = ollamaRegistryReference(modelName);
  if (!reference) {
    return { status: 'unknown', message: 'Ce modèle provient d’un registre externe ; vérification automatique indisponible.' };
  }
  const local = await ollamaState(fetchImpl);
  const model = local.models.find((entry) => entry.name === modelName);
  if (!model) throw new Error('Ce modèle local n’est plus disponible dans Ollama.');
  const repositoryPath = reference.repository.split('/').map(encodeURIComponent).join('/');
  const url = `https://registry.ollama.ai/v2/${repositoryPath}/manifests/${encodeURIComponent(reference.tag)}`;
  let response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
    }, 8000);
  } catch (error) {
    return { status: 'unknown', message: `Registre Ollama injoignable (${error.message}).` };
  }
  if (response.status === 404) {
    return { status: 'unknown', message: 'Modèle local ou privé : aucune version publique correspondante.' };
  }
  if (!response.ok) {
    return { status: 'unknown', message: `Vérification impossible (registre HTTP ${response.status}).` };
  }
  const manifest = Buffer.from(await response.arrayBuffer());
  const remoteDigest = crypto.createHash('sha256').update(manifest).digest('hex');
  const updateAvailable = Boolean(model.digest) && remoteDigest !== model.digest.replace(/^sha256:/, '');
  return updateAvailable
    ? { status: 'update', message: 'Une mise à jour est disponible dans le registre Ollama.' }
    : { status: 'current', message: 'Le modèle local est à jour.' };
}

async function configurationOverview({ repoRoot, homeDir, userHome, getRuntimeStatus, fetchImpl }) {
  const env = readEnvFile(path.join(repoRoot, '.env'));
  const installer = readJson(path.join(homeDir, 'state.json'), { steps: {} });
  const steps = installer.steps || {};
  const runtime = getRuntimeStatus();
  const plugin = installedClaudePlugin();
  const claude = captureCommand('claude', ['--version']);
  const codex = captureCommand('codex', ['--version']);
  const clients = [
    claude.ok && { name: 'Claude Code', version: claude.output.replace(/\s*\(Claude Code\)\s*$/i, '') },
    codex.ok && { name: 'Codex', version: codex.output.replace(/^codex(?:-cli)?\s*/i, '') },
  ].filter(Boolean);
  const hookFiles = [
    'protect-originals.mjs',
    'anonymize-read.mjs',
    'deanonymize-write.mjs',
    'commit-track.mjs',
    'billing-track.mjs',
  ].map((name) => path.join(repoRoot, 'piecemaker-plugin', 'scripts', name));
  const hooksReady = hookFiles.every((file) => fs.existsSync(file))
    && fs.existsSync(path.join(repoRoot, 'piecemaker-plugin', 'hooks', 'hooks.json'));
  let nodePtyReady = false;
  try { nodePtyReady = Boolean(require.resolve('node-pty')); } catch { /* dépendance optionnelle */ }

  const mcpItems = [
    {
      name: 'PieceMaker · Word',
      installed: fs.existsSync(path.join(repoRoot, 'mcp-server', 'mcp-server-local.js')),
      configured: true,
      detail: 'Outils locaux pour lire, éditer et tamponner les documents Word.',
    },
    {
      name: 'Légifrance',
      installed: fs.existsSync(path.join(repoRoot, 'piecemaker-plugin', 'mcp', 'legifrance', 'mcp_stdio_server.py')),
      configured: Boolean(env.LEGIFRANCE_CLIENT_ID && env.LEGIFRANCE_CLIENT_SECRET),
      detail: 'Recherche juridique locale via les API officielles PISTE.',
    },
  ];
  const models = await ollamaState(fetchImpl);
  const telegram = getTelegramState({ repoRoot, homeDir, userHome });

  // Moteurs Python locaux du venv — détection par présence de paquet, sans import
  // (importer gliner2/mineru chargerait des centaines de Mo à chaque appel).
  const config = readJson(path.join(homeDir, 'config.json'), {});
  const venvDir = config.venvPath || path.join(homeDir, 'venv');
  const sitePackages = (() => {
    if (process.platform === 'win32') return path.join(venvDir, 'Lib', 'site-packages');
    const libDir = path.join(venvDir, 'lib');
    try {
      const py = fs.readdirSync(libDir).find((name) => name.startsWith('python'));
      return py ? path.join(libDir, py, 'site-packages') : '';
    } catch { return ''; }
  })();
  const hasPackage = (name) => Boolean(sitePackages) && fs.existsSync(path.join(sitePackages, name));
  const glinerDir = path.join(repoRoot, 'websocket-server', 'scripts', 'presidio-gliner');
  const glinerReady = fs.existsSync(path.join(glinerDir, 'presidio-gliner.py'))
    && (hasPackage('gliner2') || hasPackage('gliner') || steps['03-python-gliner']?.status === 'done');
  const coreml = (() => {
    try { return fs.readdirSync(glinerDir).some((name) => name.endsWith('.mlmodelc')); } catch { return false; }
  })();
  const mineruReady = hasPackage('mineru') || hasPackage('magic_pdf')
    || fs.existsSync(path.join(venvDir, 'bin', 'mineru'));
  const folders = listConfiguredCases(readRegistryConfig(path.join(homeDir, 'config.json'))).map((entry) => {
    const bot = telegram.dossiers.find((candidate) => {
      try { return path.resolve(candidate.workdir) === path.resolve(entry.root); } catch { return false; }
    });
    return {
      id: entry.id,
      name: entry.name,
      path: entry.root,
      bot: bot ? {
        id: bot.id,
        name: bot.name,
        configured: Boolean(bot.linked),
        running: Boolean(bot.running),
      } : null,
    };
  });

  return {
    components: {
      client: {
        name: clients.map((client) => client.name).join(' + ') || 'Client IA',
        installed: clients.length > 0,
        summary: clients.length
          ? clients.map((client) => `${client.name}${client.version ? ` ${client.version}` : ''}`).join(' · ')
          : 'Aucun client en ligne de commande détecté',
        clients,
        pluginInstalled: Boolean(plugin) || steps['09-claude-assets']?.status === 'done',
        pluginVersion: plugin?.version || '',
      },
      terminal: {
        name: 'Terminal intégré',
        installed: runtime.terminalReady ?? nodePtyReady,
        summary: runtime.terminalReady ?? nodePtyReady
          ? `PTY local · ${os.userInfo().shell || process.env.COMSPEC || 'shell système'}`
          : 'Le pont PTY optionnel est absent',
        shell: os.userInfo().shell || process.env.COMSPEC || '',
      },
      hooks: {
        name: 'Hooks PieceMaker',
        installed: hooksReady && (Boolean(plugin) || steps['06-hooks']?.status === 'done'),
        summary: `${hookFiles.filter((file) => fs.existsSync(file)).length}/${hookFiles.length} garde-fous disponibles`,
        count: hookFiles.filter((file) => fs.existsSync(file)).length,
        installerStatus: steps['06-hooks']?.status || '',
      },
      mcp: {
        name: 'MCP locaux',
        installed: mcpItems.every((item) => item.installed),
        configured: mcpItems.every((item) => item.installed && item.configured),
        summary: `${mcpItems.filter((item) => item.installed).length}/${mcpItems.length} serveurs présents`,
        items: mcpItems,
      },
      gliner: {
        name: 'GLiNER · PII',
        installed: glinerReady,
        summary: glinerReady
          ? coreml ? 'Détection locale · GPU CoreML' : 'Détection locale · CPU'
          : 'Modèle d’anonymisation absent',
        coreml,
        engine: coreml ? 'CoreML (GPU)' : 'torch (CPU)',
      },
      mineru: {
        name: 'MinerU · OCR',
        installed: mineruReady,
        optional: true,
        summary: mineruReady
          ? 'OCR local · PDF scannés et images'
          : 'Optionnel · non installé',
      },
      telegram: {
        name: 'Telegram',
        installed: true,
        optional: true,
        configured: Boolean(telegram.assistant.token.configured || telegram.monitor.token.configured),
        summary: (() => {
          const running = [telegram.assistant.running && 'Assistant', telegram.monitor.running && 'Surveillance'].filter(Boolean);
          if (running.length) return `${running.join(' + ')} en ligne`;
          if (telegram.assistant.token.configured || telegram.monitor.token.configured) return 'Configuré · arrêté';
          return 'Aucun bot configuré';
        })(),
        bots: [
          { name: telegram.assistant.name, role: 'Assistant', configured: Boolean(telegram.assistant.token.configured), running: Boolean(telegram.assistant.running) },
          { name: telegram.monitor.name, role: 'Surveillance', configured: Boolean(telegram.monitor.token.configured), running: Boolean(telegram.monitor.running) },
        ],
      },
    },
    models: {
      provider: 'Ollama',
      installed: models.installed,
      version: models.version,
      items: models.models,
    },
    folders,
  };
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

// Préfixe des chemins synthétiques d'un skill fourni par un plugin de
// marketplace installé (onglet « Skills et agents », groupe « Skills
// officiels »). Ce ne sont pas des fichiers du dépôt : ils vivent dans le cache
// Claude Code (~/.claude/plugins/cache/…), en lecture seule. Le chemin encode
// l'id du plugin et le slug du skill pour être re-résolu à la lecture sans
// stocker de chemin de version volatil.
const OFFICIAL_SKILL_PREFIX = 'official-skill:';

// Skills exposés par les plugins de marketplace installés ET activés (hors
// notre propre plugin piecemaker, dont les skills sont déjà listés depuis le
// dépôt). Source : `claude plugin list --json`, qui donne l'`installPath` exact
// (dossier de version inclus) et l'état `enabled` de chaque plugin ; on y lit
// alors les `skills/<slug>/SKILL.md`. `runCommand` injectable pour les tests.
function installedPluginSkills(runCommand = captureCommand) {
  const result = runCommand('claude', ['plugin', 'list', '--json'], 5000);
  if (!result.ok) return [];
  const plugins = parseJsonOutput(result.output);
  if (!Array.isArray(plugins)) return [];
  const skills = [];
  const seen = new Set();
  for (const plugin of plugins) {
    if (!plugin?.id || plugin.enabled === false) continue;
    // Nos propres skills sont déjà listés depuis le dépôt — ne pas les répéter.
    if (plugin.id.endsWith(`@${CLAUDE_MARKETPLACE_NAME}`)) continue;
    const installPath = typeof plugin.installPath === 'string' ? plugin.installPath : '';
    if (!installPath) continue;
    const skillsDir = path.join(installPath, 'skills');
    let entries;
    try {
      entries = fs.readdirSync(skillsDir);
    } catch {
      continue; // pas de dossier skills/ (plugin d'agents seuls, MCP, etc.)
    }
    const [pluginName, marketplace] = plugin.id.split('@');
    for (const name of entries.sort()) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const key = `${plugin.id}/${name}`;
      if (seen.has(key)) continue; // même plugin installé en scope user ET project
      seen.add(key);
      const metadata = pluginComponentFrontMatter(skillFile);
      skills.push({
        path: `${OFFICIAL_SKILL_PREFIX}${plugin.id}/${name}`,
        pluginId: plugin.id,
        plugin: pluginName,
        marketplace: marketplace || '',
        slug: name,
        name: metadata.name || name,
        description: metadata.description || '',
        absolute: skillFile,
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// Nombre maximal d'annexes listées pour un skill (panneau « Skills et
// agents ») — borne défensive contre un dossier de skill pathologique.
const MAX_SKILL_ASSETS = 200;

// Les fichiers annexes (assets/scripts) d'un skill, pour l'affichage
// indenté sous son bouton dans le panneau « Skills et agents ». `skillRelPath`
// est le chemin relatif de son SKILL.md ; on recurse dans les sous-dossiers
// (ex. `scripts/`) mais `name` reste le seul basename — jamais le chemin — et
// `path` est le chemin relatif au dépôt utilisé pour la suppression. Les
// fichiers cachés et les dossiers cachés sont ignorés, SKILL.md n'est jamais
// listé comme une annexe, et la liste est triée par nom puis plafonnée.
function listSkillAssets(repoRoot, skillRelPath) {
  const normalized = normalizeManagedPath(skillRelPath);
  if (!/^piecemaker-plugin\/skills\/[^/]+\/SKILL\.md$/.test(normalized)) return [];
  const skillDirRel = normalized.replace(/\/SKILL\.md$/, '');
  const skillDir = path.resolve(repoRoot, ...skillDirRel.split('/'));
  const assets = [];
  const walk = (dir, relDir) => {
    if (assets.length >= MAX_SKILL_ASSETS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (assets.length >= MAX_SKILL_ASSETS) return;
      if (entry.name.startsWith('.')) continue;
      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), entryRel);
      } else if (entry.isFile()) {
        if (relDir === '' && entry.name === 'SKILL.md') continue;
        assets.push({ name: entry.name, path: `${skillDirRel}/${entryRel}` });
      }
    }
  };
  walk(skillDir, '');
  assets.sort((a, b) => a.name.localeCompare(b.name));
  return assets.slice(0, MAX_SKILL_ASSETS);
}

// Les instructions, skills et agents du dépôt, plus les skills des plugins de
// marketplace installés (groupe « Skills officiels », lecture seule) : les
// aperçus de facturation vivent dans ~/.piecemaker/billing, une hiérarchie
// distincte du dépôt, et ne sont pas listés dans l'éditeur « Skills et agents ».
// `options.installedSkills` permet aux tests d'injecter la liste des skills de
// plugins (sinon elle est lue via le CLI claude, non hermétique).
function listManagedFiles(repoRoot, homeDir = path.join(os.homedir(), '.piecemaker'), userHome = os.homedir(), options = {}) {
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

  const files = candidates.map((relativePath) => {
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
      // Fichiers annexes (assets/scripts) — seuls les skills en ont un
      // dossier propre ; un agent n'a jamais d'annexes.
      assets: kind === 'skill' ? listSkillAssets(repoRoot, normalized) : [],
    };
  });

  // Skills des plugins de marketplace installés — lecture seule, groupe
  // « Skills officiels ». Un plugin installé depuis les onglets marketplace du
  // pop-up apparaît ainsi dans la liste dès qu'il expose des skills.
  const installedSkills = options.installedSkills || installedPluginSkills();
  for (const skill of installedSkills) {
    files.push({
      path: skill.path,
      name: skill.name,
      kind: 'official-skill',
      exists: true,
      readonly: true,
      plugin: skill.plugin,
      marketplace: skill.marketplace,
      description: skill.description,
      claudeCode: null,
    });
  }
  return files;
}

// Lecture minimale du front matter (name/description) d'un skill/agent, pour
// le pop-up « Ajouter le plugin legal Claude ». Même grammaire que
// admin/markdown.mjs#parseMetadata (module navigateur, non réutilisable
// ici — server.cjs ne charge pas de modules ES du dossier admin/), réduite
// aux deux clés affichées.
function parseFrontMatter(raw) {
  const match = String(raw || '').match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return {};
  const values = {};
  for (const line of match[1].split('\n')) {
    const lineMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!lineMatch) continue;
    let value = lineMatch[2];
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.replace(/^"|"$/g, ''); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    values[lineMatch[1]] = value;
  }
  return values;
}

function pluginComponentFrontMatter(absolutePath) {
  try {
    return parseFrontMatter(fs.readFileSync(absolutePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Les skills et agents du plugin PieceMaker, avec leur état d'enregistrement
 * auprès de Claude Code — support du pop-up de sélection de
 * « Ajouter le plugin legal Claude ». S'appuie sur `repositoryAssets` /
 * `claudeAssetStatus` (claude-assets.cjs), la même source que la liste de
 * fichiers et `files/sync`, pour que les deux vues restent en accord.
 */
function listPluginComponents(repoRoot, userHome = os.homedir()) {
  return repositoryAssets(repoRoot).map((relativePath) => {
    const asset = claudeAssetOf(repoRoot, userHome, relativePath);
    const status = claudeAssetStatus(repoRoot, userHome, relativePath);
    const sourceFile = asset.type === 'dir' ? path.join(asset.source, 'SKILL.md') : asset.source;
    const metadata = pluginComponentFrontMatter(sourceFile);
    return {
      path: relativePath,
      kind: asset.kind,
      slug: asset.slug,
      name: metadata.name || asset.slug,
      description: metadata.description || '',
      state: status.state,
      // Coché par défaut dans le pop-up : un enregistrement déjà présent,
      // même périmé (« stale » — autre clone du dépôt), compte comme actif.
      registered: ['linked', 'copied', 'stale'].includes(status.state),
      note: status.state === 'conflict'
        ? `Un ${asset.kind === 'skill' ? 'skill' : 'agent'} personnel du même nom existe déjà dans ~/.claude — non modifiable ici.`
        : '',
    };
  });
}

/**
 * Applique une sélection de composants (chemins relatifs voulus « actifs »)
 * en enregistrant ceux cochés et en retirant ceux décochés, via
 * `registerClaudeAsset`/`unregisterClaudeAsset` — jamais de substitution
 * maison. Un composant en conflit (fichier personnel homonyme) n'est jamais
 * touché, coché ou non. Idempotent : ré-appliquer la même sélection ne
 * change rien à un état déjà atteint.
 */
function applyPluginComponentSelection(repoRoot, userHome, selection) {
  const wanted = new Set((Array.isArray(selection) ? selection : []).map(String));
  const assets = repositoryAssets(repoRoot).map((relativePath) => {
    const current = claudeAssetStatus(repoRoot, userHome, relativePath);
    if (current.state === 'conflict') return { path: relativePath, ...current };
    const result = wanted.has(relativePath)
      ? registerClaudeAsset(repoRoot, userHome, relativePath)
      : unregisterClaudeAsset(repoRoot, userHome, relativePath);
    return { path: relativePath, ...result };
  });
  return {
    assets,
    registered: assets.filter((asset) => asset.state === 'linked' || asset.state === 'copied').length,
    removed: assets.filter((asset) => asset.state === 'missing' && !wanted.has(asset.path)).length,
    conflicts: assets.filter((asset) => asset.state === 'conflict'),
  };
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

// Lecture (seule) d'un skill de plugin de marketplace : re-résolution du chemin
// synthétique `official-skill:<pluginId>/<slug>` vers son SKILL.md dans le cache
// Claude Code, via `installedPluginSkills`. Jamais d'écriture — saveManagedFile
// refuse ce préfixe (managedAbsolutePath ne le reconnaît pas comme administrable).
function readOfficialSkill(pathValue, runCommand = captureCommand) {
  const skill = installedPluginSkills(runCommand).find((entry) => entry.path === pathValue);
  if (!skill || !fs.existsSync(skill.absolute)) throw new Error('Skill de plugin introuvable ou plugin désactivé.');
  return {
    path: pathValue,
    kind: 'official-skill',
    exists: true,
    content: fs.readFileSync(skill.absolute, 'utf8'),
    readonly: true,
    sourceType: 'markdown',
  };
}

function readManagedFile(repoRoot, relativePath, homeDir = path.join(os.homedir(), '.piecemaker')) {
  if (typeof relativePath === 'string' && relativePath.startsWith(OFFICIAL_SKILL_PREFIX)) {
    return readOfficialSkill(relativePath);
  }
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

/**
 * Écrit un fichier annexe (asset ou script) dans le dossier d'un skill —
 * `piecemaker-plugin/skills/<slug>/`. Seuls les skills ont un dossier propre :
 * un agent est un fichier `.md` isolé, sans annexes. Le nom est réduit à son
 * basename (aucune remontée de dossier), `SKILL.md` ne peut pas être écrasé, et
 * la cible est revérifiée à l'intérieur du dossier du skill avant écriture.
 * Renvoie le nom retenu et son chemin relatif au dépôt.
 */
function saveManagedAsset(repoRoot, homeDir, skillRelPath, filename, buffer) {
  const { absolute, normalized } = managedAbsolutePath(repoRoot, skillRelPath, homeDir);
  if (managedFileKind(normalized) !== 'skill') {
    throw new Error('Un fichier annexe ne peut être ajouté qu’à un skill.');
  }
  const safeName = path.basename(String(filename || '').trim());
  if (!safeName || safeName.startsWith('.')) throw new Error('Nom de fichier invalide.');
  if (safeName === 'SKILL.md') throw new Error('SKILL.md ne peut pas être remplacé ainsi.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Fichier vide.');
  const skillDir = path.dirname(absolute);
  const target = path.resolve(skillDir, safeName);
  if (target !== path.join(skillDir, safeName)) throw new Error('Chemin de fichier invalide.');
  fs.mkdirSync(skillDir, { recursive: true });
  const temp = path.join(skillDir, `.${safeName}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, target);
  const slugDir = normalized.replace(/\/SKILL\.md$/, '');
  return { name: safeName, path: `${slugDir}/${safeName}` };
}

/**
 * Supprime un unique fichier annexe (asset ou script) d'un skill, sans toucher
 * au reste du dossier. `managedAbsolutePath` ne reconnaît pas un chemin
 * d'annexe (`managedFileKind` renvoie `null` dessus), donc on ne peut pas le
 * réutiliser tel quel : cette fonction reprend la même vérification de
 * confinement (chemin résolu sous le dépôt, puis realpath contre un lien
 * symbolique) directement contre `piecemaker-plugin/skills/<slug>/`.
 * `SKILL.md` n'est jamais une « annexe » — sa suppression passe par
 * `deleteManagedFile` (suppression du skill entier).
 */
function deleteManagedAsset(repoRoot, homeDir, assetRelPath) {
  const normalized = normalizeManagedPath(assetRelPath);
  if (!/^piecemaker-plugin\/skills\/[^/]+\/.+/.test(normalized) || normalized.endsWith('/SKILL.md')) {
    throw new Error('Ce chemin ne correspond pas à un fichier annexe de skill.');
  }
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, ...normalized.split('/'));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('Chemin de fichier invalide.');
  }
  const existing = nearestExistingPath(absolute);
  const realRoot = fs.realpathSync(nearestExistingPath(root));
  const realExisting = fs.realpathSync(existing);
  if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error('Le fichier résout vers un emplacement extérieur au dépôt.');
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error('Fichier annexe introuvable.');
  }
  backupFile(absolute, normalized, homeDir);
  fs.rmSync(absolute);
  return { path: normalized, deletedAt: new Date().toISOString() };
}

/**
 * Supprime un skill ou un agent du dépôt : seuls ces deux types sont
 * effaçables ici — instructions (CLAUDE.md/AGENTS.md), skills officiels et
 * aperçus de facturation ne le sont jamais. Le contenu est sauvegardé avant
 * retrait, puis l'enregistrement Claude Code (lien ou copie) est nettoyé par
 * l'appelant via `unregisterClaudeAsset`. Pour un skill on retire le dossier
 * `piecemaker-plugin/skills/<slug>/` entier (SKILL.md et ses annexes) ; pour un
 * agent, le seul fichier `.md`.
 */
function deleteManagedFile(repoRoot, homeDir, relativePath) {
  const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  const kind = managedFileKind(normalized);
  if (!['skill', 'agent'].includes(kind)) {
    throw new Error('Seuls un skill ou un agent peuvent être supprimés.');
  }
  if (!fs.existsSync(absolute)) throw new Error('Fichier introuvable.');
  backupFile(absolute, normalized, homeDir);
  // Un skill vit dans son propre dossier — on supprime le dossier, pas juste
  // le SKILL.md, pour ne pas laisser un dossier vide derrière.
  const target = kind === 'skill' ? path.dirname(absolute) : absolute;
  fs.rmSync(target, { recursive: true, force: true });
  return { path: normalized, kind, deletedAt: new Date().toISOString() };
}

// Le slug qui identifie un skill/agent sur le disque : le dossier pour un
// skill (`piecemaker-plugin/skills/<slug>/SKILL.md`), le basename du `.md` pour
// un agent (`piecemaker-plugin/agents/<slug>.md`).
function managedSlug(normalized) {
  const kind = managedFileKind(normalized);
  if (kind === 'skill') return normalized.split('/')[2];
  if (kind === 'agent') return path.basename(normalized, '.md');
  return null;
}

/**
 * Renomme un skill/agent quand le champ `name:` de son front matter ne
 * correspond plus au slug de son emplacement. Ce nom sert de nom de dossier
 * (skill) ou de fichier (agent) et doit rester en accord avec ce que Claude
 * Code découvre. Pour un skill on déplace le dossier
 * `piecemaker-plugin/skills/<slug>/` entier (SKILL.md et ses annexes suivent) ;
 * pour un agent, le seul fichier `.md`. Renvoie `{ renamed, path, previous }`,
 * ou `{ renamed: false }` si le nom est inchangé.
 */
function renameManagedFile(repoRoot, homeDir, relativePath, newSlug) {
  const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  const kind = managedFileKind(normalized);
  if (!['skill', 'agent'].includes(kind)) {
    throw new Error('Seuls un skill ou un agent peuvent être renommés.');
  }
  const slug = String(newSlug || '').trim();
  if (!slug || slug === managedSlug(normalized)) return { renamed: false, path: normalized };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('Le nom sert de nom de dossier : uniquement minuscules, chiffres et tirets.');
  }
  const targetRelative = kind === 'skill'
    ? `piecemaker-plugin/skills/${slug}/SKILL.md`
    : `piecemaker-plugin/agents/${slug}.md`;
  const { absolute: targetAbsolute, normalized: targetNormalized } = managedAbsolutePath(repoRoot, targetRelative, homeDir);
  const source = kind === 'skill' ? path.dirname(absolute) : absolute;
  const destination = kind === 'skill' ? path.dirname(targetAbsolute) : targetAbsolute;
  if (!fs.existsSync(source)) throw new Error('Fichier introuvable — enregistrez-le avant de le renommer.');
  if (fs.existsSync(destination)) {
    throw new Error(`Un ${kind === 'skill' ? 'skill' : 'agent'} nommé « ${slug} » existe déjà.`);
  }
  fs.renameSync(source, destination);
  return { renamed: true, path: targetNormalized, previous: normalized };
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
 * Résout un chemin reçu du navigateur (relatif à la racine d'un dossier
 * juridique) vers un chemin absolu, sans jamais remonter hors de cette
 * racine. Même garde que `startOriginalsJob` (originals-pipeline.cjs) pour
 * les pièces sélectionnées : `path.resolve` puis vérification du préfixe.
 */
function resolveCasePath(caseRoot, relativePath) {
  const relative = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!relative) throw new Error('Chemin de pièce manquant.');
  const absolute = path.resolve(caseRoot, ...relative.split('/'));
  if (absolute !== caseRoot && !absolute.startsWith(`${caseRoot}${path.sep}`)) {
    throw new Error('Pièce hors du dossier juridique.');
  }
  if (!fs.existsSync(absolute)) throw new Error('Pièce introuvable.');
  return absolute;
}

/**
 * Le Markdown converti d'une pièce originale (chemin relatif à la racine du
 * dossier). La chronologie ne connaît une pièce que par le chemin de son
 * ORIGINAL (`document-index.cjs`, sur `originalFilesOverview`) ; retrouver son
 * `.md` reprend la même clé de correspondance que `originalFilesOverview`
 * (`documentKey` du basename), sans supposer d'emplacement fixe — le
 * converti vit sous `Fichiers convertis PieceMaker/`, mais un `.md` migré
 * depuis une version antérieure peut encore traîner à la racine.
 */
async function convertedMarkdownRelativePath(caseRoot, originalRelativePath) {
  const key = documentKey(path.basename(String(originalRelativePath || '')));
  const files = await safeCaseFiles(caseRoot);
  return files.find((file) => path.extname(file).toLowerCase() === '.md' && documentKey(file) === key) || null;
}

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

// Installation à la demande des moteurs locaux depuis le tiroir de la carte de
// configuration : un clic sur « Installer » relance l'étape d'installateur
// correspondante en arrière-plan (non interactif), au lieu d'obliger l'utilisateur
// à ouvrir un terminal. Chaque composant est mappé sur son étape.
const INSTALL_STEP_IDS = { gliner: '03-python-gliner', mineru: '04-conversion-md' };
const installJobs = new Map();
let activeInstallComponent = null;

// Nettoie une ligne de sortie de l'installateur (codes ANSI, spinner) pour n'en
// garder qu'un texte de progression lisible ; les lignes JSON de warmup.py
// portent un champ `message` plus parlant que la ligne brute.
function cleanInstallProgressLine(raw) {
  // eslint-disable-next-line no-control-regex
  const stripped = String(raw).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\t]+/g, ' ').trim();
  if (!stripped) return '';
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed.message === 'string') return parsed.message.trim();
  } catch { /* ligne texte ordinaire */ }
  return stripped;
}

function startInstallJob(repoRoot, component) {
  const stepId = INSTALL_STEP_IDS[component];
  if (!stepId) throw new Error(`Composant non installable : ${component}`);
  if (activeInstallComponent) {
    throw Object.assign(new Error(`Une installation est déjà en cours (${activeInstallComponent}).`), { conflict: true });
  }
  const installer = path.join(repoRoot, 'installer', 'bin', 'piecemaker.mjs');
  if (!fs.existsSync(installer)) throw new Error('Installateur PieceMaker introuvable.');
  const id = crypto.randomUUID();
  const job = { id, component, state: 'running', progress: 'Démarrage de l’installation…', startedAt: Date.now(), finishedAt: null, error: '' };
  installJobs.set(id, job);
  activeInstallComponent = component;

  const child = spawn(process.execPath, [installer, '--step', stepId], {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // PIECEMAKER_YES=1 : accepte les valeurs par défaut (MinerU inclus) sans TTY.
    env: { ...process.env, PIECEMAKER_YES: '1', NO_COLOR: '1' },
  });
  const tailStderr = [];
  const onLine = (chunk) => {
    for (const part of String(chunk).split('\n')) {
      const line = cleanInstallProgressLine(part);
      if (line) job.progress = line;
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', (chunk) => {
    onLine(chunk);
    tailStderr.push(String(chunk));
    while (tailStderr.join('').length > 4000) tailStderr.shift();
  });
  child.once('error', (error) => {
    job.state = 'failed';
    job.error = error.message;
    job.finishedAt = Date.now();
    activeInstallComponent = null;
  });
  child.once('close', (code) => {
    if (job.state === 'running') {
      job.state = code === 0 ? 'done' : 'failed';
      if (code !== 0) job.error = cleanInstallProgressLine(tailStderr.join('')) || `L’installateur s’est arrêté avec le code ${code}.`;
      if (code === 0) job.progress = 'Installation terminée.';
      job.finishedAt = Date.now();
    }
    activeInstallComponent = null;
    // Purge tardive : garde le job interrogeable un moment après la fin.
    setTimeout(() => installJobs.delete(id), 5 * 60 * 1000).unref?.();
  });
  return job;
}

function publicInstallJob(job) {
  if (!job) return null;
  return { id: job.id, component: job.component, state: job.state, progress: job.progress, error: job.error };
}

function createAdminRouter({
  repoRoot = path.resolve(__dirname, '..'),
  homeDir = path.join(os.homedir(), '.piecemaker'),
  userHome = os.homedir(),
  getRuntimeStatus = () => ({}),
  fetchImpl = global.fetch,
  pickFolder = selectLocalFolder,
  projectPluginInstaller = installProjectPlugin,
} = {}) {
  // Lazy import keeps the pure filesystem/Git helpers testable before npm
  // dependencies are installed. The running server already depends on Express.
  const express = require('express');
  const router = express.Router();
  const configFile = path.join(homeDir, 'config.json');
  const envFile = path.join(repoRoot, '.env');
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

  router.get('/configuration', async (req, res) => {
    try {
      res.json(await configurationOverview({
        repoRoot,
        homeDir,
        userHome,
        getRuntimeStatus,
        fetchImpl,
      }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/configuration/models/check', async (req, res) => {
    try {
      res.json({
        ok: true,
        model: String(req.body?.model || ''),
        checkedAt: new Date().toISOString(),
        ...await checkOllamaModelUpdate(req.body?.model, fetchImpl),
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Installe un moteur local absent (GLiNER, MinerU) en relançant son étape
  // d'installateur en arrière-plan ; le tiroir suit ensuite l'avancement en
  // interrogeant GET /configuration/install?id=.
  router.post('/configuration/install', (req, res) => {
    try {
      const component = String(req.body?.component || '');
      const job = startInstallJob(repoRoot, component);
      res.json({ ok: true, job: publicInstallJob(job) });
    } catch (error) {
      res.status(error.conflict ? 409 : 400).json({ error: error.message });
    }
  });

  router.get('/configuration/install', (req, res) => {
    const job = installJobs.get(String(req.query?.id || ''));
    if (!job) return res.status(404).json({ error: 'Installation inconnue ou expirée.' });
    res.json({ ok: true, job: publicInstallJob(job) });
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

      if (patch.port !== undefined) {
        const port = Number(patch.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Le port doit être compris entre 1024 et 65535.');
        next.port = port;
      }
      if (patch.pythonPath !== undefined) next.pythonPath = String(patch.pythonPath || '').trim() || null;
      if (patch.adminTheme !== undefined) next.adminTheme = validateAdminTheme(patch.adminTheme);

      atomicWrite(configFile, `${JSON.stringify(next, null, 2)}\n`);
      updateEnvFile(envFile, req.body?.env || {}, req.body?.clearSecrets || []);
      res.json({
        ok: true,
        restartRequired: patch.port !== undefined || patch.pythonPath !== undefined,
      });
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

  // Support du bouton « Ajouter le plugin legal Claude » (onglet Skills et
  // agents) : liste les composants du plugin PieceMaker avec leur état
  // d'enregistrement, pour le pop-up de sélection.
  router.get('/plugin/components', (req, res) => {
    try {
      const plugin = installedClaudePlugin();
      res.json({
        plugin: { installed: Boolean(plugin), version: plugin?.version || '' },
        components: listPluginComponents(repoRoot, userHome),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Installe/rafraîchit le plugin (marketplace + plugin) puis enregistre
  // uniquement les composants cochés dans le pop-up — désenregistre ceux
  // décochés. `components` : chemins relatifs (piecemaker-plugin/agents/...
  // ou piecemaker-plugin/skills/.../SKILL.md) tels que renvoyés par
  // GET /plugin/components.
  router.post('/plugin/install', async (req, res) => {
    try {
      const selection = Array.isArray(req.body?.components) ? req.body.components : [];
      const plugin = await ensureClaudePluginActive({ repoRoot, userHome });
      const result = applyPluginComponentSelection(repoRoot, userHome, selection);
      res.json({ ok: true, plugin, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Onglets marketplace du pop-up : liste les plugins-connecteurs d'un
  // marketplace Anthropic. `scope=legal` cible claude-for-legal (onglet
  // « Plugin legal Claude »), `scope=official` (défaut) claude-plugins-official
  // (onglet « Marketplace officiel »). Voir le commentaire de
  // listMarketplaceConnectors pour ce que la CLI expose (aucune recherche
  // distante).
  router.get('/plugin/marketplace', (req, res) => {
    try {
      const marketplace = marketplaceForScope(String(req.query?.scope || 'official'));
      res.json({ scope: req.query?.scope || 'official', marketplaceName: marketplace.name, ...listMarketplaceConnectors(captureCommand, { marketplaceName: marketplace.name }) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Enregistre (ou rafraîchit) le marketplace du scope quand le poste ne
  // l'a pas encore — bouton « Découvrir… » dédié dans chaque onglet.
  router.post('/plugin/marketplace/register', (req, res) => {
    try {
      const marketplace = marketplaceForScope(String(req.body?.scope || 'official'));
      const result = registerOfficialMarketplace(captureCommand, marketplace);
      res.json({ ok: result.ok, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Installe/active/désactive les connecteurs cochés — `plugins` : ids
  // `nom@marketplace` tels que renvoyés par GET /plugin/marketplace ; `scope`
  // borne l'action au seul marketplace de l'onglet.
  router.post('/plugin/marketplace/install', (req, res) => {
    try {
      const selection = Array.isArray(req.body?.plugins) ? req.body.plugins : [];
      const marketplace = marketplaceForScope(String(req.body?.scope || 'official'));
      res.json({ ok: true, ...applyMarketplaceSelection(selection, captureCommand, { marketplaceName: marketplace.name }) });
    } catch (error) {
      res.status(400).json({ error: error.message });
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
      const relativePath = req.body?.path;
      const content = req.body?.content;
      const normalized = normalizeManagedPath(relativePath || '');
      const kind = managedFileKind(normalized);
      let effectivePath = relativePath;
      let previousPath = null;
      // Le champ `name:` du front matter sert de nom de dossier (skill) ou de
      // fichier (agent) : s'il change sur un fichier déjà présent, on renomme
      // sur le disque pour que Claude Code retrouve l'asset sous son nouveau
      // nom (un fichier pas encore créé garde le chemin de son slug initial).
      if (['skill', 'agent'].includes(kind) && typeof content === 'string') {
        const { absolute } = managedAbsolutePath(repoRoot, normalized, homeDir);
        if (fs.existsSync(absolute)) {
          const rename = renameManagedFile(repoRoot, homeDir, normalized, parseFrontMatter(content).name);
          if (rename.renamed) {
            effectivePath = rename.path;
            previousPath = rename.previous;
          }
        }
      }
      const saved = saveManagedFile(repoRoot, homeDir, effectivePath, content);
      // Un renommage laisse l'ancien lien Claude Code orphelin : on le retire
      // avant d'enregistrer le nouveau.
      if (previousPath) unregisterClaudeAsset(repoRoot, userHome, previousPath);
      res.json({
        ok: true,
        ...saved,
        renamedFrom: previousPath || undefined,
        claudeCode: registerClaudeAsset(repoRoot, userHome, saved.path),
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Supprime un skill/agent du dépôt et retire son enregistrement Claude Code.
  // Le chemin arrive en query (`?path=`) ou dans le corps.
  router.delete('/file', (req, res) => {
    try {
      const relativePath = req.query?.path || req.body?.path;
      const deleted = deleteManagedFile(repoRoot, homeDir, relativePath);
      const claudeCode = unregisterClaudeAsset(repoRoot, userHome, deleted.path);
      res.json({ ok: true, ...deleted, claudeCode });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Ajoute un fichier annexe (asset ou script) au dossier du skill sélectionné
  // et renvoie son nom, que l'éditeur insère comme lien Markdown relatif. Corps
  // brut (octet-stream) ; nom dans l'en-tête X-Filename (encodeURIComponent),
  // SKILL.md cible dans X-Skill-Path.
  router.post('/asset', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
    try {
      const skillPath = req.get('X-Skill-Path');
      const filename = decodeURIComponent(req.get('X-Filename') || '');
      const saved = saveManagedAsset(repoRoot, homeDir, skillPath, filename, req.body);
      res.status(201).json({ ok: true, ...saved });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Supprime un unique fichier annexe d'un skill (pas le SKILL.md lui-même —
  // voir DELETE /file pour supprimer le skill entier). Chemin en query
  // (`?path=`) ou dans le corps.
  router.delete('/asset', (req, res) => {
    try {
      const relativePath = req.query?.path || req.body?.path;
      const deleted = deleteManagedAsset(repoRoot, homeDir, relativePath);
      res.json({ ok: true, ...deleted });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/dossiers', async (req, res) => {
    try {
      res.json({
        dossiers: await listDossiers(repoRoot, homeDir),
        tamponConfigured: fs.existsSync(path.join(homeDir, 'tampon.png')),
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
        root: '',
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
      const selected = await pickFolder(process.platform, userHome);
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

  router.get('/repository/chronology', async (req, res) => {
    const startedAt = performance.now();
    try {
      const legalCase = selectedCase(req.query.case);
      // Vue cabinet par défaut (codes ré-identifiés, comme l'éditeur de mapping) ;
      // `?deanonymize=0` renvoie le graphe indexé par code, sans aucun nom.
      const deanonymize = req.query.deanonymize !== '0' && req.query.deanonymize !== 'false';
      const chronology = await buildChronology(legalCase.root, { deanonymize });
      try {
        chronology.graph = await buildGraphifyDocumentGraph(legalCase.root, chronology);
      } catch (graphifyError) {
        // Le graphe est un enrichissement : une installation Graphify absente ou
        // une sortie invalide ne doit jamais rendre la frise inaccessible.
        console.warn(`[graphify] Graphe chronologique indisponible: ${graphifyError.message}`);
        chronology.graph = graphifyErrorGraph(graphifyError);
      }
      chronology.case = { path: legalCase.id, name: legalCase.caseName, location: legalCase.root };
      finishAdminTiming(res, 'chronology', startedAt, {
        documents: chronology.stats.documents,
        entities: chronology.stats.entities,
        graphEdges: chronology.graph.edges.length,
      });
      res.json(chronology);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // Contenu en lecture seule du Markdown converti d'une pièce — la seule
  // surface sûre : `path` est le chemin de la pièce ORIGINALE (comme partout
  // ailleurs dans la chronologie/l'aperçu), jamais lu directement. Sert
  // l'aperçu de la chronologie et le panneau droit de la correction d'entités ;
  // le fichier original (PDF/DOCX/scan) n'est jamais renvoyé par cette route.
  router.get('/repository/document', async (req, res) => {
    try {
      const legalCase = selectedCase(req.query.case);
      const mdPath = await convertedMarkdownRelativePath(legalCase.root, req.query.path);
      if (!mdPath) throw new Error('Cette pièce n’a pas encore de Markdown converti.');
      const absolute = resolveCasePath(legalCase.root, mdPath);
      const content = fs.readFileSync(absolute, 'utf8');
      res.json({
        path: mdPath,
        content: Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES
          ? `${content.slice(0, MAX_MARKDOWN_BYTES)}\n\n… (aperçu tronqué à 1 Mo)`
          : content,
      });
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

  // Ouvre le dossier juridique sélectionné (ou, à défaut, le dossier personnel)
  // dans le gestionnaire de fichiers ou le terminal du poste. Le chemin est
  // toujours résolu localement, jamais reçu tel quel du navigateur : un `path`
  // optionnel (target: 'files' seulement) désigne une pièce précise, relative à
  // la racine du dossier — `resolveCasePath` refuse toute sortie de racine.
  // Révéler dans le Finder n'affiche jamais de contenu dans le navigateur : sûr
  // même pour une pièce protégée.
  router.post('/reveal', async (req, res) => {
    try {
      const target = String(req.body?.target || '');
      if (!REVEAL_TARGETS.has(target)) throw new Error('Action de dossier inconnue.');
      const caseName = String(req.body?.case || '').trim();
      const relativePath = target === 'files' ? String(req.body?.path || '').trim() : '';
      let absolute;
      if (caseName && relativePath) {
        absolute = resolveCasePath(selectedCase(caseName).root, relativePath);
      } else {
        absolute = caseName ? selectedCase(caseName).root : userHome;
      }
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
  applyMarketplaceSelection,
  applyPluginComponentSelection,
  checkOllamaModelUpdate,
  configurationOverview,
  createLegalCase,
  createAdminRouter,
  createManagedFile,
  deleteManagedAsset,
  deleteManagedFile,
  ensureClaudePluginActive,
  folderPickerCommands,
  installedPluginSkills,
  installProjectPlugin,
  isLocalOrigin,
  listDossiers,
  listManagedFiles,
  listMarketplaceConnectors,
  listPluginComponents,
  listRegisteredMarketplaces,
  listSkillAssets,
  managedFileKind,
  normalizeAgentModel,
  normalizeAgentTools,
  readManagedFile,
  registerLegalCase,
  registerOfficialMarketplace,
  renameManagedFile,
  revealCommands,
  saveManagedAsset,
  saveManagedFile,
  selectLocalFolder,
  updateEnvFile,
  validateAdminTheme,
};

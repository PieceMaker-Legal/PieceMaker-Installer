const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('node:perf_hooks');
const { configuredWorkspacePath } = require('./workspace-paths.cjs');
const {
  caseOverview,
  createCommit,
  listCases,
  listHistory,
  resolveCase,
  resolveCasesRoot,
  restoreRevision,
  revisionDetails,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const {
  cancelOriginalsJob,
  getJob,
  readCaseMapping,
  rebuildCaseMapping,
  saveCaseMapping,
  startOriginalsJob,
} = require('./originals-pipeline.cjs');
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
  'LEGIFRANCE_CLIENT_ID',
  'LEGIFRANCE_CLIENT_SECRET',
  'LEGIFRANCE_ENV',
  'PYTHON_PATH',
  'SMART_CONVERTER_PATH',
]);

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
 * le sous-dossier « Pièces ». Seules les métadonnées utiles au bordereau sont
 * renvoyées — jamais `texte_integral`, qui contient les pièces en clair.
 */
function listDossiers(repoRoot, homeDir) {
  const workspace = legalWorkspaceDirectory(repoRoot, homeDir);
  if (!fs.existsSync(workspace)) return [];
  const legalCases = fs.readdirSync(workspace, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'));
  return legalCases.flatMap((entry) => {
    const legalCase = path.join(workspace, entry.name);
    return fs.readdirSync(legalCase)
      .filter((file) => /^compilation_dossier_.+\.json$/.test(file))
      .map((file) => {
      const documentId = file.slice('compilation_dossier_'.length, -'.json'.length);
      const raw = readJson(path.join(legalCase, file), null);
      const documents = Array.isArray(raw) ? raw : raw?.documents || [];
      return {
        documentId,
        informations: Array.isArray(raw) ? {} : raw?.informations_dossier || {},
        folder: legalCase,
        stampedDir: path.join(legalCase, 'Pièces'),
        documents: documents.map((doc) => ({
          id: doc?.id,
          filename: doc?.filename || '',
          type_document: doc?.type_document || '',
          date_document: doc?.date_document || '',
        })),
      };
      });
    })
    .filter((dossier) => dossier.documents.length > 0);
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
} = {}) {
  // Lazy import keeps the pure filesystem/Git helpers testable before npm
  // dependencies are installed. The running server already depends on Express.
  const express = require('express');
  const router = express.Router();
  const configFile = path.join(homeDir, 'config.json');
  const envFile = path.join(repoRoot, '.env');
  const casesRoot = () => configuredWorkspacePath(homeDir);

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

  router.get('/dossiers', (req, res) => {
    try {
      res.json({
        dossiers: listDossiers(repoRoot, homeDir),
        tamponConfigured: fs.existsSync(path.join(legalWorkspaceDirectory(repoRoot, homeDir), '.piecemaker', 'tampon.png')),
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get('/repository', async (req, res) => {
    const startedAt = performance.now();
    try {
      const overview = listCases(casesRoot());
      finishAdminTiming(res, 'repository', startedAt, { folders: overview.folders.length });
      res.json(overview);
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  router.get('/repository/case', async (req, res) => {
    const startedAt = performance.now();
    try {
      const folder = await caseOverview(casesRoot(), homeDir, String(req.query.case || '').trim());
      // Les Markdown convertis vivent déjà dans l'historique ; ce cadre ne
      // présente que les pièces originales et un résumé non sensible du mapping.
      folder.originals = folder.originals.filter((file) => file.extension !== '.md');
      const mapping = readCaseMapping(path.join(casesRoot(), folder.path));
      folder.mapping = {
        exists: mapping.exists,
        name: path.basename(mapping.file),
        entries: Object.keys(mapping.mapping).length,
      };
      finishAdminTiming(res, 'case', startedAt, {
        changes: folder.changes,
        originals: folder.originals.length,
      });
      res.json({ folder });
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
      const absolute = caseName ? resolveCase(casesRoot(), caseName).root : resolveCasesRoot(casesRoot());
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
      const job = await startOriginalsJob({
        casesRoot: casesRoot(),
        caseName: String(req.body?.case || '').trim(),
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

  // Le mapping du dossier est le seul fichier de l'administration qui contient
  // des données personnelles en clair : il n'est jamais journalisé, seulement
  // rendu au navigateur local qui l'a demandé.
  router.get('/mapping', (req, res) => {
    try {
      const legalCase = resolveCase(casesRoot(), String(req.query.case || '').trim());
      const mapping = readCaseMapping(legalCase.root);
      res.json({
        case: legalCase.name,
        name: path.basename(mapping.file),
        exists: mapping.exists,
        mapping: mapping.mapping,
        reverse_mapping: mapping.reverse_mapping,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/mapping', (req, res) => {
    try {
      if (!req.body?.mapping || typeof req.body.mapping !== 'object' || Array.isArray(req.body.mapping)) {
        throw new Error('Le mapping doit être un objet { entité: code }.');
      }
      const legalCase = resolveCase(casesRoot(), String(req.body?.case || '').trim());
      const saved = saveCaseMapping(legalCase.root, {
        mapping: req.body.mapping,
        reverse_mapping: req.body.reverse_mapping,
      });
      res.json({
        ok: true,
        case: legalCase.name,
        name: path.basename(saved.file),
        exists: true,
        mapping: saved.mapping,
        reverse_mapping: saved.reverse_mapping,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/mapping/rebuild', async (req, res) => {
    try {
      const legalCase = resolveCase(casesRoot(), String(req.body?.case || '').trim());
      const rebuilt = await rebuildCaseMapping(legalCase.root);
      res.json({
        ok: true,
        case: legalCase.name,
        name: path.basename(rebuilt.file),
        added: rebuilt.added,
        total: rebuilt.total,
        mapping: rebuilt.mapping,
        reverse_mapping: rebuilt.reverse_mapping,
      });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/history', async (req, res) => {
    const startedAt = performance.now();
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
      const caseName = String(req.query.case || '').trim();
      const history = await listHistory(casesRoot(), homeDir, { limit, caseName });
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
      const caseName = String(req.query.case || '').trim();
      const revision = hash === 'WORKTREE'
        ? await worktreeDetails(casesRoot(), homeDir, caseName, filePath, snapshot)
        : await revisionDetails(casesRoot(), homeDir, caseName, hash, filePath);
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
      const label = String(req.body?.label || 'Commit manuel').trim().slice(0, 140);
      const result = await createCommit({
        casesRoot: casesRoot(),
        caseName: String(req.body?.case || '').trim(),
        homeDir,
        label,
        event: 'manual',
      });
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
      const result = await restoreRevision({
        casesRoot: casesRoot(),
        caseName: String(req.body?.case || '').trim(),
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
  createAdminRouter,
  createManagedFile,
  isLocalOrigin,
  legalWorkspaceDirectory,
  listDossiers,
  listManagedFiles,
  managedFileKind,
  normalizeAgentModel,
  normalizeAgentTools,
  readManagedFile,
  revealCommands,
  saveManagedFile,
  updateEnvFile,
};

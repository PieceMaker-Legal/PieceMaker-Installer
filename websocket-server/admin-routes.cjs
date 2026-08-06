const fs = require('fs');
const os = require('os');
const path = require('path');
const { configuredWorkspacePath } = require('./workspace-paths.cjs');
const {
  createCommit,
  listHistory,
  repositoryOverview,
  restoreRevision,
  revisionDetails,
  worktreeDetails,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
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

function listManagedFiles(repoRoot, homeDir = path.join(os.homedir(), '.piecemaker')) {
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

  const billingRoot = path.join(homeDir, 'billing');
  if (fs.existsSync(billingRoot)) {
    const ledgers = fs.readdirSync(billingRoot)
      .filter((entry) => /^\d{4}-\d{2}\.jsonl$/.test(entry))
      .sort()
      .reverse()
      .slice(0, 24);
    for (const ledger of ledgers) candidates.push(`billing/${ledger}`);
  }
  const billingDir = path.join(billingRoot, 'synthese');
  if (fs.existsSync(billingDir)) {
    const reports = fs.readdirSync(billingDir)
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => ({ entry, time: fs.statSync(path.join(billingDir, entry)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 30);
    for (const report of reports) candidates.push(`billing/synthese/${report.entry}`);
  }

  return candidates.map((relativePath) => {
    const { absolute, normalized } = managedAbsolutePath(repoRoot, relativePath, homeDir);
    const kind = managedFileKind(normalized);
    return {
      path: normalized,
      name: kind === 'billing'
        ? normalized.endsWith('.jsonl')
          ? `Suivi mensuel ${path.basename(normalized, '.jsonl')}`
          : path.basename(normalized, '.md')
        : normalized === 'AGENTS.md' || normalized === 'CLAUDE.md'
        ? normalized
        : path.basename(path.dirname(normalized)) === 'agents'
          ? path.basename(normalized, '.md')
          : path.basename(path.dirname(normalized)),
      kind,
      exists: fs.existsSync(absolute),
      readonly: kind === 'billing',
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

function createManagedFile(repoRoot, homeDir, { kind, slug, name, description } = {}) {
  if (!['skill', 'agent'].includes(kind)) throw new Error('Choisissez « skill » ou « agent ».');
  const safeSlug = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeSlug)) {
    throw new Error('L’identifiant doit contenir uniquement des minuscules, chiffres et tirets.');
  }
  const title = String(name || safeSlug).replace(/[\r\n]+/g, ' ').trim().slice(0, 80) || safeSlug;
  const summary = String(description || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
  if (!summary) throw new Error('Une description est requise pour que l’agent sache quand utiliser ce fichier.');
  const relativePath = kind === 'skill'
    ? `piecemaker-plugin/skills/${safeSlug}/SKILL.md`
    : `piecemaker-plugin/agents/${safeSlug}.md`;
  const { absolute } = managedAbsolutePath(repoRoot, relativePath, homeDir);
  if (fs.existsSync(absolute)) throw new Error('Un fichier portant cet identifiant existe déjà.');
  const metadata = kind === 'skill'
    ? `name: ${safeSlug}\ndescription: ${JSON.stringify(summary)}`
    : `name: ${safeSlug}\ndescription: ${JSON.stringify(summary)}\ntools: Read, Grep, Glob\nmodel: sonnet`;
  const content = `---\n${metadata}\n---\n\n# ${title}\n\nDécrivez ici le rôle, les règles et le déroulement attendu.\n`;
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
    const files = listManagedFiles(repoRoot, homeDir);
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
    res.json({ files: listManagedFiles(repoRoot, homeDir) });
  });

  router.post('/files', (req, res) => {
    try {
      res.status(201).json({ ok: true, file: createManagedFile(repoRoot, homeDir, req.body) });
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
      res.json({ ok: true, ...saveManagedFile(repoRoot, homeDir, req.body?.path, req.body?.content) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/repository', (req, res) => {
    try {
      res.json(repositoryOverview(casesRoot(), homeDir));
    } catch (error) {
      res.status(503).json({ error: error.message });
    }
  });

  router.get('/history', (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
      const caseName = String(req.query.case || '').trim();
      res.json({ history: listHistory(casesRoot(), homeDir, { limit, caseName }) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.get('/revision', (req, res) => {
    try {
      const hash = String(req.query.hash || '');
      const filePath = String(req.query.path || '');
      const caseName = String(req.query.case || '').trim();
      res.json(hash === 'WORKTREE'
        ? worktreeDetails(casesRoot(), homeDir, caseName, filePath)
        : revisionDetails(casesRoot(), homeDir, caseName, hash, filePath));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/commits', (req, res) => {
    try {
      const label = String(req.body?.label || 'Commit manuel').trim().slice(0, 140);
      const result = createCommit({
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

  router.post('/restore', (req, res) => {
    try {
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: 'La confirmation explicite de la restauration est requise.' });
      }
      const result = restoreRevision({
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
  listManagedFiles,
  managedFileKind,
  readManagedFile,
  saveManagedFile,
  updateEnvFile,
};

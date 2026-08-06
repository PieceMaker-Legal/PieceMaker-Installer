/**
 * Conversion Markdown et pipeline d'anonymisation des pièces originales d'un
 * dossier juridique, pilotés depuis l'administration.
 *
 * Les originaux ne sortent jamais du dossier : `smart_converter.py` et
 * `convert_and_scan_pipeline.py` sont lancés avec le dossier juridique comme
 * répertoire de sortie, si bien que le Markdown converti et les
 * `*_sensitive_map.json` atterrissent à côté des fichiers déjà versionnés.
 * Seules les lignes `PROGRESS:` et un extrait d'erreur sont conservés dans le
 * journal d'un travail : la sortie brute des scripts peut contenir du texte de
 * pièce, qui ne doit jamais remonter dans l'interface.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  isOriginalDirectoryName,
  originalFilesOverview,
  resolveCase,
  safeCaseFiles,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const CONVERTER_SCRIPT = () => process.env.SMART_CONVERTER_PATH || path.join(SCRIPTS_DIR, 'smart_converter.py');
const PIPELINE_SCRIPT = () => path.join(SCRIPTS_DIR, 'convert_and_scan_pipeline.py');
const PYTHON = () => process.env.PYTHON_PATH || 'python3';
const CANONICAL_MAPPING_FILE = 'mapping_dossier.json';
const MAX_LOG_LINES = 200;
const MAX_ERROR_LINES = 12;
const MAX_FILES_PER_JOB = 200;

/** Les pièces originales listées dans l'administration : tout sauf le Markdown. */
async function listOriginals(caseRoot) {
  const originals = await originalFilesOverview(caseRoot);
  return originals.filter((file) => file.extension !== '.md');
}

/** Fichier de mapping du dossier — un `mapping*.json` existant a priorité. */
function caseMappingFile(caseRoot) {
  let entries = [];
  try {
    entries = fs.readdirSync(caseRoot, { withFileTypes: true });
  } catch {
    return path.join(caseRoot, CANONICAL_MAPPING_FILE);
  }
  const existing = entries
    .filter((entry) => entry.isFile() && /^mapping.*\.json$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'fr'));
  return path.join(caseRoot, existing[0] || CANONICAL_MAPPING_FILE);
}

function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function normalizeMappingDocument(raw) {
  const document = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mapping = {};
  const reverse = {};
  const source = document.mapping && typeof document.mapping === 'object' ? document.mapping : {};
  for (const [entity, code] of Object.entries(source)) {
    const from = String(entity || '').trim();
    const to = String(code || '').trim();
    if (from && to) mapping[from] = to;
  }
  const ignored = [...new Set((Array.isArray(document.ignored) ? document.ignored : [])
    .map((entity) => String(entity || '').trim())
    .filter(Boolean))];
  const reverseSource = document.reverse_mapping && typeof document.reverse_mapping === 'object' ? document.reverse_mapping : {};
  for (const [code, value] of Object.entries(reverseSource)) {
    const key = String(code || '').trim();
    if (!key) continue;
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (values.length) reverse[key] = [...new Set(values)];
  }
  // Un mapping écrit à la main peut n'avoir que le sens direct : on reconstruit
  // le sens inverse plutôt que de laisser un fichier inutilisable.
  for (const [entity, code] of Object.entries(mapping)) {
    if (!reverse[code]) reverse[code] = [entity];
    else if (!reverse[code].includes(entity)) reverse[code].push(entity);
  }
  return { mapping, reverse_mapping: reverse, ignored: ignored.filter((entity) => !mapping[entity]) };
}

/** L'ordre d'écriture suit `byDescendingEntityLength` (anonymization-server.cjs). */
function sortedMapping(mapping) {
  return Object.fromEntries(
    Object.entries(mapping).sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0], 'fr'))
  );
}

function readCaseMapping(caseRoot) {
  const file = caseMappingFile(caseRoot);
  const raw = fs.existsSync(file) ? readJsonFile(file, null) : null;
  return { file, exists: raw !== null, ...normalizeMappingDocument(raw) };
}

function writeCaseMapping(caseRoot, document) {
  const file = caseMappingFile(caseRoot);
  const normalized = normalizeMappingDocument(document);
  const payload = {
    mapping: sortedMapping(normalized.mapping),
    reverse_mapping: normalized.reverse_mapping,
    ...(normalized.ignored.length ? { ignored: normalized.ignored } : {}),
  };
  const temporary = `${file}.piecemaker-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return { file, exists: true, ignored: normalized.ignored, ...payload };
}

/**
 * Enregistre un mapping édité à la main. Une entrée supprimée rejoint
 * `ignored` : c'est ce qui empêche un faux positif écarté par le juriste
 * d'être réintroduit par le scan suivant, que `rebuildCaseMapping` relit.
 */
function saveCaseMapping(caseRoot, document) {
  const current = readCaseMapping(caseRoot);
  const next = normalizeMappingDocument(document);
  const removed = Object.keys(current.mapping).filter((entity) => !next.mapping[entity]);
  const ignored = [...new Set([...current.ignored, ...removed])].filter((entity) => !next.mapping[entity]);
  return writeCaseMapping(caseRoot, { ...next, ignored });
}

function codePrefix(entityType) {
  return String(entityType || 'ENTITE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'ENTITE';
}

/**
 * Fusionne les `*_sensitive_map.json` du dossier dans son mapping.
 * Une entrée déjà présente n'est jamais réécrite : un faux positif retiré à la
 * main ne doit pas revenir au scan suivant, et un code ne doit jamais servir
 * deux fois.
 */
async function rebuildCaseMapping(caseRoot) {
  const current = readCaseMapping(caseRoot);
  const mapping = { ...current.mapping };
  const ignored = new Set(current.ignored);
  const reverse = Object.fromEntries(Object.entries(current.reverse_mapping).map(([code, list]) => [code, [...list]]));
  const counters = new Map();
  for (const code of Object.values(mapping)) {
    const match = /^(.*)_(\d+)$/.exec(code);
    if (!match) continue;
    counters.set(match[1], Math.max(counters.get(match[1]) || 0, Number(match[2])));
  }

  let added = 0;
  for (const relative of await safeCaseFiles(caseRoot)) {
    if (!relative.toLowerCase().endsWith('_sensitive_map.json')) continue;
    const payload = readJsonFile(path.join(caseRoot, ...relative.split('/')), null);
    const entities = payload && typeof payload.entities === 'object' ? payload.entities : {};
    for (const [entityType, hits] of Object.entries(entities)) {
      if (!Array.isArray(hits)) continue;
      const prefix = codePrefix(entityType);
      for (const hit of hits) {
        const text = String(hit?.text || '').trim();
        if (!text || mapping[text] || ignored.has(text)) continue;
        const index = (counters.get(prefix) || 0) + 1;
        counters.set(prefix, index);
        const code = `${prefix}_${String(index).padStart(2, '0')}`;
        mapping[text] = code;
        reverse[code] = [text];
        added += 1;
      }
    }
  }

  const saved = writeCaseMapping(caseRoot, { mapping, reverse_mapping: reverse, ignored: [...ignored] });
  return { ...saved, added, total: Object.keys(saved.mapping).length };
}

// ── Travaux de conversion / anonymisation ──────────────────────────────────

const jobs = new Map();
const JOB_RETENTION_MS = 30 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.finishedAt && now - Date.parse(job.finishedAt) > JOB_RETENTION_MS) jobs.delete(id);
  }
}

function publicJob(job) {
  if (!job) return null;
  const { child, ...rest } = job;
  return rest;
}

function appendLog(job, line) {
  const text = String(line || '').trim();
  if (!text) return;
  job.log.push(text);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

function runningJobForCase(caseName) {
  for (const job of jobs.values()) {
    if (job.state === 'running' && job.case === caseName) return job;
  }
  return null;
}

function getJob(jobId) {
  return publicJob(jobs.get(String(jobId || '')));
}

/**
 * Lance le script Python et suit son avancement. Seules les lignes
 * `PROGRESS:PHASE:pct:courant:total` alimentent le journal ; le reste de la
 * sortie est ignoré (texte de pièce potentiel), à l'exception d'un extrait de
 * stderr conservé pour diagnostiquer un échec.
 */
function spawnTracked(job, script, args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(script)) {
      reject(new Error(`Script introuvable : ${path.basename(script)}`));
      return;
    }
    const child = spawn(PYTHON(), [script, ...args], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    job.child = child;
    const errorLines = [];
    let stdoutRest = '';
    let stderrRest = '';

    const consumeStdout = (chunk) => {
      stdoutRest += chunk;
      const lines = stdoutRest.split(/\r?\n/);
      stdoutRest = lines.pop() || '';
      for (const line of lines) {
        const progress = /^PROGRESS:([A-Z]+):(\d+):(\d+):(\d+)/.exec(line.trim());
        if (!progress) continue;
        job.phase = progress[1] === 'SCAN' ? 'scan' : 'convert';
        job.percent = Math.min(100, Number(progress[2]) || 0);
        job.processed = Number(progress[3]) || 0;
        job.total = Number(progress[4]) || job.total;
        appendLog(job, `${job.phase === 'scan' ? 'Analyse PII' : 'Conversion'} ${job.processed}/${job.total}`);
      }
    };
    const consumeStderr = (chunk) => {
      stderrRest += chunk;
      const lines = stderrRest.split(/\r?\n/);
      stderrRest = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        errorLines.push(text);
        if (errorLines.length > MAX_ERROR_LINES) errorLines.shift();
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', consumeStdout);
    child.stderr.on('data', consumeStderr);
    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => {
      job.child = null;
      if (job.cancelled) {
        reject(new Error('Traitement interrompu.'));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = errorLines.slice(-3).join(' · ');
      reject(new Error(`${path.basename(script)} a échoué (${signal || `code ${code}`})${detail ? ` : ${detail}` : ''}`));
    });
  });
}

async function runJob(job, legalCase, absoluteFiles, options) {
  if (job.action === 'convert') {
    // `smart_converter.py` ne prend qu'un fichier : on avance dossier par
    // dossier pour garder une progression lisible même sans ligne PROGRESS.
    job.phase = 'convert';
    for (const [index, absolute] of absoluteFiles.entries()) {
      job.processed = index;
      job.percent = Math.round((index / absoluteFiles.length) * 100);
      const args = [absolute, '-o', legalCase.root];
      if (options.engine) args.push('--engine', options.engine);
      if (options.mode) args.push('--mode', options.mode);
      if (options.lang) args.push('--lang', options.lang);
      await spawnTracked(job, CONVERTER_SCRIPT(), args);
      job.processed = index + 1;
      job.percent = Math.round(((index + 1) / absoluteFiles.length) * 100);
      appendLog(job, `Conversion ${job.processed}/${absoluteFiles.length}`);
    }
    return { converted: absoluteFiles.length };
  }

  const args = [...absoluteFiles, '-o', legalCase.root];
  if (options.engine) args.push('--engine', options.engine);
  if (options.mode) args.push('--mode', options.mode);
  if (options.lang) args.push('--lang', options.lang);
  await spawnTracked(job, PIPELINE_SCRIPT(), args);
  job.phase = 'mapping';
  job.percent = 100;
  const mapping = await rebuildCaseMapping(legalCase.root);
  appendLog(job, `Mapping : ${mapping.added} nouvelle(s) entrée(s), ${mapping.total} au total`);
  return { scanned: absoluteFiles.length, mappingAdded: mapping.added, mappingTotal: mapping.total };
}

/**
 * Démarre un travail sur les pièces originales d'un dossier.
 * `action` vaut `convert` (Markdown seul) ou `anonymize` (Markdown + scan PII
 * + régénération du mapping). `files` contient des chemins relatifs au sous
 * dossier des originales, tels que renvoyés par `listOriginals`.
 */
async function startOriginalsJob({ casesRoot, caseName, action, files = [], options = {} } = {}) {
  if (!['convert', 'anonymize'].includes(action)) throw new Error('Action inconnue sur les pièces originales.');
  const legalCase = resolveCase(casesRoot, caseName);
  const busy = runningJobForCase(legalCase.name);
  if (busy) throw new Error('Un traitement est déjà en cours sur ce dossier.');

  const originals = await listOriginals(legalCase.root);
  const wanted = new Set(files.map((file) => String(file || '').replaceAll('\\', '/')));
  const selected = wanted.size ? originals.filter((file) => wanted.has(file.path)) : originals;
  if (!selected.length) throw new Error('Aucune pièce originale à traiter.');
  if (selected.length > MAX_FILES_PER_JOB) throw new Error(`Traitement limité à ${MAX_FILES_PER_JOB} pièces à la fois.`);

  const originalsRoot = path.join(legalCase.root, findOriginalsDirectory(legalCase.root));
  const absoluteFiles = selected.map((file) => {
    const absolute = path.resolve(originalsRoot, ...file.path.split('/'));
    if (absolute !== originalsRoot && !absolute.startsWith(`${originalsRoot}${path.sep}`)) {
      throw new Error('Pièce originale hors du dossier.');
    }
    if (!fs.existsSync(absolute)) throw new Error(`Pièce introuvable : ${file.name}`);
    return absolute;
  });

  pruneJobs();
  const job = {
    id: crypto.randomUUID(),
    case: legalCase.name,
    action,
    state: 'running',
    phase: 'convert',
    percent: 0,
    processed: 0,
    total: selected.length,
    files: selected.map((file) => file.path),
    log: [],
    error: null,
    result: null,
    cancelled: false,
    child: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  runJob(job, legalCase, absoluteFiles, options)
    .then((result) => {
      job.state = 'done';
      job.percent = 100;
      job.processed = job.total;
      job.result = result;
    })
    .catch((error) => {
      job.state = 'error';
      job.error = error.message;
    })
    .finally(() => {
      job.child = null;
      job.finishedAt = new Date().toISOString();
    });

  return publicJob(job);
}

function cancelOriginalsJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job || job.state !== 'running') return null;
  job.cancelled = true;
  if (job.child) job.child.kill('SIGTERM');
  return publicJob(job);
}

function findOriginalsDirectory(caseRoot) {
  const entry = fs.readdirSync(caseRoot, { withFileTypes: true })
    .find((candidate) => candidate.isDirectory() && !candidate.isSymbolicLink() && isOriginalDirectoryName(candidate.name));
  if (!entry) throw new Error('Ce dossier n’a pas de sous-dossier « pièces originales ».');
  return entry.name;
}

module.exports = {
  cancelOriginalsJob,
  caseMappingFile,
  getJob,
  listOriginals,
  readCaseMapping,
  rebuildCaseMapping,
  saveCaseMapping,
  startOriginalsJob,
  writeCaseMapping,
};

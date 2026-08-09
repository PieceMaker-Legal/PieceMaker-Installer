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

/**
 * Fichier de mapping du dossier. `mapping_dossier.json` gagne dès qu'il existe :
 * sans cette priorité, un `mapping_default.json` laissé par une ancienne
 * exécution du pipeline passait devant (tri alphabétique) et éclipsait le
 * mapping réellement tenu pour le dossier. À défaut, un `mapping*.json`
 * existant est repris tel quel — c'est celui produit par le CLI.
 */
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
  if (existing.includes(CANONICAL_MAPPING_FILE)) return path.join(caseRoot, CANONICAL_MAPPING_FILE);
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
  // `extracted_data` est écrit par `convert_and_scan_pipeline.py` : c'est lui
  // qui porte les variants d'une entité et l'analyse des adresses, dont la
  // dé-anonymisation partielle a besoin (anonymization-server.cjs:592).
  // L'administration ne l'édite pas, mais elle ne doit surtout pas le détruire —
  // seules les entrées dont le code a disparu du mapping sont retirées.
  const extracted = {};
  const extractedSource = document.extracted_data && typeof document.extracted_data === 'object'
    && !Array.isArray(document.extracted_data) ? document.extracted_data : {};
  for (const [category, codes] of Object.entries(extractedSource)) {
    if (!codes || typeof codes !== 'object' || Array.isArray(codes)) continue;
    extracted[category] = Object.fromEntries(
      Object.entries(codes).filter(([code]) => reverse[code])
    );
  }
  return {
    mapping,
    reverse_mapping: reverse,
    extracted_data: extracted,
    ignored: ignored.filter((entity) => !mapping[entity]),
  };
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
    ...(Object.keys(normalized.extracted_data).length ? { extracted_data: normalized.extracted_data } : {}),
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
  // L'éditeur n'envoie que `mapping` et `reverse_mapping` : `extracted_data`
  // est repris du fichier, sinon un simple enregistrement perdrait les variants.
  const next = normalizeMappingDocument({ extracted_data: current.extracted_data, ...document });
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

// Vocabulaire de codes et regroupement des variantes : mêmes règles que
// `convert_to_anonymization_format` et `consolidate_duplicate_entities` dans
// `scripts/convert_and_scan_pipeline.py`. Les deux chemins écrivent le même
// fichier de mapping — s'ils codaient différemment, une reconstruction depuis
// l'administration dédoublerait les entités déjà codées par le CLI.

const ENTITY_CATEGORIES = {
  PERSON: 'personnes_physiques',
  ORGANIZATION: 'societes',
  LOCATION: 'adresses',
  EMAIL: 'autres',
  PHONE: 'autres',
  CREDIT_CARD: 'autres',
  IBAN: 'autres',
  IP_ADDRESS: 'autres',
  URL: 'autres',
};

function entityCategory(entityType) {
  const type = String(entityType || '').toUpperCase();
  return ENTITY_CATEGORIES[type] || (type.startsWith('ORGANIZATION_') ? 'societes' : 'autres');
}

/** Catégorie d'un code déjà attribué — sert à repartir des bons compteurs. */
function codeCategory(code) {
  if (code.startsWith('PERSONNE_PHYSIQUE_')) return 'personnes_physiques';
  if (code.startsWith('SOCIETE_') || code.startsWith('PERSONNE_MORALE_')) return 'societes';
  if (code.startsWith('ADRESSE_')) return 'adresses';
  if (code.startsWith('SIREN_')) return 'siren';
  return 'autres';
}

function entityCode(entityType, category, index) {
  const number = String(index).padStart(2, '0');
  const type = String(entityType || 'AUTRE').toUpperCase();
  if (category === 'personnes_physiques') return `PERSONNE_PHYSIQUE_${number}`;
  if (category === 'societes') {
    return type.startsWith('ORGANIZATION_')
      ? `SOCIETE_${codePrefix(type.slice('ORGANIZATION_'.length))}_${number}`
      : `PERSONNE_MORALE_${number}`;
  }
  if (category === 'adresses') return `ADRESSE_${number}`;
  return `${codePrefix(type)}_${number}`;
}

/** Forme comparable d'un nom : sans accents, sans civilité, en minuscules. */
function normalizeEntityName(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(mr\.?|mrs\.?|ms\.?|dr\.?|prof\.?|m\.|mme\.?|mlle\.?|maitre)\s*/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .trim();
}

/** Deux écritures d'une même personne : « M. Gilly » et « Bernard Gilly ». */
function areNamesSimilar(first, second) {
  if (!first || !second) return false;
  if (first === second) return true;
  if (Math.min(first.length, second.length) >= 3 && (first.includes(second) || second.includes(first))) return true;
  const tokens = [new Set(first.split(' ')), new Set(second.split(' '))];
  const [shorter, longer] = tokens[0].size <= tokens[1].size ? tokens : [tokens[1], tokens[0]];
  return shorter.size > 0 && [...shorter].every((token) => longer.has(token));
}

/**
 * Regroupe les occurrences d'un type d'entité. Seules les personnes sont
 * consolidées : deux sociétés dont le nom se ressemble restent deux entités.
 */
function groupEntityHits(hits, category) {
  const texts = [...new Set(hits.map((hit) => String(hit?.text || '').trim()).filter(Boolean))];
  if (category !== 'personnes_physiques') return texts.map((text) => [text]);
  const groups = [];
  for (const text of texts) {
    const normalized = normalizeEntityName(text);
    const group = groups.find((candidate) => candidate.normalized.some((member) => areNamesSimilar(normalized, member)));
    if (group) {
      group.texts.push(text);
      group.normalized.push(normalized);
    } else {
      groups.push({ texts: [text], normalized: [normalized] });
    }
  }
  return groups.map((group) => group.texts);
}

/**
 * Fusionne les `*_sensitive_map.json` du dossier dans son mapping.
 * Une entrée déjà présente n'est jamais réécrite : un faux positif retiré à la
 * main ne doit pas revenir au scan suivant, et un code ne doit jamais servir
 * deux fois. Les écritures multiples d'une même personne rejoignent le code
 * déjà attribué au lieu d'en obtenir un second.
 */
async function rebuildCaseMapping(caseRoot) {
  const current = readCaseMapping(caseRoot);
  const mapping = { ...current.mapping };
  const ignored = new Set(current.ignored);
  const reverse = Object.fromEntries(Object.entries(current.reverse_mapping).map(([code, list]) => [code, [...list]]));
  const extracted = Object.fromEntries(
    Object.entries(current.extracted_data).map(([category, codes]) => [category, { ...codes }])
  );

  const counters = new Map();
  for (const code of new Set(Object.values(mapping))) {
    const match = /_(\d+)$/.exec(code);
    if (!match) continue;
    const category = codeCategory(code);
    counters.set(category, Math.max(counters.get(category) || 0, Number(match[1])));
  }

  // Index des noms déjà codés : une variante détectée plus tard rejoint son
  // code d'origine plutôt que d'en créer un nouveau.
  const coded = Object.entries(mapping).map(([entity, code]) => ({
    normalized: normalizeEntityName(entity),
    category: codeCategory(code),
    code,
  }));

  let added = 0;
  for (const relative of await safeCaseFiles(caseRoot)) {
    if (!relative.toLowerCase().endsWith('_sensitive_map.json')) continue;
    const payload = readJsonFile(path.join(caseRoot, ...relative.split('/')), null);
    const entities = payload && typeof payload.entities === 'object' ? payload.entities : {};
    for (const [entityType, hits] of Object.entries(entities)) {
      if (!Array.isArray(hits)) continue;
      const category = entityCategory(entityType);
      for (const group of groupEntityHits(hits, category)) {
        const texts = group.filter((text) => !ignored.has(text));
        if (!texts.length) continue;

        let code = texts.map((text) => mapping[text]).find(Boolean);
        if (!code && category === 'personnes_physiques') {
          const normalized = texts.map(normalizeEntityName);
          code = coded.find((entry) => entry.category === category
            && normalized.some((name) => areNamesSimilar(name, entry.normalized)))?.code;
        }
        const isNewCode = !code;
        if (!code) {
          const index = (counters.get(category) || 0) + 1;
          counters.set(category, index);
          code = entityCode(entityType, category, index);
        }

        // Valeur principale : la plus longue écriture, comme côté Python.
        const principal = [...texts].sort((a, b) => b.length - a.length)[0];
        for (const text of texts) {
          if (mapping[text]) continue;
          mapping[text] = code;
          coded.push({ normalized: normalizeEntityName(text), category, code });
          added += 1;
        }
        if (isNewCode) reverse[code] = [principal];
        for (const text of texts) {
          if (!reverse[code].includes(text)) reverse[code].push(text);
        }

        if (!extracted[category]) extracted[category] = {};
        const entry = extracted[category][code] || { original: principal, code, variants: [] };
        entry.variants = [...new Set([...(entry.variants || []), ...texts])];
        extracted[category][code] = entry;
      }
    }
  }

  const saved = writeCaseMapping(caseRoot, {
    mapping,
    reverse_mapping: reverse,
    extracted_data: extracted,
    ignored: [...ignored],
  });
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

/** Travail rendu déjà terminé — rien à traiter, aucun processus lancé. */
function finishedJob({ case: caseName, action, total, files, result }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    case: caseName,
    action,
    state: 'done',
    phase: 'mapping',
    percent: 100,
    processed: total,
    total,
    skipped: result?.skipped || 0,
    files,
    log: [],
    error: null,
    result,
    cancelled: false,
    child: null,
    startedAt: now,
    finishedAt: now,
  };
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

  // `--mapping-file` vise le mapping du dossier : sans lui le pipeline écrivait
  // son propre `mapping_default.json` à côté, qui prenait ensuite la place du
  // mapping tenu pour le dossier. `--skip-existing` évite de relancer GLiNER sur
  // une pièce déjà scannée — c'est le script qui décide, fichier par fichier.
  const args = [...absoluteFiles, '-o', legalCase.root, '--mapping-file', caseMappingFile(legalCase.root)];
  if (options.skipExisting) args.push('--skip-existing');
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

  // Sans sélection, le travail porte sur tout le dossier et ne refait que ce
  // qui manque : le modèle GLiNER ne se charge pas si tout est déjà scanné.
  // Cocher des pièces vaut demande explicite de les retraiter.
  const forced = wanted.size > 0 || options.force === true;
  const pending = forced
    ? selected
    : selected.filter((file) => (action === 'convert' ? !file.converted : !(file.converted && file.scanned)));
  const skipped = selected.length - pending.length;
  if (pending.length > MAX_FILES_PER_JOB) throw new Error(`Traitement limité à ${MAX_FILES_PER_JOB} pièces à la fois.`);

  pruneJobs();
  if (!pending.length) {
    // Rien à faire : on rend un travail déjà terminé plutôt qu'une erreur, pour
    // que l'administration affiche « à jour » et non un échec.
    const job = finishedJob({
      case: legalCase.name,
      action,
      total: 0,
      files: [],
      result: { converted: 0, scanned: 0, skipped, upToDate: true },
    });
    jobs.set(job.id, job);
    return publicJob(job);
  }

  const originalsRoot = path.join(legalCase.root, findOriginalsDirectory(legalCase.root));
  const absoluteFiles = pending.map((file) => {
    const absolute = path.resolve(originalsRoot, ...file.path.split('/'));
    if (absolute !== originalsRoot && !absolute.startsWith(`${originalsRoot}${path.sep}`)) {
      throw new Error('Pièce originale hors du dossier.');
    }
    if (!fs.existsSync(absolute)) throw new Error(`Pièce introuvable : ${file.name}`);
    return absolute;
  });

  const job = {
    id: crypto.randomUUID(),
    case: legalCase.name,
    action,
    state: 'running',
    phase: 'convert',
    percent: 0,
    processed: 0,
    total: pending.length,
    skipped,
    files: pending.map((file) => file.path),
    log: [],
    error: null,
    result: null,
    cancelled: false,
    child: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);

  runJob(job, legalCase, absoluteFiles, { ...options, skipExisting: !forced })
    .then((result) => {
      job.state = 'done';
      job.percent = 100;
      job.processed = job.total;
      job.result = { ...result, skipped };
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

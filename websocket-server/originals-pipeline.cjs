/**
 * Conversion Markdown et pipeline d'anonymisation des pièces originales d'un
 * dossier juridique, pilotés depuis l'administration.
 *
 * Les originaux ne sortent jamais du dossier : `smart_converter.py` et
 * `convert_and_scan_pipeline.py` sont lancés avec le sous-dossier
 * `Fichiers convertis PieceMaker/` du dossier juridique comme répertoire de
 * sortie, si bien que le Markdown converti et le seul `mapping_default.json` y
 * atterrissent, laissant la racine du dossier aux seuls originaux et documents
 * de travail. L'état technique (`.piecemaker/anonymization-state.json`) reste,
 * lui, à la racine. Seules les lignes `PROGRESS:` et un extrait d'erreur sont conservés dans le
 * journal d'un travail : la sortie brute des scripts peut contenir du texte de
 * pièce, qui ne doit jamais remonter dans l'interface.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  createCommit,
  originalFilesOverview,
  resolveCase,
  safeCaseFiles,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const { documentKey, WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');
const {
  markFilesAnonymized,
  markFilesConverted,
} = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
// Le mapping vit dans le plugin : c'est le seul des trois consommateurs (hooks,
// pipeline, routeur du task pane) qui soit distribué seul.
const {
  caseMappingFile,
  normalizeMappingDocument,
  readCaseMapping,
  readJsonFile,
  sortedMapping,
} = require('../piecemaker-plugin/scripts/lib/mapping.cjs');
// Vocabulaire des sigles de sociétés (SA_1, SARL_1, PERS_MORALE_1…), miroir de
// `_LEGAL_FORMS` (scan_utils.py) — sert à classer un code déjà attribué.
const { isSocieteCode, societeCounterKey } = require('./legal-forms.cjs');
// À chaque enregistrement d'un mapping de dossier, le mapping central global est
// reconstruit et dé-conflicté : c'est lui que le hook central applique à toute
// lecture, dossier ou non. `syncCentralMapping` ne jette jamais — un central qui
// échoue ne doit pas faire échouer la sauvegarde du dossier.
const { syncCentralMapping } = require('../piecemaker-plugin/scripts/lib/central-mapping.cjs');

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const CONVERTER_SCRIPT = () => process.env.SMART_CONVERTER_PATH || path.join(SCRIPTS_DIR, 'smart_converter.py');
const PIPELINE_SCRIPT = () => process.env.PIECEMAKER_PIPELINE_PATH || path.join(SCRIPTS_DIR, 'convert_and_scan_pipeline.py');
const PYTHON = () => process.env.PYTHON_PATH || 'python3';
const MAX_LOG_LINES = 200;
const MAX_ERROR_LINES = 12;
const MAX_FILES_PER_JOB = 200;

const GIB = 1024 ** 3;
/**
 * Contrôle d'admission des traitements — pensé pour ne jamais saturer la machine
 * de l'utilisateur (sa priorité explicite). Deux contraintes :
 *  1. exclusivité GLiNER : au plus un `anonymize` à la fois, quel que soit le
 *     dossier (deux workers chargeraient chacun ~400 Mo de poids et figeraient
 *     l'ordinateur) ;
 *  2. budget RAM : les conversions peuvent tourner en parallèle tant que la somme
 *     de leurs réservations reste sous ~la moitié de la RAM.
 * Tout est réglable par variable d'environnement, ce qui rend aussi les tests
 * déterministes sans dépendre de la RAM réelle.
 */
const RAM_BUDGET_BYTES = () => Number(process.env.PIECEMAKER_RAM_BUDGET_BYTES) || Math.floor(os.totalmem() * 0.5);
const JOB_RESERVE_BYTES = (action) => {
  if (action === 'anonymize') return Number(process.env.PIECEMAKER_ANONYMIZE_JOB_BYTES) || 3 * GIB;
  return Number(process.env.PIECEMAKER_CONVERT_JOB_BYTES) || 2 * GIB;
};
/** Priorité CPU (nice) des process de traitement : cède la main dès que l'utilisateur travaille. */
const JOB_NICE = () => {
  const value = Number(process.env.PIECEMAKER_JOB_NICE);
  return Number.isFinite(value) ? value : 10;
};
/** Threads torch du scanner : abaissé de 6 à 4 pour laisser des cœurs libres (le worker lit cette variable). */
const JOB_TORCH_THREADS = () => process.env.PIECEMAKER_TORCH_THREADS || '4';

/** Les pièces d'un dossier listées dans l'administration : tout sauf le Markdown. */
async function listOriginals(caseRoot) {
  const originals = await originalFilesOverview(caseRoot);
  return originals.filter((file) => file.extension !== '.md');
}

function caseMappingPayload(document) {
  const normalized = normalizeMappingDocument(document);
  return {
    mapping: sortedMapping(normalized.mapping),
    reverse_mapping: normalized.reverse_mapping,
    ...(Object.keys(normalized.extracted_data).length ? { extracted_data: normalized.extracted_data } : {}),
    ...(normalized.ignored.length ? { ignored: normalized.ignored } : {}),
    informations_dossier: normalized.informations_dossier,
  };
}

function writeCaseMapping(caseRoot, document) {
  const file = caseMappingFile(caseRoot);
  const payload = caseMappingPayload(document);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.piecemaker-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, file);
  // Une fois le fichier canonique écrit avec succès, tous les autres mappings
  // sont supprimés : les legacy (`mapping_<id>.json`) comme un `mapping_default.json`
  // resté à la racine par une version antérieure — c'est la migration. La
  // comparaison porte sur le chemin complet, sinon un `mapping_default.json`
  // racine passerait pour le fichier canonique (même basename) et survivrait.
  // `readCaseMapping` les a tous fusionnés au préalable ; aucune entité n'est perdue.
  for (const dir of new Set([caseRoot, path.dirname(file)])) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^mapping.*\.json$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (full === file) continue;
      fs.unlinkSync(full);
    }
  }
  // Le mapping central reflète désormais ce dossier. Best-effort et jamais bloquant.
  try { syncCentralMapping(); } catch { /* le central ne doit pas bloquer une sauvegarde */ }
  return { file, exists: true, ignored: payload.ignored || [], ...payload };
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
  const next = normalizeMappingDocument({
    extracted_data: current.extracted_data,
    informations_dossier: current.informations_dossier,
    ...document,
  });
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
  if (code.startsWith('SIREN_')) return 'siren';
  if (code.startsWith('ADRESSE_') || code.startsWith('LIEU_NAISSANCE_')) return 'adresses';
  if (code.includes('PERSONNE_PHYSIQUE_') || code.startsWith('DIRIGEANT_')) return 'personnes_physiques';
  // Sociétés : repli/legacy (…MORALE…, SOCIETE_…) et codes à sigle (SA_1, GMBH_2).
  // Testé après les familles distinctives, qui ne portent aucun sigle.
  if (isSocieteCode(code)) return 'societes';
  return 'autres';
}

/** Clé de compteur société (le sigle) déduite du type d'entité scanné. */
function societeCodeKey(entityType) {
  const type = String(entityType || '').toUpperCase();
  return type.startsWith('ORGANIZATION_')
    ? (codePrefix(type.slice('ORGANIZATION_'.length)) || 'PERS_MORALE')
    : 'PERS_MORALE';
}

function entityCode(entityType, category, index) {
  const type = String(entityType || 'AUTRE').toUpperCase();
  // Sociétés : sigle en préfixe, sans zéro (SA_1, SARL_1, PERS_MORALE_1), compteur
  // par sigle. Les autres familles gardent leur padding _01.
  if (category === 'societes') return `${societeCodeKey(entityType)}_${index}`;
  const number = String(index).padStart(2, '0');
  if (category === 'personnes_physiques') return `PERSONNE_PHYSIQUE_${number}`;
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
 * Migre les anciens `*_sensitive_map.json` du dossier dans son mapping.
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

  // Compteurs amorcés sur les codes déjà attribués. Les sociétés comptent par
  // sigle : la clé `societes:<sigle>` (SA, SARL, PERS_MORALE…) sépare les suites,
  // pour que la 1re SA soit SA_1 et la 1re SARL SARL_1 indépendamment.
  const counters = new Map();
  for (const code of new Set(Object.values(mapping))) {
    const match = /_(\d+)$/.exec(code);
    if (!match) continue;
    const category = codeCategory(code);
    const key = category === 'societes' ? `societes:${societeCounterKey(code)}` : category;
    counters.set(key, Math.max(counters.get(key) || 0, Number(match[1])));
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
          const key = category === 'societes' ? `societes:${societeCodeKey(entityType)}` : category;
          const index = (counters.get(key) || 0) + 1;
          counters.set(key, index);
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
    informations_dossier: current.informations_dossier,
  });
  const migratedScans = await migrateLegacySensitiveMaps(caseRoot);
  return { ...saved, added, total: Object.keys(saved.mapping).length, migratedScans };
}

/**
 * Transfère l'état porté par les anciens sensitive maps vers le manifeste sans
 * PII, puis retire ces artefacts devenus inutiles. Le mapping doit avoir été
 * reconstruit avant cet appel.
 */
async function migrateLegacySensitiveMaps(caseRoot) {
  const safeFiles = await safeCaseFiles(caseRoot);
  const legacy = safeFiles.filter((relative) => relative.toLowerCase().endsWith('_sensitive_map.json'));
  if (!legacy.length) return 0;

  const scannedKeys = new Set(legacy.map((relative) => {
    const basename = relative.split('/').at(-1) || '';
    return documentKey(basename).replace(/-sensitive-map$/, '');
  }));
  const originals = await listOriginals(caseRoot);
  const scannedOriginals = originals
    .filter((original) => scannedKeys.has(documentKey(original.name)))
    .map((original) => path.join(caseRoot, ...original.path.split('/')));
  if (scannedOriginals.length) markFilesAnonymized(caseRoot, scannedOriginals);

  for (const relative of legacy) fs.unlinkSync(path.join(caseRoot, ...relative.split('/')));
  return legacy.length;
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
function finishedJob({ case: caseName, caseRoot, action, total, files, result }) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    case: caseName,
    caseRoot,
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

/**
 * Forme exposée par l'API. `caseRoot`, `child` et `reserveBytes` en sont retirés :
 * ils ne servent qu'à l'ordonnancement interne, et la réponse de
 * `GET /api/admin/originals/job` n'a pas à véhiculer un chemin absolu du disque du
 * cabinet ni des octets de réservation. `queuePosition` est ajouté pour un job en
 * file, pour que l'admin puisse afficher « N devant ».
 */
function publicJob(job) {
  if (!job) return null;
  const { child, caseRoot, reserveBytes, ...rest } = job;
  if (job.state === 'queued') {
    const position = waiting.findIndex((entry) => entry.job.id === job.id);
    rest.queuePosition = position >= 0 ? position + 1 : 1;
  }
  return rest;
}

function appendLog(job, line) {
  const text = String(line || '').trim();
  if (!text) return;
  job.log.push(text);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

/**
 * Le verrou porte sur la **racine** du dossier, pas sur son nom : deux dossiers
 * juridiques enregistrés distincts peuvent porter le même nom, et un
 * traitement lent sur l'une bloquait alors tout traitement sur l'autre. Un job en
 * file compte aussi : sinon un double-clic empilerait deux traitements du même
 * dossier au lieu d'un seul.
 */
function runningJobForCase(caseRoot) {
  for (const job of jobs.values()) {
    if (['running', 'queued'].includes(job.state) && job.caseRoot === caseRoot) return job;
  }
  return null;
}

function getJob(jobId) {
  return publicJob(jobs.get(String(jobId || '')));
}

// ── Contrôle d'admission : sérialise GLiNER, plafonne les conversions par la RAM ─

/** Descripteurs de traitements admis mais pas encore lancés, du plus ancien au plus récent. */
const waiting = [];
let reservedBytes = 0;

function runningAnonymize() {
  for (const job of jobs.values()) {
    if (job.state === 'running' && job.action === 'anonymize') return true;
  }
  return false;
}

/**
 * Un job peut-il démarrer maintenant ? Exclusivité GLiNER pour `anonymize`, puis
 * budget RAM. Un job seul est toujours admis même s'il dépasse le budget, sinon
 * un traitement plus gros que la moitié de la RAM ne partirait jamais.
 */
function canAdmit(job) {
  if (job.action === 'anonymize' && runningAnonymize()) return false;
  if (reservedBytes > 0 && reservedBytes + job.reserveBytes > RAM_BUDGET_BYTES()) return false;
  return true;
}

/** Admet les traitements en file qui rentrent désormais, du plus ancien au plus récent. */
function pumpQueue() {
  for (let index = 0; index < waiting.length; index += 1) {
    const descriptor = waiting[index];
    if (!canAdmit(descriptor.job)) continue;
    waiting.splice(index, 1);
    index -= 1;
    launchJob(descriptor);
  }
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
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        // Le worker et MinerU, enfants de ce process, héritent de la variable.
        PIECEMAKER_TORCH_THREADS: JOB_TORCH_THREADS(),
      },
      windowsHide: true,
    });
    job.child = child;
    // Basse priorité CPU : un scan long ne doit pas figer la machine. Les enfants
    // (worker GLiNER, MinerU) héritent du nice sous POSIX. Best-effort — un échec
    // (droits, plateforme) ne doit jamais empêcher le traitement.
    try {
      os.setPriority(child.pid, JOB_NICE());
    } catch {
      // priorité inchangée, sans conséquence sur le résultat
    }
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
        const [, marker, pct, current, total] = progress;
        // CONVERT : fichier par fichier. SCAN : fichier par fichier de la phase PII.
        // CHUNKS : progression *à l'intérieur* d'un scan (réémise par le pipeline
        // depuis le worker) — c'est elle qui fait vivre la barre pendant les longues
        // minutes d'un gros document, là où SCAN restait figé sur « 1/1 ».
        job.phase = marker === 'CONVERT' ? 'convert' : 'scan';
        job.percent = Math.min(100, Number(pct) || 0);
        job.processed = Number(current) || 0;
        job.total = Number(total) || job.total;
        const unit = marker === 'CHUNKS' ? ' segments' : '';
        appendLog(job, `${job.phase === 'scan' ? 'Analyse PII' : 'Conversion'} ${job.processed}/${job.total}${unit}`);
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

/**
 * Migration « au prochain traitement », rattachée aux pièces du lot : range dans
 * `WORKSPACE_SUBDIR` le Markdown que d'anciennes versions ont laissé à la racine
 * pour une pièce effectivement (re)traitée. Le rattachement au lot est délibéré —
 * comme `sessionArtifactPaths` — pour ne jamais déplacer un document de travail
 * de l'utilisateur ni un fichier modifié en parallèle. Retourne les chemins
 * racine retirés (POSIX) : le commit du lot les enregistre comme suppressions,
 * sinon la relocalisation resterait un changement en attente.
 *
 * Le mapping n'est **pas** relocalisé ici : sa consolidation reste l'apanage du
 * chemin de succès (`writeCaseMapping`), qui lit les copies racine puis les
 * supprime. Un scan en échec ne doit pas migrer prématurément un ancien mapping.
 */
function migrateRootArtifacts(caseRoot, absoluteFiles) {
  const documentKeys = new Set(absoluteFiles.map((file) => documentKey(file)));
  if (!documentKeys.size) return [];
  let entries;
  try {
    entries = fs.readdirSync(caseRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const toMove = entries.filter((entry) =>
    entry.isFile()
    && path.extname(entry.name).toLowerCase() === '.md'
    && documentKeys.has(documentKey(entry.name)));
  if (!toMove.length) return [];
  const workspaceDir = path.join(caseRoot, WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const removed = [];
  for (const entry of toMove) {
    const source = path.join(caseRoot, entry.name);
    const destination = path.join(workspaceDir, entry.name);
    // Le sous-dossier fait autorité : un doublon plus récent y gagne, on se
    // contente d'écarter la copie racine périmée.
    if (fs.existsSync(destination)) fs.rmSync(source, { force: true });
    else fs.renameSync(source, destination);
    removed.push(entry.name);
  }
  return removed;
}

async function runJob(job, legalCase, absoluteFiles, options) {
  const workspaceDir = path.join(legalCase.root, WORKSPACE_SUBDIR);
  fs.mkdirSync(workspaceDir, { recursive: true });
  job.migratedFromRoot = migrateRootArtifacts(legalCase.root, absoluteFiles);
  if (job.action === 'convert') {
    // `smart_converter.py` ne prend qu'un fichier : on avance dossier par
    // dossier pour garder une progression lisible même sans ligne PROGRESS.
    job.phase = 'convert';
    for (const [index, absolute] of absoluteFiles.entries()) {
      job.processed = index;
      job.percent = Math.round((index / absoluteFiles.length) * 100);
      const args = [absolute, '-o', workspaceDir];
      if (options.engine) args.push('--engine', options.engine);
      if (options.mode) args.push('--mode', options.mode);
      if (options.lang) args.push('--lang', options.lang);
      await spawnTracked(job, CONVERTER_SCRIPT(), args);
      markFilesConverted(legalCase.root, [absolute]);
      job.processed = index + 1;
      job.percent = Math.round(((index + 1) / absoluteFiles.length) * 100);
      appendLog(job, `Conversion ${job.processed}/${absoluteFiles.length}`);
    }
    return { converted: absoluteFiles.length };
  }

  // Tous les anciens mappings sont réunis dans un fichier de travail privé. Le
  // dossier juridique n'est modifié qu'après le succès complet du pipeline : un
  // échec de GLiNER ne doit pas laisser une migration à moitié enregistrée.
  const before = readCaseMapping(legalCase.root);
  const mappingWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-mapping-'));
  const workingMapping = path.join(mappingWorkspace, 'mapping_default.json');
  if (before.exists) {
    fs.writeFileSync(workingMapping, `${JSON.stringify(caseMappingPayload(before), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  // `--mapping-file` vise la copie de travail de l'unique mapping du dossier.
  // `--state-file` découple le statut « analysé » du contenu sensible ; les
  // cartes brutes restent temporaires et ne sont jamais déposées ici.
  const args = [...absoluteFiles, '-o', workspaceDir, '--mapping-file', workingMapping];
  // `--case-root` découple la clé du manifeste de `--output` : les pièces vivent
  // sous le dossier, pas sous le sous-dossier de sortie, donc leur clé d'état doit
  // rester relative au dossier juridique pour correspondre à celle du Node.
  args.push('--case-root', legalCase.root);
  args.push('--state-file', path.join(legalCase.root, '.piecemaker', 'anonymization-state.json'));
  if (options.skipExisting) args.push('--skip-existing');
  if (options.engine) args.push('--engine', options.engine);
  if (options.mode) args.push('--mode', options.mode);
  if (options.lang) args.push('--lang', options.lang);
  try {
    await spawnTracked(job, PIPELINE_SCRIPT(), args);
    const produced = readJsonFile(workingMapping, null);
    if (!produced) throw new Error('Le pipeline n’a produit aucun mapping exploitable.');
    writeCaseMapping(legalCase.root, produced);
  } finally {
    fs.rmSync(mappingWorkspace, { recursive: true, force: true });
  }
  job.phase = 'mapping';
  job.percent = 100;
  // Migration unique des dossiers créés par les anciennes versions : leurs
  // scans sont absorbés dans le mapping et leur état technique avant suppression.
  const mapping = await rebuildCaseMapping(legalCase.root);
  const mappingAdded = Math.max(0, mapping.total - Object.keys(before.mapping).length);
  appendLog(job, `Mapping : ${mappingAdded} nouvelle(s) entrée(s), ${mapping.total} au total`);
  if (mapping.migratedScans) appendLog(job, `${mapping.migratedScans} ancien(s) sensitive map migré(s)`);
  return { scanned: absoluteFiles.length, mappingAdded, mappingTotal: mapping.total };
}

/**
 * Chemins produits par le lot courant. Le filtre est volontairement rattaché
 * aux pièces sélectionnées : un autre fichier Markdown/JSON modifié pendant un
 * OCR long ne doit jamais entrer dans le commit de cette session.
 */
async function sessionArtifactPaths(legalCase, absoluteFiles, action) {
  const documentKeys = new Set(absoluteFiles.map((file) => documentKey(file)));
  const mappingPath = path.relative(legalCase.root, caseMappingFile(legalCase.root)).split(path.sep).join('/');
  const safeFiles = await safeCaseFiles(legalCase.root);
  return safeFiles.filter((relative) => {
    if (action === 'anonymize' && relative === mappingPath) return true;
    const segments = relative.split('/');
    const basename = segments.at(-1) || '';
    const extension = path.extname(basename).toLowerCase();
    const insideDocumentOutput = segments.slice(0, -1).some((segment) => documentKeys.has(documentKey(segment)));
    if (insideDocumentOutput) return true;
    if (extension === '.md') return documentKeys.has(documentKey(basename));
    return false;
  });
}

async function commitJobArtifacts(job, legalCase, absoluteFiles, homeDir) {
  if (!homeDir) return null;
  const artifactPaths = await sessionArtifactPaths(legalCase, absoluteFiles, job.action);
  // Les Markdown relocalisés depuis la racine rejoignent le commit du lot pour
  // que leur suppression à l'ancien emplacement y soit enregistrée proprement.
  const paths = [...new Set([...artifactPaths, ...(job.migratedFromRoot || [])])];
  if (!paths.length) throw new Error('Traitement terminé, mais aucun fichier produit ne peut être commité.');
  job.phase = 'commit';
  appendLog(job, `Commit automatique de ${paths.length} fichier(s)`);
  const count = absoluteFiles.length;
  const commit = await createCommit({
    casesRoot: legalCase.casesRoot,
    caseName: legalCase.name,
    homeDir,
    label: job.action === 'convert'
      ? `Conversion de ${count} pièce${count > 1 ? 's' : ''}`
      : `Conversion et analyse PII de ${count} pièce${count > 1 ? 's' : ''}`,
    sessionId: job.id,
    event: job.action === 'convert' ? 'admin-conversion' : 'admin-scan',
    paths,
    waitForLockMs: 10_000,
  });
  if (commit.skipped === 'busy') throw new Error('Traitement terminé, mais l’historique est occupé : commit automatique non créé.');
  return {
    created: commit.created,
    hash: commit.commit || null,
    files: commit.files || [],
  };
}

/**
 * Démarre un travail sur les pièces d'un dossier.
 * `action` vaut `convert` (Markdown seul) ou `anonymize` (Markdown + scan PII
 * + régénération du mapping). `files` contient des chemins relatifs au dossier
 * juridique, tels que renvoyés par `listOriginals`.
 */
async function startOriginalsJob({ casesRoot, caseName, action, files = [], options = {}, homeDir = null } = {}) {
  if (!['convert', 'anonymize'].includes(action)) throw new Error('Action inconnue sur les pièces originales.');
  const legalCase = resolveCase(casesRoot, caseName);
  const busy = runningJobForCase(legalCase.root);
  if (busy) throw new Error('Un traitement est déjà en cours sur ce dossier.');

  const originals = await listOriginals(legalCase.root);
  const wanted = new Set(files.map((file) => String(file || '').replaceAll('\\', '/')));
  // Les ressources sont volontairement hors périmètre : accessibles à l'IA telles
  // quelles, elles ne sont ni converties ni scannées. On les écarte même si elles
  // sont explicitement cochées, pour que le drapeau reste la seule vérité.
  const selected = (wanted.size ? originals.filter((file) => wanted.has(file.path)) : originals)
    .filter((file) => !file.resource);
  if (!selected.length) throw new Error('Aucune pièce à traiter.');

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
      caseRoot: legalCase.root,
      action,
      total: 0,
      files: [],
      result: { converted: 0, scanned: 0, skipped, upToDate: true },
    });
    jobs.set(job.id, job);
    return publicJob(job);
  }

  // Les chemins sont relatifs au dossier juridique lui-même : les pièces ne
  // vivent plus dans un sous-dossier dédié, elles sont là où le cabinet les a
  // rangées, racine et sous-dossiers confondus.
  const absoluteFiles = pending.map((file) => {
    const absolute = path.resolve(legalCase.root, ...file.path.split('/'));
    if (!absolute.startsWith(`${legalCase.root}${path.sep}`)) {
      throw new Error('Pièce hors du dossier juridique.');
    }
    if (!fs.existsSync(absolute)) throw new Error(`Pièce introuvable : ${file.name}`);
    return absolute;
  });

  const job = {
    id: crypto.randomUUID(),
    case: legalCase.name,
    caseRoot: legalCase.root,
    action,
    state: 'queued',
    phase: 'convert',
    percent: 0,
    processed: 0,
    total: pending.length,
    skipped,
    files: pending.map((file) => file.path),
    reserveBytes: JOB_RESERVE_BYTES(action),
    log: [],
    error: null,
    result: null,
    cancelled: false,
    child: null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };

  // Le descripteur porte tout ce dont `launchJob` a besoin, qu'il démarre
  // maintenant ou plus tard depuis la file.
  return admitOrQueue({ job, legalCase, absoluteFiles, options, homeDir, skipped, forced });
}

/** Démarre le traitement maintenant s'il rentre, sinon le met en file d'attente. */
function admitOrQueue(descriptor) {
  const { job } = descriptor;
  jobs.set(job.id, job);
  if (canAdmit(job)) {
    launchJob(descriptor);
  } else {
    job.state = 'queued';
    waiting.push(descriptor);
  }
  return publicJob(job);
}

/**
 * Lance réellement le traitement : réserve sa RAM, exécute le script Python, puis
 * — quoi qu'il arrive — libère la réservation et relance la file. Le `.finally`
 * est le seul endroit qui rend une place : un traitement qui échoue ne doit pas
 * bloquer la file pour autant.
 */
function launchJob(descriptor) {
  const { job, legalCase, absoluteFiles, options, homeDir, skipped, forced } = descriptor;
  job.state = 'running';
  job.startedAt = new Date().toISOString();
  reservedBytes += job.reserveBytes;

  runJob(job, legalCase, absoluteFiles, { ...options, skipExisting: !forced })
    .then(async (result) => {
      const commit = await commitJobArtifacts(job, legalCase, absoluteFiles, homeDir);
      job.state = 'done';
      job.percent = 100;
      job.processed = job.total;
      job.result = { ...result, skipped, commit };
    })
    .catch((error) => {
      job.state = 'error';
      job.error = error.message;
    })
    .finally(() => {
      job.child = null;
      job.finishedAt = new Date().toISOString();
      reservedBytes -= job.reserveBytes;
      pumpQueue();
    });
}

function cancelOriginalsJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  // Un job encore en file n'a pas de process : on le retire de la file et on
  // laisse la place au suivant.
  if (job.state === 'queued') {
    const index = waiting.findIndex((entry) => entry.job.id === job.id);
    if (index >= 0) waiting.splice(index, 1);
    job.state = 'error';
    job.error = 'Traitement interrompu.';
    job.finishedAt = new Date().toISOString();
    pumpQueue();
    return publicJob(job);
  }
  if (job.state !== 'running') return null;
  job.cancelled = true;
  if (job.child) job.child.kill('SIGTERM');
  return publicJob(job);
}

module.exports = {
  cancelOriginalsJob,
  // Ré-exportés pour les routes de l'administration : l'implémentation vit
  // désormais dans `piecemaker-plugin/scripts/lib/mapping.cjs`.
  caseMappingFile,
  getJob,
  listOriginals,
  readCaseMapping,
  rebuildCaseMapping,
  saveCaseMapping,
  sessionArtifactPaths,
  startOriginalsJob,
  writeCaseMapping,
};

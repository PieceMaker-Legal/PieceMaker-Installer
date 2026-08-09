/**
 * État technique du pipeline d'anonymisation.
 *
 * Le mapping ne doit pas servir de marqueur de traitement : il décrit des
 * entités communes au dossier, pas les fichiers qui ont été scannés. Ce petit
 * manifeste ne stocke donc aucune PII, seulement les empreintes stat (taille +
 * mtime) de chaque original au moment de sa conversion et de son scan.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ANONYMIZATION_STATE_VERSION = 1;
const ANONYMIZATION_STATE_RELATIVE_PATH = '.piecemaker/anonymization-state.json';

function anonymizationStateFile(caseRoot) {
  return path.join(caseRoot, ...ANONYMIZATION_STATE_RELATIVE_PATH.split('/'));
}

function normalizeRelativePath(value) {
  const relative = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) return null;
  return relative;
}

function stateKey(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const files = {};
  if (source.files && typeof source.files === 'object' && !Array.isArray(source.files)) {
    for (const [candidate, entry] of Object.entries(source.files)) {
      const key = /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : stateKey(candidate);
      if (!key || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const normalizeFingerprint = (value, timestampKey = 'updatedAt') => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const size = Number(value.size);
        const mtimeMs = Number(value.mtimeMs);
        if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
        return {
          size,
          mtimeMs: Math.trunc(mtimeMs),
          ...(value[timestampKey] ? { updatedAt: String(value[timestampKey]) } : {}),
        };
      };
      // Compatibilité avec la première version plate du manifeste : un scan
      // réussi impliquait alors nécessairement une conversion réussie.
      const legacy = normalizeFingerprint(entry, 'scannedAt');
      const converted = normalizeFingerprint(entry.converted) || legacy;
      const scanned = normalizeFingerprint(entry.scanned) || legacy;
      if (!converted && !scanned) continue;
      files[key] = {
        ...(converted ? { converted } : {}),
        ...(scanned ? { scanned } : {}),
      };
    }
  }
  return { version: ANONYMIZATION_STATE_VERSION, files };
}

function readAnonymizationState(caseRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(anonymizationStateFile(caseRoot), 'utf8').replace(/^﻿/, ''));
    return normalizeState(raw);
  } catch {
    return normalizeState(null);
  }
}

function statFingerprint(stat) {
  return {
    size: Number(stat.size),
    mtimeMs: Math.trunc(Number(stat.mtimeMs)),
  };
}

function isAnonymizedEntry(entry, stat) {
  if (!entry || !stat) return false;
  const fingerprint = statFingerprint(stat);
  const scanned = entry.scanned || entry;
  return scanned.size === fingerprint.size && scanned.mtimeMs === fingerprint.mtimeMs;
}

function isConvertedEntry(entry, stat) {
  if (!entry || !stat) return false;
  const fingerprint = statFingerprint(stat);
  const converted = entry.converted || entry;
  return converted.size === fingerprint.size && converted.mtimeMs === fingerprint.mtimeMs;
}

/**
 * Enregistre atomiquement les originaux scannés. Les entrées précédentes sont
 * conservées : un lot complète progressivement l'état du dossier.
 */
function markFilesProcessed(caseRoot, files, phase, updatedAt = new Date().toISOString()) {
  const root = fs.realpathSync(caseRoot);
  const state = readAnonymizationState(root);
  for (const file of files || []) {
    const requested = path.resolve(String(file || ''));
    if (!fs.existsSync(requested)) continue;
    const absolute = fs.realpathSync(requested);
    if (!absolute.startsWith(`${root}${path.sep}`)) continue;
    const key = stateKey(path.relative(root, absolute));
    if (!key) continue;
    const fingerprint = { ...statFingerprint(fs.statSync(absolute)), updatedAt };
    state.files[key] = { ...(state.files[key] || {}), [phase]: fingerprint };
    if (phase === 'scanned') state.files[key].converted = fingerprint;
  }

  const target = anonymizationStateFile(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.piecemaker-${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
  return state;
}

function markFilesConverted(caseRoot, files, convertedAt) {
  return markFilesProcessed(caseRoot, files, 'converted', convertedAt);
}

function markFilesAnonymized(caseRoot, files, scannedAt) {
  return markFilesProcessed(caseRoot, files, 'scanned', scannedAt);
}

module.exports = {
  ANONYMIZATION_STATE_RELATIVE_PATH,
  ANONYMIZATION_STATE_VERSION,
  anonymizationStateFile,
  isAnonymizedEntry,
  isConvertedEntry,
  markFilesAnonymized,
  markFilesConverted,
  normalizeState,
  readAnonymizationState,
  stateKey,
  statFingerprint,
};

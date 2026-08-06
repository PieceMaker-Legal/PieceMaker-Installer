#!/usr/bin/env node
/**
 * PostToolUse hook — after Write/Edit produces a document, runs the GLiNER
 * PII scan (websocket-server/scripts/presidio-gliner/presidio-gliner.py) and
 * refreshes mapping_{documentId}.json in the same shape consumed by
 * taskpane/modules/anonymization-server.cjs (flat format: mapping is
 * {entity: code}, reverse_mapping is {code: [entity, ...]} — see the
 * `isHierarchical` branch in anonymization-server.cjs's /api/anonymize/text).
 *
 * documentId here is the file's basename without extension, matching the
 * naming presidio-gliner.py already uses for its own `{stem}_sensitive_map.json`
 * output. This hook runs outside the taskpane session, so it cannot know the
 * app's runtime documentId (a doc_<ts>_<rand> id minted client-side); the
 * stem is the closest stable, discoverable substitute and keeps the mapping
 * file next to its source document.
 *
 * Fails open at every step: missing config, missing python/script, timeout,
 * or a non-zero scan exit all end in exit 0 with at most an informational
 * additionalContext/systemMessage — never a block, never a hang.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  readHookPayload,
  loadPieceMakerConfig,
  runHook,
  noop,
  isUnderAnyRoot,
  hasDocumentExtension,
} from './lib/hook-io.mjs';

const DEFAULT_POST_TIMEOUT_MS = 45000; // GLiNER model load + inference is slow
const IS_WINDOWS = process.platform === 'win32';

function resolvePython(config) {
  if (config.venvPath) {
    const bin = path.join(config.venvPath, IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'python.exe' : 'python');
    if (fs.existsSync(bin)) return bin;
  }
  if (config.pythonPath) return config.pythonPath;
  return IS_WINDOWS ? 'python' : 'python3';
}

/** Spawn the scanner asynchronously; kills it and resolves on timeout instead of hanging. */
function runPythonScript(pythonCmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let child;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child?.kill('SIGKILL');
      } catch {
        // best effort
      }
      resolve({ timedOut: true, code: null, stdout: '', stderr: '' });
    }, timeoutMs);

    try {
      child = spawn(pythonCmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, stdout: '', stderr: '', spawnError: true });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, stdout, stderr, spawnError: true });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, stdout, stderr });
    });
  });
}

/**
 * Flatten presidio-gliner's {entity_type: [{text, ...}]} payload into the
 * flat mapping/reverse_mapping shape. One code per unique normalised text,
 * numbered per entity type (PERSON_01, ORGANIZATION_01, LOCATION_01, ...).
 */
function buildFlatMapping(entitiesMap) {
  const mapping = {};
  const reverseMapping = {};
  const counters = {};
  const countsByType = {};

  for (const [entityType, hits] of Object.entries(entitiesMap || {})) {
    const prefix = /^[A-Z_]+$/.test(entityType) ? entityType : entityType.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    const seen = new Set();
    for (const hit of hits || []) {
      const text = String(hit?.text || '').trim();
      if (!text || seen.has(text) || mapping[text]) continue;
      seen.add(text);
      counters[prefix] = (counters[prefix] || 0) + 1;
      const code = `${prefix}_${String(counters[prefix]).padStart(2, '0')}`;
      mapping[text] = code;
      reverseMapping[code] = [text];
      countsByType[entityType] = (countsByType[entityType] || 0) + 1;
    }
  }
  return { mapping, reverseMapping, countsByType };
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;

  const toolName = payload.tool_name;
  if (toolName !== 'Write' && toolName !== 'Edit') return null;

  // Skip a failed write/edit — nothing new was actually produced.
  if (payload.tool_response && payload.tool_response.success === false) return null;

  const filePath = payload.tool_input?.file_path;
  if (!filePath) return null;

  const config = loadPieceMakerConfig();
  const anonCfg = config.anonymization || {};
  if (anonCfg.enabled === false) return null;

  const extensions = ['.md']; // presidio-gliner.py only accepts Markdown input
  const roots = anonCfg.watchPaths?.length ? anonCfg.watchPaths : (config.workspacePath ? [config.workspacePath] : []);
  const inScope = hasDocumentExtension(filePath, extensions) && (roots.length === 0 || isUnderAnyRoot(filePath, roots));
  if (!inScope) return null;

  if (!fs.existsSync(filePath)) return null;

  const scriptPath = anonCfg.glinerScriptPath;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return { systemMessage: '[PieceMaker] Scanner PII non configuré (anonymization.glinerScriptPath) — exécutez l\'étape 06-hooks de l\'installeur.' };
  }

  const pythonCmd = resolvePython(config);
  const outputDir = path.dirname(filePath);
  const timeoutMs = anonCfg.postScanTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;

  const result = await runPythonScript(pythonCmd, [scriptPath, filePath, '-o', outputDir], timeoutMs);

  if (result.timedOut) {
    return { systemMessage: `[PieceMaker] Scan PII interrompu après ${timeoutMs}ms (délai dépassé) — document non analysé.` };
  }
  if (result.spawnError) {
    return { systemMessage: `[PieceMaker] Impossible de lancer le scanner PII (python introuvable: ${pythonCmd}).` };
  }
  if (result.code !== 0) {
    return { systemMessage: '[PieceMaker] Le scan PII a échoué — voir les journaux pour plus de détails.' };
  }

  const stem = path.basename(filePath, path.extname(filePath));
  const sensitiveMapPath = path.join(outputDir, `${stem}_sensitive_map.json`);

  let scanPayload;
  try {
    scanPayload = JSON.parse(fs.readFileSync(sensitiveMapPath, 'utf8'));
  } catch {
    return { systemMessage: '[PieceMaker] Scan PII terminé mais la sortie est illisible.' };
  }

  const { mapping, reverseMapping, countsByType } = buildFlatMapping(scanPayload.entities);
  const documentId = stem;
  const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

  try {
    fs.writeFileSync(
      mappingPath,
      JSON.stringify({ mapping, reverse_mapping: reverseMapping, extracted_data: {} }, null, 2),
      'utf8'
    );
  } catch {
    return { systemMessage: '[PieceMaker] Scan PII terminé mais l\'écriture du mapping a échoué.' };
  }

  const total = Object.values(countsByType).reduce((a, b) => a + b, 0);
  const detail = Object.entries(countsByType)
    .map(([type, count]) => `${count} ${type}`)
    .join(', ');
  const summary = total > 0
    ? `[PieceMaker] Scan PII: ${total} entité(s) détectée(s) (${detail}). Mapping: ${mappingPath}`
    : `[PieceMaker] Scan PII: aucune entité détectée dans ${path.basename(filePath)}.`;

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: summary,
    },
    systemMessage: summary,
  };
}

const config = loadPieceMakerConfig();
const postTimeoutMs = config.anonymization?.postScanTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;

// Outer safety net sits above the inner spawn-kill timeout so the inner one
// always fires first and cleans up the child process properly.
runHook(main, { timeoutMs: postTimeoutMs + 3000 }).catch(() => noop());

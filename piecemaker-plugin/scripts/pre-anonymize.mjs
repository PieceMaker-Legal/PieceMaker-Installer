#!/usr/bin/env node
/**
 * PreToolUse hook — warns before Claude reads a document that may contain PII.
 *
 * Wired alongside the originals guard in hooks/hooks.json. Runs on every
 * matching tool call, so
 * the no-op path (irrelevant tool, irrelevant path, feature disabled) must
 * exit immediately without touching the filesystem beyond a stat.
 *
 * This is NOT the full GLiNER pipeline (websocket-server/scripts/presidio-gliner) —
 * loading that model per keystroke-adjacent Read call would make the hook
 * unusable. Instead this runs a small set of linear-time regexes (email,
 * phone, IBAN, SIREN/SIRET) as a fast heuristic. The real scan runs from
 * post-anonymize.mjs after a document is produced.
 *
 * Never blocks by default: PII found -> additionalContext warning only.
 * Blocking is opt-in via config.anonymization.blockOnPII.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  readHookPayload,
  loadPieceMakerConfig,
  runHook,
  noop,
  isUnderAnyRoot,
  hasDocumentExtension,
} from './lib/hook-io.mjs';

const DEFAULT_EXTENSIONS = ['.md', '.txt', '.docx', '.doc', '.pdf', '.pptx', '.ppt', '.xlsx', '.xls', '.rtf', '.odt'];
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_SCAN_BYTES = 512 * 1024; // cap read cost on huge files

// Linear-time patterns only — no nested quantifiers, no catastrophic backtracking.
const HEURISTICS = [
  { type: 'EMAIL', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'PHONE_FR', regex: /(?:\+33|0)[1-9](?:[ .-]?\d{2}){4}/g },
  { type: 'IBAN', regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,6}\b/g },
  { type: 'SIREN_SIRET', regex: /\b\d{3}[ ]?\d{3}[ ]?\d{3}(?:[ ]?\d{5})?\b/g },
];

function scanForPII(text) {
  const found = {};
  for (const { type, regex } of HEURISTICS) {
    regex.lastIndex = 0;
    const matches = text.match(regex);
    if (matches && matches.length) found[type] = matches.length;
  }
  return found;
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null; // malformed/empty stdin -> noop

  const toolName = payload.tool_name;
  if (toolName !== 'Read' && toolName !== 'Grep') return null;

  const filePath = payload.tool_input?.file_path || payload.tool_input?.path;
  if (!filePath) return null;

  const config = loadPieceMakerConfig();
  const anonCfg = config.anonymization || {};
  if (anonCfg.enabled === false) return null;

  const extensions = anonCfg.documentExtensions || DEFAULT_EXTENSIONS;
  const roots = anonCfg.watchPaths || (config.outputPath ? [config.outputPath] : []);

  const inScope = hasDocumentExtension(filePath, extensions) && (roots.length === 0 || isUnderAnyRoot(filePath, roots));
  if (!inScope) return null;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null; // file doesn't exist / unreadable — let the real tool call surface that
  }
  if (!stat.isFile()) return null;

  let content;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = Math.min(stat.size, MAX_SCAN_BYTES);
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, 0);
      content = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const found = scanForPII(content);
  const totalHits = Object.values(found).reduce((a, b) => a + b, 0);
  if (totalHits === 0) return null;

  const summary = Object.entries(found)
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
  const fileName = path.basename(filePath);
  const warning = `[PieceMaker] Données potentiellement sensibles détectées dans ${fileName} (${summary}). Pensez à anonymiser ce document avant tout envoi externe.`;

  const blockOnPII = anonCfg.blockOnPII === true;

  if (blockOnPII) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: warning,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: warning,
    },
    systemMessage: warning,
  };
}

const config = loadPieceMakerConfig();
const timeoutMs = config.anonymization?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

runHook(main, { timeoutMs }).catch(() => noop());

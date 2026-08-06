#!/usr/bin/env node
/**
 * Billing / task-tracking hook, wired to both Stop and TaskCompleted in
 * hooks/hooks.json (a single script, dispatching on payload.hook_event_name).
 *
 * Confirmed payload shapes (https://code.claude.com/docs/en/hooks):
 *   Stop           -> { last_assistant_message, stop_reason, ...common }
 *   TaskCompleted  -> { task_id, task_name, task_status, ...common }
 *   common fields  -> session_id, transcript_path, cwd, hook_event_name, ...
 *
 * Stop already carries the final assistant text directly as
 * `last_assistant_message` — no transcript parsing is required to get it.
 * We still read transcript_path as a fallback (in case that field is ever
 * empty) and to derive tool-call counts and a rough session duration, since
 * neither event's payload provides those.
 *
 * - Appends one JSONL line per event to ~/.piecemaker/billing/<YYYY-MM>.jsonl
 * - On Stop, saves a copy of the final synthesis to
 *   ~/.piecemaker/billing/synthese/<session_id>-<timestamp>.md
 *
 * This hook never returns JSON output — it only records; it never affects
 * the session. Every failure path is swallowed and ends in exit 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  readHookPayload,
  loadPieceMakerConfig,
  runHook,
  noop,
  ensureDirSafe,
  appendJsonl,
  BILLING_DIR,
  SYNTHESIS_DIR,
} from './lib/hook-io.mjs';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024; // skip duration/tool-count derivation beyond this

/** Best-effort transcript scan: session duration bounds, tool-call counts, last assistant text. */
async function analyzeTranscript(transcriptPath) {
  const empty = { firstTimestamp: null, lastTimestamp: null, toolCounts: {}, lastAssistantText: null };
  if (!transcriptPath) return empty;

  let stat;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch {
    return empty;
  }
  if (stat.size > MAX_TRANSCRIPT_BYTES) return empty;

  let raw;
  try {
    raw = await fs.promises.readFile(transcriptPath, 'utf8');
  } catch {
    return empty;
  }

  let firstTimestamp = null;
  let lastTimestamp = null;
  const toolCounts = {};
  let lastAssistantText = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const ts = entry.timestamp || entry.message?.timestamp;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    const role = entry.type || entry.message?.role;
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name) {
          toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
        }
        if (role === 'assistant' && block?.type === 'text' && typeof block.text === 'string') {
          lastAssistantText = block.text;
        }
      }
    }
  }

  return { firstTimestamp, lastTimestamp, toolCounts, lastAssistantText };
}

function derivedDurationMs(analysis) {
  if (!analysis.firstTimestamp || !analysis.lastTimestamp) return null;
  const ms = Date.parse(analysis.lastTimestamp) - Date.parse(analysis.firstTimestamp);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** dossier = first path segment of cwd relative to the configured output dir, if any. */
function detectDossier(cwd, config) {
  if (!cwd || !config.outputPath) return null;
  const resolvedOutput = path.resolve(config.outputPath);
  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd === resolvedOutput) return null;
  if (!resolvedCwd.startsWith(resolvedOutput + path.sep)) return null;
  const rel = path.relative(resolvedOutput, resolvedCwd);
  return rel.split(path.sep)[0] || null;
}

function synthesisFilePath(sessionId, isoTimestamp) {
  const safeSession = String(sessionId || 'unknown-session').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeTs = isoTimestamp.replace(/[:.]/g, '-');
  return path.join(SYNTHESIS_DIR, `${safeSession}-${safeTs}.md`);
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;

  const eventName = payload.hook_event_name;
  if (eventName !== 'Stop' && eventName !== 'TaskCompleted') return null;

  const config = loadPieceMakerConfig();
  if (config.billing?.enabled === false) return null;

  ensureDirSafe(BILLING_DIR);
  ensureDirSafe(SYNTHESIS_DIR);

  const nowIso = new Date().toISOString();
  const monthFile = path.join(BILLING_DIR, `${nowIso.slice(0, 7)}.jsonl`); // YYYY-MM.jsonl
  const dossier = detectDossier(payload.cwd, config);
  const analysis = await analyzeTranscript(payload.transcript_path);

  if (eventName === 'TaskCompleted') {
    appendJsonl(monthFile, {
      timestamp: nowIso,
      session_id: payload.session_id || null,
      cwd: payload.cwd || null,
      dossier,
      task_label: payload.task_name || null,
      event: 'TaskCompleted',
      task_id: payload.task_id || null,
      task_status: payload.task_status || null,
      duration_ms: derivedDurationMs(analysis),
      tool_counts: analysis.toolCounts,
      synthesis_path: null,
    });
    return null;
  }

  // Stop: prefer the payload's own last_assistant_message; fall back to the
  // transcript only if that field is missing or empty.
  const synthesisText = (payload.last_assistant_message && payload.last_assistant_message.trim())
    || analysis.lastAssistantText
    || '';

  let synthesisPath = null;
  if (synthesisText) {
    const target = synthesisFilePath(payload.session_id, nowIso);
    try {
      fs.writeFileSync(target, synthesisText, 'utf8');
      synthesisPath = target;
    } catch {
      synthesisPath = null;
    }
  }

  const taskLabel = synthesisText ? synthesisText.split('\n')[0].slice(0, 80) : 'Synthèse de session';

  appendJsonl(monthFile, {
    timestamp: nowIso,
    session_id: payload.session_id || null,
    cwd: payload.cwd || null,
    dossier,
    task_label: taskLabel,
    event: 'Stop',
    stop_reason: payload.stop_reason || null,
    duration_ms: derivedDurationMs(analysis),
    tool_counts: analysis.toolCounts,
    synthesis_path: synthesisPath,
  });

  return null;
}

const config = loadPieceMakerConfig();
const timeoutMs = config.billing?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

runHook(main, { timeoutMs }).catch(() => noop());

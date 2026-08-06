/**
 * Shared I/O helpers for PieceMaker Claude Code hooks.
 *
 * Contract confirmed against https://code.claude.com/docs/en/hooks:
 *  - stdin carries one JSON object per invocation. Common fields on every
 *    event: session_id, transcript_path, cwd, permission_mode,
 *    hook_event_name (+ prompt_id, agent_id/agent_type when applicable).
 *  - PreToolUse adds: tool_name, tool_input, tool_use_id.
 *  - PostToolUse adds: tool_name, tool_input, tool_response, tool_use_id.
 *  - Stop adds: last_assistant_message, stop_reason.
 *  - TaskCompleted adds: task_id, task_name, task_status.
 *  - Exit code 0 + JSON on stdout -> JSON is applied. Exit code 2 -> blocking
 *    error, stderr shown as the reason, stdout ignored. Any other exit code
 *    -> non-blocking error, action proceeds, first stderr line surfaced.
 *  - Never mix "exit code only" and "exit 0 + JSON" signalling.
 *
 * Every hook in this plugin fails open: on any internal error, on timeout, or
 * when nothing relevant applies, it exits 0 with no stdout so the session is
 * completely unaffected.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = path.join(os.homedir(), '.piecemaker');
export const CONFIG_FILE = path.join(HOME_DIR, 'config.json');
export const BILLING_DIR = path.join(HOME_DIR, 'billing');
export const SYNTHESIS_DIR = path.join(BILLING_DIR, 'synthese');

/**
 * Read stdin fully as text, bounded by timeoutMs. Never rejects — resolves
 * with whatever was collected (possibly '') on timeout, error, or a TTY with
 * nothing piped in (e.g. a manual test run).
 */
export function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish();
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish();
      });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/** Parse the hook JSON payload from stdin. Returns null on any failure. */
export async function readHookPayload(timeoutMs = 3000) {
  const raw = await readStdin(timeoutMs);
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Load ~/.piecemaker/config.json. Returns {} when absent or invalid. */
export function loadPieceMakerConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Exit 0 with no stdout — the fast "ignore this event" path. */
export function noop() {
  process.exit(0);
}

/** Exit 0 and print a JSON hook-output object to stdout. */
export function emit(output) {
  try {
    if (output && typeof output === 'object') {
      process.stdout.write(JSON.stringify(output));
    }
  } catch {
    // Serialization failure must never block the session.
  }
  process.exit(0);
}

/**
 * Run the hook body against a hard timeout. On timeout, a thrown error, or a
 * falsy/non-object return value, fail open (exit 0, no output). Otherwise the
 * returned object is emitted as the hook's JSON output.
 *
 * Note: this only protects async work (spawned children, timers). Purely
 * synchronous CPU-bound code blocks the event loop and the timeout cannot
 * preempt it — keep synchronous scan logic linear-time and bounded in input
 * size (see pre-anonymize.mjs).
 */
export async function runHook(bodyFn, { timeoutMs = 5000 } = {}) {
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    });
    const result = await Promise.race([bodyFn(), timeout]);
    clearTimeout(timer);
    if (result === '__timeout__' || !result || typeof result !== 'object') {
      noop();
      return;
    }
    emit(result);
  } catch {
    clearTimeout(timer);
    noop();
  }
}

/** True when filePath resolves to somewhere under one of roots. */
export function isUnderAnyRoot(filePath, roots) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return (roots || []).some((root) => {
    if (!root) return false;
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

export function hasDocumentExtension(filePath, extensions) {
  if (!filePath) return false;
  const ext = path.extname(filePath).toLowerCase();
  return (extensions || []).includes(ext);
}

/** mkdir -p that never throws — callers check the return value. */
export function ensureDirSafe(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Append one line to a JSONL file. Single appendFileSync call, never throws. */
export function appendJsonl(filePath, obj) {
  try {
    ensureDirSafe(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

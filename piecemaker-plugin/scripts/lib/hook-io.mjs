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

/** Upper bound on waiting for stdout to drain before exiting anyway. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Read stdin fully as text, tracking whether the stream reached a clean `end`.
 * Never rejects — resolves with `{ data, complete }`:
 *  - `data`     : everything collected so far (possibly '').
 *  - `complete` : true only when the stream ended cleanly (EOF). false on a
 *                 timeout or a stream error, where `data` may be partial.
 *
 * A TTY with nothing piped in resolves `{ data: '', complete: true }`: there is
 * genuinely no input, which is not a truncation.
 *
 * The timeout is only a safety net against a producer that never closes the
 * pipe. It must be generous enough that a large-but-live payload always reaches
 * `end` before it fires — a premature timeout that returns partial bytes is the
 * root cause of the size-dependent leak this guards against.
 */
export function readStdinDetailed(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({ data: '', complete: true });
      return;
    }
    let data = '';
    let done = false;
    const finish = (complete) => {
      if (done) return;
      done = true;
      resolve({ data, complete });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        finish(true);
      });
      process.stdin.on('error', () => {
        clearTimeout(timer);
        finish(false);
      });
    } catch {
      clearTimeout(timer);
      finish(false);
    }
  });
}

/**
 * Read stdin fully as text, bounded by timeoutMs. Never rejects — resolves
 * with whatever was collected (possibly '') on timeout, error, or a TTY with
 * nothing piped in (e.g. a manual test run). Thin wrapper over
 * `readStdinDetailed` that drops the completeness flag, for callers that only
 * need the text.
 */
export async function readStdin(timeoutMs = 3000) {
  const { data } = await readStdinDetailed(timeoutMs);
  return data;
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

/**
 * Like `readHookPayload`, but never hides a truncated/garbled input as "nothing
 * to do". Returns `{ payload, raw, complete }`:
 *  - `payload`  : the parsed object, or null when parsing failed.
 *  - `raw`      : the exact stdin text (possibly partial).
 *  - `complete` : true only when the stream reached a clean EOF.
 *
 * A hook that guards a privacy boundary must tell apart three cases that
 * `readHookPayload` collapses into a single `null`:
 *  1. empty input (TTY / nothing piped)      → raw '' , complete true  → fail open;
 *  2. a valid, fully-read payload            → payload set             → normal;
 *  3. non-empty input that will not parse    → payload null, raw set   → fail CLOSED,
 *     whether because it was cut off mid-stream (`complete` false) or arrived
 *     whole but malformed (`complete` true).
 */
export async function readHookPayloadStrict(timeoutMs = 3000) {
  const { data: raw, complete } = await readStdinDetailed(timeoutMs);
  if (!raw || !raw.trim()) return { payload: null, raw: raw || '', complete };
  try {
    return { payload: JSON.parse(raw), raw, complete };
  } catch {
    return { payload: null, raw, complete };
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

/**
 * Exit 0 and print a JSON hook-output object to stdout.
 *
 * The write is awaited before exiting. On a pipe — which is exactly how Claude
 * Code runs a hook — stdout is asynchronous, and `process.exit()` drops
 * whatever is still in flight past the 64 KB pipe buffer. A truncated JSON is
 * unparseable, so the harness can fall back to the original hook result. A
 * security guard must not depend on payload size.
 */
export function emit(output) {
  let payload;
  try {
    if (!output || typeof output !== 'object') {
      noop();
      return;
    }
    payload = JSON.stringify(output);
  } catch {
    // Serialization failure must never block the session.
    noop();
    return;
  }

  // Safety net: an stdout that never drains must not hang the session either.
  // Unref'd, so a completed write exits immediately instead of waiting it out.
  const guard = setTimeout(() => process.exit(0), FLUSH_TIMEOUT_MS);
  guard.unref?.();
  process.stdout.write(payload, () => {
    clearTimeout(guard);
    process.exit(0);
  });
}

/**
 * Run the hook body against a hard timeout. On timeout, a thrown error, or a
 * falsy/non-object return value, fail open (exit 0, no output). Otherwise the
 * returned object is emitted as the hook's JSON output.
 *
 * Note: this only protects async work (spawned children, timers). Purely
 * synchronous CPU-bound code blocks the event loop and the timeout cannot
 * preempt it. That is deliberate for the substitution in mapping.cjs, which has
 * no size ceiling: a hook that returned early on a large document would hand
 * the model the original text in clear. The body's promise settles as a
 * microtask, ahead of the timer's macrotask, so a slow substitution is always
 * emitted in full — verified against an 8 s synchronous body under a 5 s
 * timeout. The timeout remains what it was meant for: async work that hangs.
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

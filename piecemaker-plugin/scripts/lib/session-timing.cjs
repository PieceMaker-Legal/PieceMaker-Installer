/**
 * Session timing helpers shared by the commit and billing hooks.
 *
 * A hook runs once per event with no memory of the session's start. The
 * transcript is the only durable clock: its first entry's `timestamp` is the
 * session start. `commit-track.mjs` needs that start on every Write/Edit to
 * stamp the elapsed session time into the commit, so reading the whole
 * transcript on each tool call would be wasteful — we only need the first
 * timestamp, so we scan a bounded head of the file.
 *
 * Everything here fails soft: an unreadable/empty/malformed transcript yields
 * `null`, and the caller simply omits the time trailer.
 */
const fs = require('node:fs');

// Enough to comfortably contain the first JSONL record even with a large
// system prompt echoed into it; we stop at the first line that parses.
const HEAD_BYTES = 256 * 1024;

/** First ISO timestamp in the transcript (session start), or null. */
function readSessionStartTimestamp(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, HEAD_BYTES);
    if (length === 0) return null;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // The last line of a partial head read may be truncated; ignore parse
      // failures and keep looking for the first fully-formed record.
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = entry?.timestamp || entry?.message?.timestamp;
      if (ts && Number.isFinite(Date.parse(ts))) return ts;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/** Milliseconds elapsed between the session's first entry and `now`. */
function sessionElapsedMs(transcriptPath, now = Date.now()) {
  const start = readSessionStartTimestamp(transcriptPath);
  if (!start) return null;
  const ms = now - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Compact French duration, e.g. "12 min 30 s", "1 h 05 min", "8 s". */
function formatDurationFr(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
  return `${seconds} s`;
}

module.exports = {
  formatDurationFr,
  readSessionStartTimestamp,
  sessionElapsedMs,
};

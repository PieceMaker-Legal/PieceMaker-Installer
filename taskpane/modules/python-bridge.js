/**
 * Python Bridge Module
 *
 * Generic, scalable bridge for executing Python scripts via server.cjs.
 * Adding a new script requires only:
 *   1. An entry in PYTHON_SCRIPTS on the server side (server.cjs)
 *   2. A call to executePythonScript(scriptId, file, options, callbacks) here
 *
 * WebSocket protocol (all messages carry a jobId for multiplexing):
 *   C → S:  { type: 'python-exec',    jobId, scriptId, filePath, options, documentId }
 *   C → S:  { type: 'python-exec-batch', jobId, scriptId, filePaths, fileNames, options, documentId }
 *   C → S:  { type: 'python-cancel',  jobId }
 *   S → C:  { type: 'python-output',  jobId, stream: 'stdout'|'stderr', data }
 *   S → C:  { type: 'python-done',    jobId, exitCode, outputDir }
 *   S → C:  { type: 'python-error',   jobId, error }
 */

// deps.ws must be a getter so it always resolves to the live WebSocket
let deps = {};

// Per-job callbacks: Map<jobId, { onOutput, onDone, onError }>
const jobCallbacks = new Map();

/**
 * Initialise the bridge.
 * @param {object} dependencies — must include a `ws` getter that returns the live WebSocket
 */
export function initPythonBridge(dependencies) {
  deps = dependencies;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function generateJobId() {
  return 'py_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/**
 * Upload a single file to the server as raw bytes.
 * The filename is sent via the X-Filename header; the server sanitises it.
 */
async function uploadFile(file, documentId = null) {
  const buffer = await file.arrayBuffer();
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Filename': encodeURIComponent(file.name)
  };
  if (documentId) headers['X-Document-Id'] = documentId;

  const response = await fetch('https://localhost:43098/api/python/upload', {
    method: 'POST',
    headers,
    body: buffer
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload échoué (${response.status}): ${body}`);
  }
  return response.json(); // { filePath }
}

/**
 * Upload multiple files to the server.
 * @param {File[]} files — array of File objects
 * @returns {Promise<string[]>} — array of server-side file paths
 */
async function uploadFiles(files, documentId = null) {
  const filePaths = [];
  for (const file of files) {
    const { filePath } = await uploadFile(file, documentId);
    filePaths.push(filePath);
  }
  return filePaths;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Execute a registered Python script on the server.
 *
 * @param {string}   scriptId  — key in the server-side PYTHON_SCRIPTS registry
 * @param {File}     file      — file to upload and process
 * @param {object}   [options] — script-specific options forwarded to the server
 * @param {object}   [callbacks]
 * @param {function} [callbacks.onOutput]  — (data: string, stream: 'stdout'|'stderr') => void
 * @param {function} [callbacks.onDone]    — (exitCode: number, outputDir: string)   => void
 * @param {function} [callbacks.onError]   — (error: string)                         => void
 * @returns {Promise<string>} jobId — use with cancelPythonScript() if needed
 */
export async function executePythonScript(scriptId, file, options = {}, callbacks = {}, documentId = null) {
  const jobId = generateJobId();

  if (callbacks.onOutput || callbacks.onDone || callbacks.onError) {
    jobCallbacks.set(jobId, callbacks);
  }

  // 1) Upload file to server
  const { filePath } = await uploadFile(file, documentId);

  // 2) Kick off execution via WebSocket
  const socket = deps.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    jobCallbacks.delete(jobId);
    throw new Error('WebSocket non connecté');
  }

  socket.send(JSON.stringify({
    type: 'python-exec',
    jobId,
    scriptId,
    filePath,
    options,
    documentId
  }));

  return jobId;
}

/**
 * Execute a registered Python script on multiple files.
 *
 * @param {string}   scriptId  — key in the server-side PYTHON_SCRIPTS registry
 * @param {File[]}   files     — array of files to upload and process
 * @param {object}   [options] — script-specific options forwarded to the server
 * @param {object}   [callbacks]
 * @param {function} [callbacks.onOutput]  — (data: string, stream: 'stdout'|'stderr') => void
 * @param {function} [callbacks.onDone]    — (exitCode: number, outputDir: string)   => void
 * @param {function} [callbacks.onError]   — (error: string)                         => void
 * @param {function} [callbacks.onFileStart] — (fileName: string, index: number, total: number) => void
 * @param {function} [callbacks.onFileComplete] — (fileName: string, index: number, total: number, exitCode: number) => void
 * @returns {Promise<string>} jobId — use with cancelPythonScript() if needed
 */
export async function executePythonScriptBatch(scriptId, files, options = {}, callbacks = {}, documentId = null) {
  const batchJobId = generateJobId();

  if (callbacks.onOutput || callbacks.onDone || callbacks.onError || callbacks.onFileStart || callbacks.onFileComplete) {
    jobCallbacks.set(batchJobId, callbacks);
  }

  // 1) Upload all files to server
  const filePaths = await uploadFiles(files, documentId);

  // 2) Kick off batch execution via WebSocket
  const socket = deps.ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    jobCallbacks.delete(batchJobId);
    throw new Error('WebSocket non connecté');
  }

  socket.send(JSON.stringify({
    type: 'python-exec-batch',
    jobId: batchJobId,
    scriptId,
    filePaths,
    fileNames: files.map(f => f.name),
    options,
    documentId
  }));

  return batchJobId;
}

/**
 * Cancel a running Python script by jobId.
 */
export function cancelPythonScript(jobId) {
  const socket = deps.ws;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'python-cancel', jobId }));
  }
  jobCallbacks.delete(jobId);
}

// ──────────────────────────────────────────────
// WebSocket message router (called from taskpane.js)
// ──────────────────────────────────────────────

/**
 * Route an incoming python-* WebSocket message to the correct per-job callback.
 * Must be called from the main ws.onmessage handler.
 */
export function handlePythonMessage(message) {
  const { type, jobId } = message;
  const cb = jobCallbacks.get(jobId) || {};

  switch (type) {
    case 'python-output':
      if (cb.onOutput) cb.onOutput(message.data, message.stream);
      break;

    case 'python-done':
      if (cb.onDone) cb.onDone(message.exitCode, message.outputDir);
      jobCallbacks.delete(jobId);
      break;

    case 'python-error':
      if (cb.onError) cb.onError(message.error);
      jobCallbacks.delete(jobId);
      break;

    case 'python-batch-file-start':
      if (cb.onFileStart) cb.onFileStart(message.fileName, message.fileIndex, message.totalFiles);
      break;

    case 'python-batch-file-complete':
      if (cb.onFileComplete) cb.onFileComplete(message.fileName, message.fileIndex, message.totalFiles, message.exitCode);
      break;

    case 'python-batch-complete':
      if (cb.onDone) cb.onDone(message.successCount, message.totalFiles, message.outputDir);
      jobCallbacks.delete(jobId);
      break;
  }
}

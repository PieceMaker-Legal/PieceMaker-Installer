/** Enregistre le pont MCP Word dans les clients locaux, sans modifier leurs
 * autres serveurs. Les CLI réalisent elles-mêmes l'écriture de leur format de
 * configuration, ce qui évite de réécrire config.toml/settings JSON à la main.
 */

import path from 'node:path';
import { commandExists, runCapture } from './platform.mjs';

export const WORD_MCP_NAME = 'piecemaker-word';

function clientDefinition(repoRoot, name) {
  const server = path.join(repoRoot, 'mcp-server', 'mcp-server-local.js');
  if (name === 'codex') {
    return { probe: ['mcp', 'get', WORD_MCP_NAME, '--json'], add: ['mcp', 'add', WORD_MCP_NAME, '--', process.execPath, server] };
  }
  return { probe: ['mcp', 'get', WORD_MCP_NAME], add: ['mcp', 'add', '--scope', 'user', WORD_MCP_NAME, '--', process.execPath, server] };
}

export function wordMcpClientStatus(repoRoot, name, ops = {}) {
  const exists = ops.commandExists || commandExists;
  const capture = ops.runCapture || runCapture;
  if (!exists(name, ['--version'])) return { name, available: false, configured: false };
  const definition = clientDefinition(repoRoot, name);
  const result = capture(name, definition.probe);
  return { name, available: true, configured: result.code === 0 && !result.error };
}

export function registerWordMcpClients(repoRoot, ops = {}) {
  const capture = ops.runCapture || runCapture;
  return ['codex', 'claude'].map((name) => {
    const status = wordMcpClientStatus(repoRoot, name, ops);
    if (!status.available || status.configured) return status;
    const result = capture(name, clientDefinition(repoRoot, name).add);
    return { ...status, configured: result.code === 0 && !result.error, error: result.stderr || result.stdout || '' };
  });
}

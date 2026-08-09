const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Dossiers est le premier onglet et Vue d’ensemble est intégrée aux paramètres', () => {
  const html = read('admin/index.html');
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] || '';
  const settings = html.match(/<section id="settings"[\s\S]*?<form id="settingsForm">/)?.[0] || '';

  assert.match(nav, /<button class="tab active" data-tab="history">Dossiers<\/button>/);
  assert.ok(nav.indexOf('Dossiers') < nav.indexOf('Paramètres'));
  assert.doesNotMatch(nav, /Vue d’ensemble|dashboard/);
  assert.doesNotMatch(html, /id="dashboard"/);
  for (const id of ['version', 'wordStatus', 'certStatus', 'assetCount', 'repoRoot']) {
    assert.match(settings, new RegExp(`id="${id}"`));
  }
});

test('le diff est produit uniquement après un clic et rendu sans milliers de nœuds', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  assert.doesNotMatch(html, /changed-file-list|revisionFiles|revisionFileCount/);
  assert.doesNotMatch(app, /revisionFiles|revisionFileCount|changed-file-row/);
  assert.doesNotMatch(css, /changed-file-list|changed-file-row|changed-files-pane/);
  assert.match(app, /loadRevision\(item\.hash\)/);
  assert.doesNotMatch(app, /loadRevision\(historyItems\[0\]\.hash\)/);
  assert.doesNotMatch(app, /loadRevision\('WORKTREE', selectedChange/);
  assert.match(app, /container\.textContent = patch/);
  assert.doesNotMatch(css, /\.diff-line/);
  assert.doesNotMatch(app, /REPOSITORY_REFRESH_MS|scheduleRepositoryRefresh/);
});

test('le MCP local ne charge ni ne relaie aucun MCP distant', () => {
  const sources = [
    'mcp-server/mcp-server-local.js',
    'piecemaker-plugin/mcp/legifrance/mcp_stdio_server.py',
    'piecemaker-plugin/mcp/legifrance/config/mcp_definitions.py',
    'piecemaker-plugin/mcp/legifrance/config/settings.py',
    'piecemaker-plugin/mcp/legifrance/tools/handlers.py',
  ].map(read).join('\n');

  assert.match(sources, /tools: LOCAL_TOOLS/);
  assert.doesNotMatch(sources, /MCP_REMOTE|MCP_URL|mcpRemote|api\/mcp-config|MCP SERVEUR REMOTE|serveur distant/i);
  assert.doesNotMatch(read('admin/index.html'), /MCP distante|MCP_REMOTE_URL|MCP_API_KEY/i);
  assert.doesNotMatch(read('admin/app.js'), /mcpRemoteUrl|MCP_REMOTE_URL|MCP_API_KEY/);
});

test('l’administration journalise les tâches longues et les temps serveur', () => {
  const app = read('admin/app.js');
  const routes = read('websocket-server/admin-routes.cjs');
  const commits = read('piecemaker-plugin/scripts/lib/commits.cjs');

  assert.match(app, /PerformanceObserver\.supportedEntryTypes\?\.includes\('longtask'\)/);
  assert.match(app, /response\.headers\.get\('Server-Timing'\)/);
  assert.match(routes, /res\.set\('Server-Timing'/);
  assert.match(routes, /router\.get\('\/repository\/case'/);
  assert.match(commits, /\[PM-PERF\]/);
  assert.match(commits, /logPerformance\('buildCurrentTree'/);
  assert.match(commits, /logPerformance\('revisionDetails'/);
});

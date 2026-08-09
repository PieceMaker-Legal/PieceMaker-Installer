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

test('le commit manuel est un formulaire titré en bas des modifications', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const historyColumn = html.match(/<aside class="history-column">[\s\S]*?<\/aside>/)?.[0] || '';

  assert.match(historyColumn, /id="historyList"[\s\S]*id="manualCommitForm"/);
  assert.match(historyColumn, /id="commitTitle"[^>]*required/);
  assert.match(historyColumn, /id="commitDescription"/);
  assert.match(app, /JSON\.stringify\(\{ label, description, case: selectedFolder \}\)/);
  assert.doesNotMatch(app, /prompt\('Message du commit'/);
});

test('la vue Dossiers suit le bureau Git avec trois onglets et des détails intégrés', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const switcher = html.match(/<div class="history-switch"[\s\S]*?<\/div>/)?.[0] || '';

  assert.ok(switcher.indexOf('Modifications') < switcher.indexOf('Historique'));
  assert.ok(switcher.indexOf('Historique') < switcher.indexOf('Pièces protégées'));
  assert.match(switcher, /id="changesView" class="active"/);
  for (const id of ['caseSelect', 'openCreateCase', 'branchSelect', 'openCreateBranch', 'refreshHistory', 'caseTelegramCard']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="mappingView" class="inline-detail"/);
  assert.match(html, /id="telegramCaseView" class="inline-detail/);
  assert.doesNotMatch(html, /id="mappingDialog"|Restaurer cet état/);
  assert.doesNotMatch(app, /showModal\(\).*mapping|restoreSelectedRevision|restoreRevision/);
  assert.match(app, /a\.protected !== b\.protected/);
  assert.match(app, /\/api\/admin\/repository\/cases/);
  assert.match(app, /\/api\/admin\/branches\/current/);
  assert.match(app, /\/api\/admin\/telegram\/dossiers/);
});

test('les écritures automatiques déclarent des commits limités à leurs chemins', () => {
  const routes = read('websocket-server/admin-routes.cjs');
  const pipeline = read('websocket-server/originals-pipeline.cjs');
  const hook = read('piecemaker-plugin/scripts/commit-track.mjs');

  assert.match(hook, /paths: \[located\.relative\]/);
  assert.match(pipeline, /sessionArtifactPaths/);
  assert.match(pipeline, /paths,/);
  assert.match(routes, /admin-mapping-edit/);
  assert.match(routes, /admin-mapping-rebuild/);
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

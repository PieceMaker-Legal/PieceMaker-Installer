const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Dossiers est le premier onglet ; Paramètres et Telegram sont regroupés dans la Configuration', () => {
  const html = read('admin/index.html');
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] || '';
  const settings = html.match(/<section id="settings"[\s\S]*?<form id="settingsForm">/)?.[0] || '';

  assert.match(nav, /<button class="tab active" data-tab="history">Dossiers<\/button>/);
  // Les onglets Paramètres et Telegram ont disparu de la barre : tout passe par Configuration.
  assert.doesNotMatch(nav, /data-tab="settings"/);
  assert.doesNotMatch(nav, /data-tab="telegram"/);
  assert.doesNotMatch(nav, /Vue d’ensemble|dashboard/);
  assert.doesNotMatch(html, /id="dashboard"/);
  // Le contenu Paramètres subsiste (déplacé dans la fenêtre) avec ses métriques.
  for (const id of ['version', 'wordStatus', 'certStatus', 'assetCount', 'repoRoot']) {
    assert.match(settings, new RegExp(`id="${id}"`));
  }
  // Groupes déplaçables dans la fenêtre de configuration.
  for (const id of ['settingsConfigurationGroup', 'telegramConfigurationGroup', 'institutionalTermsCard']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('Configuration montre le flux d’anonymisation, les moteurs locaux et héberge Paramètres/Telegram', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');
  const routes = read('websocket-server/admin-routes.cjs');
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/)?.[0] || '';
  const configuration = html.match(/<section id="configuration"[\s\S]*?<section id="settings"/)?.[0] || '';

  assert.match(nav, /data-tab="configuration">Configuration/);
  for (const component of ['client', 'terminal', 'hooks', 'mcp', 'telegram', 'gliner', 'mineru', 'ollama', 'docs']) {
    assert.match(configuration, new RegExp(`data-config-component="${component}"`));
  }
  // Le rôle des hooks à la lecture / à l’écriture est explicité dans le schéma.
  assert.match(configuration, /cfg-transform-row read/);
  assert.match(configuration, /cfg-transform-row write/);
  for (const id of [
    'configurationModelList', 'configurationFolderList', 'configurationDetail',
    'configurationDetailTitle', 'refreshConfiguration',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /api\('\/api\/admin\/configuration'\)/);
  assert.match(app, /\/api\/admin\/configuration\/models\/check/);
  assert.match(app, /openConfigurationDetail\('folder'/);
  assert.match(app, /detail\.showModal\(\)/);
  // Paramètres, Telegram et termes institutionnels sont montés dans la fenêtre.
  assert.match(app, /mountConfigurationForm\('settingsConfigurationGroup'/);
  assert.match(app, /mountConfigurationForm\('telegramConfigurationGroup'/);
  assert.match(app, /mountConfigurationForm\('institutionalTermsCard'/);
  // Le serveur détecte GLiNER, MinerU et Telegram parmi les composants.
  for (const component of ['gliner', 'mineru', 'telegram']) {
    assert.match(routes, new RegExp(`${component}: \\{`));
  }
  assert.match(css, /\.configuration-map/);
  assert.match(css, /\.configuration-dialog/);
  assert.match(css, /\.cfg-boundary/);
  assert.doesNotMatch(html, /configurationDrawer|configuration-drawer|configurationDrawerBackdrop/);
  assert.doesNotMatch(css, /\.configuration-drawer|\.configuration-drawer-backdrop/);
});

test('les paramètres permettent de modifier le nom appliqué à chaque commit', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const saveSettings = app.match(/async function saveSettings\(event\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(html, /id="commitUserName"[^>]*name="PIECEMAKER_USER_NAME"[^>]*required/);
  assert.match(html, /Identité des tâches/);
  assert.match(app, /data\.env\.PIECEMAKER_USER_NAME/);
  assert.match(app, /form\.get\('PIECEMAKER_USER_NAME'\)/);
  assert.match(saveSettings, /const formElement = event\.currentTarget/);
  assert.doesNotMatch(saveSettings, /await[\s\S]*event\.currentTarget/);
  assert.doesNotMatch(html, /PIECEMAKER_USER_EMAIL/);
  assert.doesNotMatch(app, /PIECEMAKER_USER_EMAIL/);
});

test('les formulaires asynchrones conservent leur cible après la propagation de l\'événement', () => {
  const app = read('admin/app.js');

  for (const functionName of ['saveSettings', 'saveTelegram']) {
    const handler = app.match(new RegExp(`async function ${functionName}\\(event\\) \\{[\\s\\S]*?\\n\\}`))?.[0] || '';
    assert.match(handler, /const formElement = event\.currentTarget/);
    assert.doesNotMatch(handler, /await[\s\S]*event\.currentTarget/);
  }
});

test('un commit liste ses fichiers puis ne calcule que le diff sélectionné', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  for (const id of ['changedFilesPane', 'revisionFiles', 'revisionFileCount']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /renderRevisionFiles\(revision\.files, hash, revision\.selectedPath\)/);
  assert.match(app, /button\.addEventListener\('click', \(\) => loadRevision\(hash, file\.path\)\)/);
  assert.match(app, /const REVISION_FILE_BATCH = 250/);
  assert.match(css, /\.changed-file-list/);
  assert.match(css, /\.changed-file-row\.active/);
  assert.match(app, /loadRevision\(item\.hash\)/);
  assert.doesNotMatch(app, /loadRevision\(historyItems\[0\]\.hash\)/);
  assert.doesNotMatch(app, /loadRevision\('WORKTREE', selectedChange/);
  assert.doesNotMatch(css, /\.diff-line/);
  assert.match(app, /line\.startsWith\('\+'\)/);
  assert.match(app, /line\.startsWith\('-'\)/);
  assert.match(app, /renderDiffSegments\(container, patch\)/);
  assert.match(css, /\.diff-segment\.addition[^}]*\{[^}]*#dafbe1[^}]*#116329/);
  assert.match(css, /\.diff-segment\.deletion[^}]*\{[^}]*#ffebe9[^}]*#82071e/);
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
  assert.match(switcher, /id="changesView" class="active"[^>]*>Modifications \(0\)<\/button>/);
  assert.doesNotMatch(html, /id="historyTitle"/);
  assert.doesNotMatch(app, /historyTitle/);
  assert.match(app, /byId\('changesView'\)\.textContent = `Modifications \(\$\{changes\.length\}\)`/);
  for (const id of ['caseSelect', 'openCreateCase', 'branchSelect', 'openCreateBranch', 'refreshHistory', 'caseTelegramCard']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="mappingView" class="inline-detail"/);
  for (const id of ['openProcedureParties', 'procedureClientSummary', 'procedureAdverseSummary', 'procedurePartiesDialog', 'clientParties', 'adverseParties']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /applyProcedureParties/);
  assert.match(app, /CLIENT|procedureSummary/);
  assert.match(html, /id="telegramCaseView" class="inline-detail/);
  assert.doesNotMatch(html, /id="mappingDialog"|Restaurer cet état/);
  assert.doesNotMatch(app, /showModal\(\).*mapping|restoreSelectedRevision|restoreRevision/);
  assert.match(app, /a\.protected !== b\.protected/);
  assert.match(app, /\/api\/admin\/repository\/cases/);
  assert.match(app, /\/api\/admin\/branches\/current/);
  assert.match(app, /\/api\/admin\/telegram\/dossiers/);
});

test('la liste des pièces affiche les états converti, anonymisé et protégé', () => {
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  assert.match(app, /if \(original\.converted\) badges\.append\(originalStatusBadge\('converted', 'Converti'\)\)/);
  assert.match(app, /if \(original\.scanned\) badges\.append\(originalStatusBadge\('scanned', 'Anonymisé'\)\)/);
  assert.match(app, /controls\.append\(checkbox, shieldButton\(original\)\)/);
  assert.match(css, /\.protection-badge\.converted/);
  assert.match(css, /\.protection-badge\.scanned/);
});

test('les trois outils des pièces protégées partagent le volet de révision sans titres redondants', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');
  const historyColumn = html.match(/<aside class="history-column">[\s\S]*?<\/aside>/)?.[0] || '';
  const revisionColumn = html.match(/<section class="revision-column">[\s\S]*?<\/section>/)?.[0] || '';

  const originalsIndex = historyColumn.indexOf('data-protected-detail="originals"');
  const mappingIndex = historyColumn.indexOf('data-protected-detail="mapping"');
  const chronologyIndex = historyColumn.indexOf('data-protected-detail="chronology"');
  assert.ok(originalsIndex >= 0 && originalsIndex < mappingIndex && mappingIndex < chronologyIndex);
  assert.doesNotMatch(historyColumn, /id="originalMosaic"/);
  for (const id of ['originalsView', 'originalMosaic', 'mappingView', 'chronologyPane']) {
    assert.match(revisionColumn, new RegExp(`id="${id}"`));
  }
  assert.match(app, /byId\('originalsView'\)\.hidden = view !== 'originals'/);
  assert.match(css, /\.revision-column\.protected-detail-mode \.revision-header \{ display: none; \}/);
  assert.match(css, /\.original-mosaic \{[^}]*grid-template-columns: repeat\(2,/);
  assert.match(css, /\.original-mosaic-column\.accessible/);
  assert.match(css, /\.original-mosaic-column\.protected/);
});

test('le graphe des liens masque complètement la frise chronologique', () => {
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  assert.match(app, /timeline\.hidden = wantGraph;/);
  assert.match(app, /graph\.hidden = !wantGraph;/);
  assert.match(css, /\.chronology-timeline\[hidden\], \.chronology-graph\[hidden\] \{ display: none; \}/);
});

test('la chronologie embarque le visualiseur officiel Graphify dans une iframe isolée', () => {
  const app = read('admin/app.js');
  const css = read('admin/styles.css');
  const routes = read('websocket-server/admin-routes.cjs');
  const server = read('websocket-server/server.cjs');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(css, /\.chronology-timeline\[hidden\], \.chronology-graph\[hidden\] \{ display: none; \}/);
  assert.match(app, /const graphData = data\.graph \|\| \{\}/);
  assert.match(app, /Visualiseur officiel Graphify · résultats GLiNER locaux · sans LLM \(0 token\)/);
  assert.match(app, /frame\.setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.match(app, /frame\.srcdoc = graphData\.viewerHtml/);
  assert.doesNotMatch(app, /chronology-svg|function svgHeader|function svg\(/);
  assert.match(css, /\.graphify-viewer-frame/);
  assert.match(routes, /buildGraphifyDocumentGraph\(legalCase\.root, chronology\)/);
  assert.match(server, /\/admin\/vendor\/vis-network\.min\.js/);
  assert.equal(packageJson.dependencies['vis-network'], '9.1.13');
});

test('l’administration reste claire, tient dans le viewport et conserve les dossiers visibles', () => {
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  assert.match(css, /html, body \{ height: 100%; min-height: 0; \}/);
  assert.match(css, /body \{[^}]*overflow: hidden;[^}]*background: var\(--paper\)/);
  assert.match(css, /\.shell \{[^}]*height: 100dvh;[^}]*overflow: hidden/);
  assert.match(css, /\.panel \{[^}]*height: 100%;[^}]*overflow: auto/);
  assert.match(css, /#history\.panel \{ overflow: hidden; \}/);
  assert.match(css, /#history \.desktop-card \{[^}]*background: #fff/);
  assert.match(css, /#history \.repository-toolbar \{[^}]*background: var\(--brand\);[^}]*color: #fff/);
  assert.match(css, /#history \.toolbar-select-row select option \{ background: #fff; color: #24292f; \}/);
  assert.match(css, /\.revision-content\.has-file-list \{ grid-template-columns:/);
  assert.match(css, /\.changed-file-list \{[^}]*overflow: auto/);
  assert.match(app, /for \(const folder of folders\)[\s\S]*select\.append\(option\);[\s\S]*select\.value = selectedFolder;/);
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

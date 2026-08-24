const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('l’administration expose un manifeste PWA limité à /admin/', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const manifest = JSON.parse(read('admin/manifest.webmanifest'));
  const serviceWorker = read('admin/service-worker.js');
  const offline = read('admin/offline.html');

  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.doesNotMatch(html, /href="\/taskpane\.html"/);
  assert.equal(manifest.id, '/admin/');
  assert.equal(manifest.start_url, '/admin/');
  assert.equal(manifest.scope, '/admin/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) {
    const image = fs.readFileSync(path.join(root, 'admin', icon.src));
    const expectedSize = Number.parseInt(icon.sizes, 10);
    assert.equal(image.subarray(1, 4).toString(), 'PNG', `${icon.src} doit être un PNG`);
    assert.equal(image.readUInt32BE(16), expectedSize, `${icon.src} doit avoir la largeur déclarée`);
    assert.equal(image.readUInt32BE(20), expectedSize, `${icon.src} doit avoir la hauteur déclarée`);
  }
  assert.match(app, /navigator\.serviceWorker\.register\('service-worker\.js', \{ scope: '\.\/' \}\)/);
  assert.match(serviceWorker, /event\.request\.mode === 'navigate'/);
  assert.match(serviceWorker, /name\.startsWith\(CACHE_PREFIX\)/);
  assert.doesNotMatch(serviceWorker, /\/api\/admin/);
  assert.match(offline, /href="piecemaker:\/\/start"/);
  assert.match(offline, /piecemaker start/);
});

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

test('le mode sombre se configure, s’applique immédiatement et persiste côté serveur', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');
  const routes = read('websocket-server/admin-routes.cjs');

  assert.match(html, /id="adminDarkMode"[^>]*type="checkbox"[^>]*role="switch"/);
  assert.match(html, /localStorage\.getItem\('piecemaker-admin-theme'\)/);
  assert.match(app, /document\.documentElement\.dataset\.theme = theme/);
  assert.match(app, /config: \{ adminTheme: theme \}/);
  assert.match(app, /data\.config\.adminTheme/);
  assert.match(css, /html\[data-theme="dark"\] \{/);
  assert.match(css, /color-scheme: dark/);
  assert.match(routes, /adminTheme: 'light'/);
  assert.match(routes, /next\.adminTheme = validateAdminTheme\(patch\.adminTheme\)/);
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
  // Les pièces sont affichées dans un ordre stable ; leur état d’accès est
  // rendu ensuite dans les trois colonnes de la mosaïque.
  assert.match(app, /visibleOriginals\(\)\.slice\(\)\.sort\(\(a, b\) => a\.path\.localeCompare\(b\.path, 'fr'\)\)/);
  assert.match(app, /for \(const group of PIECE_STATES\)/);
  assert.match(app, /\/api\/admin\/repository\/cases/);
  assert.match(app, /\/api\/admin\/branches\/current/);
  assert.match(app, /\/api\/admin\/telegram\/dossiers/);
});

test('la liste des pièces expose les trois états d’accès et le traitement associé', () => {
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  for (const state of ['vault', 'workspace', 'resource']) {
    assert.match(app, new RegExp(`key: '${state}'`));
  }
  assert.match(app, /function pieceState\(original\) \{[\s\S]*if \(original\.resource\) return 'resource';[\s\S]*return original\.protected \? 'vault' : 'workspace';[\s\S]*\}/);
  assert.match(app, /function stateSelector\(original\)/);
  assert.match(app, /controls\.append\(checkbox, stateSelector\(original\)\)/);
  // Une ressource ne peut pas être envoyée au pipeline de conversion/analyse.
  assert.match(app, /const selectable = known\.has\(original\.path\) && !isResource/);
  assert.match(app, /if \(!isResource && original\.converted\) badges\.append\(originalStatusBadge\('converted', 'Converti'\)\)/);
  assert.match(app, /if \(!isResource && original\.scanned\) badges\.append\(originalStatusBadge\('scanned', 'Anonymisé'\)\)/);
  assert.match(css, /\.protection-badge\.converted/);
  assert.match(css, /\.protection-badge\.scanned/);
  for (const stateClass of ['protected', 'accessible', 'resource']) {
    assert.match(css, new RegExp(`\\.state-option\\.active\\.${stateClass}`));
  }
});

test('les trois outils des pièces protégées partagent le volet de révision et la mosaïque à trois états', () => {
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
  assert.match(css, /\.original-mosaic \{[^}]*grid-template-columns: repeat\(3,/);
  assert.match(css, /\.original-mosaic-column\.accessible/);
  assert.match(css, /\.original-mosaic-column\.protected/);
  assert.match(css, /\.original-mosaic-column\.resource/);
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

test('la barre des fichiers enveloppe les libellés sans masquer ses boutons', () => {
  const css = read('admin/styles.css');

  assert.doesNotMatch(css, /#files\.panel \{ overflow: hidden; \}/);
  assert.match(css, /\.editor-layout \{[^}]*min-height: 650px;[^}]*grid-template-columns: minmax\(0, 280px\)/);
  assert.match(css, /\.file-sidebar \{[^}]*min-width: 0;[^}]*overflow: hidden/);
  assert.match(css, /\.file-list \{[^}]*width: 100%;[^}]*min-width: 0/);
  assert.doesNotMatch(css, /\.editor-pane \{[^}]*overflow: hidden/);
  assert.match(css, /\.visual-editor \{ min-height: 500px;[^}]*overflow: auto/);
  assert.match(css, /\.file-button-label \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.file-asset-name \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.file-group-add \{ flex: none;/);
  assert.match(css, /\.file-row-delete \{ flex: none;/);
  assert.match(css, /\.file-asset-delete \{ flex: none;/);
  assert.match(css, /@media \(max-width: 800px\) \{[\s\S]*\.editor-layout \{ grid-template-columns: 1fr; \}/);
});

test('l’éditeur Markdown permet de configurer puis insérer un tableau', () => {
  const html = read('admin/index.html');
  const app = read('admin/app.js');
  const css = read('admin/styles.css');

  assert.match(html, /id="insertTableBtn"[^>]*data-command="insertTable"/);
  assert.match(html, /id="insertTableDialog"[\s\S]*name="columns"[\s\S]*name="rows"/);
  assert.match(app, /function editorTableHtml\(rows, columns\)/);
  assert.match(app, /<table><thead><tr>\$\{heading\}<\/tr><\/thead><tbody>\$\{body\}<\/tbody><\/table>/);
  assert.match(app, /insertHtmlIntoEditor\(editorTableHtml\(rows, columns\)\)/);
  assert.match(css, /\.visual-editor table \{[^}]*max-width: 100%;[^}]*table-layout: fixed/);
  assert.match(css, /\.visual-editor th, \.visual-editor td \{[^}]*overflow-wrap: anywhere/);
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

  assert.match(sources, /tools: ENABLED_TOOLS/);
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

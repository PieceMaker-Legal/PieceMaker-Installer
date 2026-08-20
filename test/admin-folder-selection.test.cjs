const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  folderPickerCommands,
  registerLegalCase,
} = require('../websocket-server/admin-routes.cjs');
const {
  listConfiguredCases,
  readRegistryConfig,
  resolveCaseReference,
} = require('../websocket-server/case-registry.cjs');
const {
  locateConfiguredCase,
  registeredCaseFolders,
} = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');

const projectRoot = path.resolve(__dirname, '..');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-folder-select-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const selected = path.join(root, 'clients', 'Dossier Martin');
  fs.mkdirSync(path.join(repo, 'installer', 'templates'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(selected, { recursive: true });
  fs.copyFileSync(
    path.join(projectRoot, 'installer', 'templates', 'workspace-CLAUDE.md'),
    path.join(repo, 'installer', 'templates', 'workspace-CLAUDE.md'),
  );
  fs.writeFileSync(path.join(repo, '.env'), 'PIECEMAKER_USER_NAME=Alice Martin\n');
  fs.writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({
    anonymization: { enabled: true, watchPaths: [] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(selected, 'piece.pdf'), 'original');
  return { root, repo, home, selected };
}

test('le bouton admin sélectionne un dossier existant et ne propose plus de le créer', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'admin', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(projectRoot, 'admin', 'app.js'), 'utf8');
  const routes = fs.readFileSync(path.join(projectRoot, 'websocket-server', 'admin-routes.cjs'), 'utf8');
  assert.match(html, /id="openCreateCase"[^>]*Sélectionner un dossier existant/);
  assert.doesNotMatch(html, /id="createCaseDialog"|id="newCaseName"|Créer le dossier/);
  assert.match(app, /openCreateCase'\)\.addEventListener\('click', selectAndRegisterCase\)/);
  assert.match(app, /body: '\{\}'/);
  assert.doesNotMatch(app, /createCaseFromForm|newCaseName/);
  assert.doesNotMatch(routes, /'plugin', 'install', 'piecemaker@piecemaker'/);
  assert.match(routes, /syncClaudeAssets\(repoRoot, userHome\)/);
});

test('les sélecteurs natifs n’autorisent que des dossiers existants', () => {
  const mac = folderPickerCommands('darwin', '/tmp')[0];
  assert.equal(mac.command, 'osascript');
  assert.ok(mac.args.includes('set selectedFolder to choose folder with prompt "Choisir un dossier juridique PieceMaker" default location initialFolder'));

  const windows = folderPickerCommands('win32', 'C:\\Users\\Alice')[0];
  assert.equal(windows.command, 'powershell.exe');
  assert.match(windows.args.join(' '), /ShowNewFolderButton = \$false/);

  assert.deepEqual(folderPickerCommands('linux', '/tmp').map((entry) => entry.command), ['zenity', 'kdialog']);
  assert.deepEqual(registeredCaseFolders({ caseFolders: ['', 'chemin/relatif'] }), []);
});

test('un dossier extérieur est enregistré et réutilise les composants Claude globaux', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const installedFrom = [];

  const result = await registerLegalCase({
    folder: data.selected,
    configFile: path.join(data.home, 'config.json'),
    repoRoot: data.repo,
    homeDir: data.home,
    userHome: data.home,
    claudeAssetsInstaller: async (repoRoot, userHome) => {
      installedFrom.push([repoRoot, userHome]);
      return { installed: true };
    },
  });

  assert.deepEqual(installedFrom, [[data.repo, data.home]]);
  assert.equal(result.installed.claudeAssets, true);
  assert.match(result.folder.path, /^folder-[a-f0-9]{20}$/);
  assert.equal(result.folder.location, fs.realpathSync(data.selected));
  assert.equal(fs.readFileSync(path.join(data.selected, 'piece.pdf'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(data.selected, result.installed.mapping)), true);
  assert.equal(fs.existsSync(path.join(data.selected, '.piecemaker', 'protection.json')), true);
  const rule = fs.readFileSync(path.join(data.selected, '.claude', 'rules', 'piecemaker.md'), 'utf8');
  assert.match(rule, /dossier juridique actif/);
  assert.match(rule, /caseFolders/);
  assert.doesNotMatch(rule, /Chaque sous-dossier immédiat/);

  const config = readRegistryConfig(path.join(data.home, 'config.json'));
  assert.deepEqual(config.caseFolders, [fs.realpathSync(data.selected)]);
  assert.deepEqual(new Set(config.anonymization.watchPaths), new Set([
    fs.realpathSync(data.selected),
  ]));
  const entries = listConfiguredCases(config);
  assert.equal(entries.some((entry) => entry.root === fs.realpathSync(data.selected)), true);
  assert.equal(resolveCaseReference(config, result.folder.path).root, fs.realpathSync(data.selected));
  assert.equal(locateConfiguredCase(config, path.join(data.selected, 'piece.pdf')).caseRoot, fs.realpathSync(data.selected));
});

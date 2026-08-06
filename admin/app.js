const api = async (url, options = {}) => {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
  return data;
};

const byId = (id) => document.getElementById(id);
let selectedFile = null;
let originalContent = '';
let filesLoaded = false;
let historyLoaded = false;
let repositoryData = null;
let historyItems = [];
let selectedFolder = '';
let historyView = 'commits';
let selectedRevision = null;

function toast(message) {
  const element = byId('toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 2800);
}

function setMessage(element, message = '', kind = '') {
  element.textContent = message;
  element.className = `message ${kind}`.trim();
}

function setActiveTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === name));
  if (name === 'settings') loadSettings();
  if (name === 'files' && !filesLoaded) loadFiles();
  if (name === 'history' && !historyLoaded) loadRepositoryHistory();
}

async function loadStatus() {
  const badge = byId('serverBadge');
  try {
    const status = await api('/api/admin/status');
    badge.textContent = '● Serveur local actif';
    badge.className = 'status-pill ok';
    byId('version').textContent = status.version;
    byId('wordStatus').textContent = status.wordClients > 0 ? `Oui (${status.wordClients})` : 'Non';
    byId('certStatus').textContent = status.certificatesReady ? 'Prêts' : 'À installer';
    byId('assetCount').textContent = `${status.files.skills} / ${status.files.agents}`;
    byId('repoRoot').textContent = status.repoRoot;
  } catch (error) {
    badge.textContent = 'Serveur indisponible';
    badge.className = 'status-pill error';
    toast(error.message);
  }
}

async function loadSettings() {
  const message = byId('settingsMessage');
  setMessage(message, 'Chargement…');
  try {
    const data = await api('/api/admin/settings');
    byId('outputPath').value = data.config.outputPath || '';
    byId('port').value = data.config.port || 43098;
    byId('pythonPath').value = data.config.pythonPath || data.env.PYTHON_PATH || '';
    byId('mcpRemoteUrl').value = data.env.MCP_REMOTE_URL || data.env.MCP_URL || '';
    byId('legifranceEnv').value = 'production';
    document.querySelectorAll('[data-secret-state]').forEach((element) => {
      const state = data.secrets[element.dataset.secretState];
      element.textContent = state?.configured ? `Déjà configurée (${state.hint})` : 'Non configurée';
    });
    setMessage(message);
  } catch (error) {
    setMessage(message, error.message, 'error');
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const message = byId('settingsMessage');
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(message, 'Enregistrement…');
  const form = new FormData(event.currentTarget);
  const env = {};
  for (const key of ['MCP_API_KEY', 'LEGIFRANCE_CLIENT_ID', 'LEGIFRANCE_CLIENT_SECRET']) {
    const value = String(form.get(key) || '').trim();
    if (value) env[key] = value;
  }
  env.MCP_REMOTE_URL = String(form.get('MCP_REMOTE_URL') || '').trim();
  env.LEGIFRANCE_ENV = 'production';

  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          outputPath: form.get('outputPath'),
          port: Number(form.get('port')),
          pythonPath: form.get('pythonPath'),
        },
        env,
      }),
    });
    event.currentTarget.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
    await loadSettings();
    setMessage(message, 'Enregistré. Redémarrez le serveur pour appliquer les changements.', 'success');
    toast('Paramètres enregistrés');
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function fileGroupLabel(kind) {
  return { instructions: 'Instructions', skill: 'Skills', agent: 'Agents' }[kind] || kind;
}

async function loadFiles() {
  const list = byId('fileList');
  list.textContent = 'Chargement…';
  try {
    const { files } = await api('/api/admin/files');
    list.textContent = '';
    for (const kind of ['instructions', 'skill', 'agent']) {
      const groupFiles = files.filter((file) => file.kind === kind);
      if (!groupFiles.length) continue;
      const heading = document.createElement('div');
      heading.className = 'file-group';
      heading.textContent = fileGroupLabel(kind);
      list.append(heading);
      for (const file of groupFiles) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `file-button${file.exists ? '' : ' missing'}`;
        button.textContent = file.exists ? file.name : `${file.name} — créer`;
        button.dataset.path = file.path;
        button.addEventListener('click', () => selectFile(file, button));
        list.append(button);
      }
    }
    filesLoaded = true;
  } catch (error) {
    list.textContent = error.message;
  }
}

async function selectFile(file, button) {
  const editor = byId('fileEditor');
  if (selectedFile && editor.value !== originalContent && !confirm('Abandonner les modifications non enregistrées ?')) return;
  document.querySelectorAll('.file-button').forEach((item) => item.classList.toggle('active', item === button));
  setMessage(byId('fileMessage'), 'Chargement…');
  try {
    const data = await api(`/api/admin/file?path=${encodeURIComponent(file.path)}`);
    selectedFile = data;
    originalContent = data.content;
    editor.value = data.content;
    editor.disabled = false;
    byId('saveFile').disabled = false;
    byId('fileTitle').textContent = file.name;
    byId('filePath').textContent = file.path;
    byId('dirtyBadge').hidden = true;
    setMessage(byId('fileMessage'), data.exists ? '' : 'Ce fichier sera créé lors de l’enregistrement.');
  } catch (error) {
    setMessage(byId('fileMessage'), error.message, 'error');
  }
}

async function saveFile() {
  if (!selectedFile) return;
  const button = byId('saveFile');
  const editor = byId('fileEditor');
  button.disabled = true;
  setMessage(byId('fileMessage'), 'Enregistrement…');
  try {
    const result = await api('/api/admin/file', {
      method: 'PUT',
      body: JSON.stringify({ path: selectedFile.path, content: editor.value }),
    });
    originalContent = editor.value.endsWith('\n') ? editor.value : `${editor.value}\n`;
    editor.value = originalContent;
    byId('dirtyBadge').hidden = true;
    setMessage(byId('fileMessage'), result.backup ? 'Enregistré avec sauvegarde.' : 'Fichier créé.', 'success');
    toast('Fichier Markdown enregistré');
  } catch (error) {
    setMessage(byId('fileMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function formatRelativeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'date inconnue';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, 'day');
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function statusLetter(change) {
  if (change.kind === 'added') return 'A';
  if (change.kind === 'deleted') return 'D';
  if (change.kind === 'renamed') return 'R';
  return 'M';
}

function currentCase() {
  return repositoryData?.folders?.find((folder) => folder.path === selectedFolder) || null;
}

function createHistoryEmpty(message, detail = '') {
  const empty = document.createElement('div');
  empty.className = 'history-empty';
  const strong = document.createElement('strong');
  strong.textContent = message;
  empty.append(strong);
  if (detail) {
    const paragraph = document.createElement('p');
    paragraph.textContent = detail;
    empty.append(paragraph);
  }
  return empty;
}

function renderFolders() {
  const list = byId('folderList');
  list.textContent = '';
  byId('folderCount').textContent = String(repositoryData.folders.length);

  for (const folder of repositoryData.folders) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `folder-row${selectedFolder === folder.path ? ' active' : ''}`;
    button.dataset.folder = folder.path;
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '▸';
    const label = document.createElement('span');
    label.textContent = folder.name;
    const count = document.createElement('span');
    count.className = 'row-count';
    count.textContent = folder.changes || '';
    button.append(icon, label, count);
    button.addEventListener('click', () => selectHistoryFolder(folder.path));
    list.append(button);
  }
  renderOriginals();
}

function renderOriginals() {
  const list = byId('originalList');
  const originals = currentCase()?.originals || [];
  list.textContent = '';
  byId('originalCount').textContent = String(originals.length);
  if (!selectedFolder) {
    list.append(createHistoryEmpty('Sélectionnez un dossier'));
    return;
  }
  if (!originals.length) {
    list.append(createHistoryEmpty('Aucune pièce originale'));
    return;
  }
  for (const original of originals) {
    const row = document.createElement('div');
    row.className = 'original-row';
    const body = document.createElement('span');
    body.className = 'original-body';
    const name = document.createElement('strong');
    name.textContent = original.path;
    const detail = document.createElement('span');
    detail.textContent = original.converted
      ? (original.scanned ? 'Markdown généré · GLiNER validé' : 'Markdown généré · scan GLiNER manquant')
      : 'Markdown non généré';
    body.append(name, detail);
    const badge = document.createElement('span');
    badge.className = `protection-badge ${original.status}`;
    badge.textContent = original.protected ? 'Protégée' : original.converted ? 'À scanner' : 'À convertir';
    row.append(body, badge);
    list.append(row);
  }
}

function renderHistoryItems() {
  const list = byId('historyList');
  list.textContent = '';
  if (historyView === 'changes') {
    const changes = currentCase()?.workingChanges || [];
    byId('historyTitle').textContent = 'Modifications';
    byId('historyCount').textContent = `${changes.length} fichier${changes.length > 1 ? 's' : ''}`;
    if (!changes.length) {
      list.append(createHistoryEmpty('Aucune modification', 'Le dossier correspond au dernier checkpoint.'));
      showRevisionPlaceholder('Aucune modification locale');
      return;
    }
    for (const change of changes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `change-row${selectedRevision?.hash === 'WORKTREE' && selectedRevision.path === change.path ? ' active' : ''}`;
      const badge = document.createElement('span');
      badge.className = `file-status ${change.kind}`;
      badge.textContent = statusLetter(change);
      const file = document.createElement('span');
      file.className = 'change-path';
      file.textContent = change.path;
      button.append(badge, file);
      button.addEventListener('click', () => loadRevision('WORKTREE', change.path));
      list.append(button);
    }
    const selectedChange = selectedRevision?.hash === 'WORKTREE'
      ? changes.find((change) => change.path === selectedRevision.path)
      : null;
    loadRevision('WORKTREE', selectedChange?.path || changes[0].path);
    return;
  }

  byId('historyTitle').textContent = selectedFolder ? `Historique · ${selectedFolder}` : 'Historique';
  byId('historyCount').textContent = `${historyItems.length} élément${historyItems.length > 1 ? 's' : ''}`;
  if (!historyItems.length) {
    list.append(createHistoryEmpty('Aucun historique', 'Les checkpoints créés par le posthook apparaîtront ici.'));
    showRevisionPlaceholder('Aucune révision disponible');
    return;
  }

  let previousDay = '';
  for (const item of historyItems) {
    const day = new Date(item.timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    if (day !== previousDay) {
      const heading = document.createElement('div');
      heading.className = 'history-date';
      heading.textContent = day;
      list.append(heading);
      previousDay = day;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `commit-row${selectedRevision?.hash === item.hash ? ' active' : ''}`;
    button.dataset.hash = item.hash;
    const marker = document.createElement('span');
    marker.className = `commit-marker ${item.kind}`;
    marker.textContent = item.kind === 'checkpoint' ? '◆' : '●';
    const body = document.createElement('span');
    body.className = 'commit-body';
    const subject = document.createElement('strong');
    subject.textContent = item.subject || 'Sans message';
    const meta = document.createElement('span');
    meta.className = 'commit-meta';
    meta.textContent = `${item.author} · ${formatRelativeDate(item.timestamp)} · ${item.shortHash}`;
    body.append(subject, meta);
    const fileCount = document.createElement('span');
    fileCount.className = 'commit-file-count';
    fileCount.textContent = item.filesCount || '';
    button.append(marker, body, fileCount);
    button.addEventListener('click', () => loadRevision(item.hash));
    list.append(button);
  }

  if (!selectedRevision || selectedRevision.hash === 'WORKTREE' || !historyItems.some((item) => item.hash === selectedRevision.hash)) {
    loadRevision(historyItems[0].hash);
  }
}

function showRevisionPlaceholder(title) {
  selectedRevision = null;
  byId('revisionKind').textContent = 'Révision';
  byId('revisionSha').textContent = '';
  byId('revisionTitle').textContent = title;
  byId('revisionMeta').textContent = 'Les fichiers et leur diff apparaîtront ici.';
  byId('revisionFiles').textContent = '';
  byId('revisionFileCount').textContent = '0';
  byId('diffFile').textContent = 'Aucun fichier sélectionné';
  byId('diffStats').textContent = '';
  byId('diffContent').className = 'diff-content empty-state';
  byId('diffContent').textContent = 'Sélectionnez un commit ou un checkpoint dans l’historique.';
  byId('restoreRevision').hidden = true;
}

function renderPatch(patch) {
  const container = byId('diffContent');
  container.textContent = '';
  container.className = 'diff-content';
  if (!patch) {
    container.classList.add('empty-state');
    container.textContent = 'Aucune différence textuelle à afficher.';
    return;
  }
  for (const line of patch.split('\n')) {
    const row = document.createElement('div');
    row.className = 'diff-line';
    if (line.startsWith('@@')) row.classList.add('hunk');
    else if (line.startsWith('+') && !line.startsWith('+++')) row.classList.add('addition');
    else if (line.startsWith('-') && !line.startsWith('---')) row.classList.add('deletion');
    else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) row.classList.add('diff-header-line');
    row.textContent = line || ' ';
    container.append(row);
  }
}

async function loadRevision(hash, filePath = '') {
  byId('diffContent').className = 'diff-content empty-state';
  byId('diffContent').textContent = 'Chargement du diff…';
  try {
    if (!selectedFolder) return;
    const query = new URLSearchParams({ hash, case: selectedFolder });
    if (filePath) query.set('path', filePath);
    const revision = await api(`/api/admin/revision?${query}`);
    selectedRevision = { hash, path: revision.selectedPath || '' };
    document.querySelectorAll('.commit-row').forEach((row) => row.classList.toggle('active', row.dataset.hash === hash));
    document.querySelectorAll('.change-row').forEach((row) => row.classList.toggle('active', hash === 'WORKTREE' && row.querySelector('.change-path')?.textContent === revision.selectedPath));

    byId('revisionKind').textContent = revision.kind === 'checkpoint' ? 'Checkpoint' : revision.kind === 'worktree' ? 'Modifications locales' : 'Commit';
    byId('revisionSha').textContent = revision.shortHash || '';
    byId('revisionTitle').textContent = revision.subject;
    byId('revisionMeta').textContent = revision.kind === 'worktree'
      ? `${revision.files.length} fichier${revision.files.length > 1 ? 's' : ''} modifié${revision.files.length > 1 ? 's' : ''}`
      : `${revision.author} · ${new Date(revision.timestamp).toLocaleString('fr-FR')}`;
    byId('restoreRevision').hidden = revision.kind === 'worktree';

    const fileList = byId('revisionFiles');
    fileList.textContent = '';
    byId('revisionFileCount').textContent = String(revision.files.length);
    for (const file of revision.files) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `changed-file-row${file.path === revision.selectedPath ? ' active' : ''}`;
      const badge = document.createElement('span');
      badge.className = `file-status ${file.kind || 'modified'}`;
      badge.textContent = statusLetter(file);
      const name = document.createElement('span');
      name.textContent = file.path;
      button.append(badge, name);
      button.addEventListener('click', () => loadRevision(hash, file.path));
      fileList.append(button);
    }

    const selected = revision.files.find((file) => file.path === revision.selectedPath);
    byId('diffFile').textContent = revision.selectedPath || 'Aucun fichier sélectionné';
    byId('diffStats').textContent = selected && selected.added != null
      ? `+${selected.added}  −${selected.deleted}`
      : revision.truncated ? 'Diff tronqué' : '';
    renderPatch(revision.patch);
  } catch (error) {
    byId('diffContent').textContent = error.message;
    toast(error.message);
  }
}

async function loadHistoryItems() {
  if (historyView === 'changes') {
    renderHistoryItems();
    return;
  }
  const query = new URLSearchParams({ limit: '120' });
  if (!selectedFolder) {
    historyItems = [];
    renderHistoryItems();
    return;
  }
  query.set('case', selectedFolder);
  const data = await api(`/api/admin/history?${query}`);
  historyItems = data.history;
  renderHistoryItems();
}

async function loadRepositoryHistory({ quiet = false } = {}) {
  if (!quiet) byId('historyList').textContent = 'Chargement…';
  try {
    repositoryData = await api('/api/admin/repository');
    if (!repositoryData.folders.some((folder) => folder.path === selectedFolder)) {
      selectedFolder = repositoryData.folders[0]?.path || '';
      selectedRevision = null;
    }
    updateCaseToolbar();
    renderFolders();
    await loadHistoryItems();
    historyLoaded = true;
  } catch (error) {
    byId('historyList').textContent = error.message;
    if (!quiet) toast(error.message);
  }
}

async function selectHistoryFolder(folder) {
  selectedFolder = folder;
  selectedRevision = null;
  updateCaseToolbar();
  renderFolders();
  await loadHistoryItems();
}

function updateCaseToolbar() {
  const legalCase = currentCase();
  byId('repositoryName').textContent = legalCase?.name || 'Aucun dossier';
  byId('repositoryPath').textContent = legalCase ? `${repositoryData.root}/${legalCase.path}` : repositoryData?.root || '—';
  byId('repositoryBranch').textContent = 'Checkpoints du dossier';
  byId('repositoryHead').textContent = legalCase?.shortHead || 'Aucun';
  byId('createCheckpoint').disabled = !legalCase;
}

async function setHistoryView(view) {
  historyView = view;
  selectedRevision = null;
  document.querySelectorAll('[data-history-view]').forEach((button) => button.classList.toggle('active', button.dataset.historyView === view));
  await loadRepositoryHistory({ quiet: true });
}

async function createManualCheckpoint() {
  if (!selectedFolder) return;
  const label = prompt('Nom du checkpoint', `Checkpoint manuel · ${new Date().toLocaleString('fr-FR')}`);
  if (label === null) return;
  const button = byId('createCheckpoint');
  button.disabled = true;
  try {
    const result = await api('/api/admin/checkpoints', { method: 'POST', body: JSON.stringify({ label, case: selectedFolder }) });
    toast(result.created ? 'Checkpoint créé' : 'Aucune nouvelle modification à capturer');
    await loadRepositoryHistory({ quiet: true });
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function restoreSelectedRevision() {
  if (!selectedRevision || selectedRevision.hash === 'WORKTREE') return;
  const title = byId('revisionTitle').textContent;
  const confirmed = confirm(`Restaurer l’état « ${title} » du dossier « ${selectedFolder} » ?\n\nPieceMaker créera d’abord un checkpoint de sécurité. Les pièces originales ne seront jamais modifiées.`);
  if (!confirmed) return;
  const button = byId('restoreRevision');
  button.disabled = true;
  button.textContent = 'Restauration…';
  try {
    const result = await api('/api/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ hash: selectedRevision.hash, case: selectedFolder, confirm: true }),
    });
    toast(result.safetyCheckpoint ? 'État restauré — checkpoint de sécurité créé' : 'État restauré');
    historyView = 'changes';
    document.querySelectorAll('[data-history-view]').forEach((item) => item.classList.toggle('active', item.dataset.historyView === 'changes'));
    selectedRevision = null;
    await loadRepositoryHistory({ quiet: true });
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Restaurer cet état';
  }
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
document.querySelectorAll('[data-history-view]').forEach((button) => button.addEventListener('click', () => setHistoryView(button.dataset.historyView)));
byId('refreshHistory').addEventListener('click', () => loadRepositoryHistory());
byId('createCheckpoint').addEventListener('click', createManualCheckpoint);
byId('restoreRevision').addEventListener('click', restoreSelectedRevision);
byId('settingsForm').addEventListener('submit', saveSettings);
byId('saveFile').addEventListener('click', saveFile);
byId('fileEditor').addEventListener('input', (event) => {
  byId('dirtyBadge').hidden = event.currentTarget.value === originalContent;
});
window.addEventListener('beforeunload', (event) => {
  if (selectedFile && byId('fileEditor').value !== originalContent) event.preventDefault();
});

loadStatus();

setInterval(() => {
  if (document.visibilityState === 'visible' && byId('history').classList.contains('active')) {
    loadRepositoryHistory({ quiet: true });
  }
}, 6000);

import {
  joinMarkdownDocument,
  markdownToHtml,
  splitMarkdownDocument,
  visualEditorToMarkdown,
} from './markdown.mjs';

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
let currentFrontMatter = '';
let editorTouched = false;
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
  if (name === 'history' && !historyLoaded) loadRepositoryHistory();
  if (name === 'telegram') loadTelegram();
  if (name === 'files' && !filesLoaded) {
    loadFiles({ selectPath: new URLSearchParams(location.search).get('file') });
  }
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
    byId('workspacePath').value = data.config.workspacePath || '';
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
          workspacePath: form.get('workspacePath'),
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

function renderTelegram(data) {
  byId('assistantName').value = data.assistant.name;
  byId('monitorName').value = data.monitor.name;
  byId('assistantTokenState').textContent = data.assistant.token.configured
    ? `Déjà configuré (${data.assistant.token.hint})`
    : 'Non configuré';
  byId('monitorTokenState').textContent = data.monitor.token.configured
    ? `Déjà configuré (${data.monitor.token.hint})`
    : 'Non configuré';

  const assistantStatus = byId('assistantStatus');
  assistantStatus.textContent = data.assistant.running ? `Actif · PID ${data.assistant.pid}` : 'Arrêté';
  assistantStatus.className = `status-pill ${data.assistant.running ? 'ok' : 'pending'}`;
  byId('assistantLifecycle').textContent = data.assistant.running
    ? 'La session s’arrêtera à l’extinction de l’ordinateur et ne redémarrera pas seule.'
    : 'Démarrage manuel : la session ne revient pas automatiquement après une extinction.';

  const monitorStatus = byId('monitorStatus');
  monitorStatus.textContent = data.monitor.running
    ? `Actif · PID ${data.monitor.pid}`
    : data.monitor.installed ? 'Service arrêté' : 'Non installé';
  monitorStatus.className = `status-pill ${data.monitor.running ? 'ok' : data.monitor.installed ? 'pending' : 'error'}`;
  byId('monitorLifecycle').textContent = data.monitor.autoStart
    ? 'Service macOS : il s’arrête à l’extinction et redémarre à la prochaine ouverture de session.'
    : 'Relancez l’étape Telegram de l’installateur pour créer le service de démarrage automatique.';

  byId('startAssistant').disabled = !data.capabilities.assistantControl || data.assistant.running || !data.assistant.token.configured;
  byId('stopAssistant').disabled = !data.capabilities.assistantControl || !data.assistant.running;
  byId('startMonitor').disabled = !data.capabilities.monitorControl || data.monitor.running || !data.monitor.token.configured;
  byId('stopMonitor').disabled = !data.capabilities.monitorControl || !data.monitor.running;
  byId('dossiersRoot').textContent = data.dossiersRoot;
  renderDossierBots(data.dossiers, data.capabilities);
}

function makeElement(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function dossierBadge(text, kind = '') {
  return makeElement('span', `mini-badge ${kind}`.trim(), text);
}

function renderDossierBots(dossiers, capabilities) {
  const list = byId('dossierBotList');
  list.textContent = '';
  if (!dossiers.length) {
    list.append(makeElement('div', 'empty-state', 'Aucun sous-dossier juridique détecté dans cette racine.'));
    return;
  }

  for (const dossier of dossiers) {
    const card = makeElement('div', 'dossier-bot');
    const top = makeElement('div', 'dossier-bot-top');
    const identity = makeElement('div');
    const title = makeElement('div', 'dossier-bot-title');
    title.append(makeElement('strong', '', dossier.directoryName));
    title.append(dossierBadge(dossier.mappingConfigured ? 'Mapping présent' : 'Mapping absent', dossier.mappingConfigured ? 'ok' : ''));
    title.append(dossierBadge(`${dossier.markdownFiles} fichier(s) MD`, dossier.markdownFiles ? 'ok' : ''));
    if (dossier.originalsProtected) {
      const label = dossier.mappingConfigured
        ? `${dossier.originalFiles} original(aux) isolé(s) · noms anonymisés par mapping`
        : `${dossier.originalFiles} original(aux) isolé(s) · mapping requis avant les noms`;
      title.append(dossierBadge(label, 'protected'));
    }
    identity.append(title, makeElement('code', 'dossier-bot-path', dossier.workdir));
    if (dossier.mappingConfigured && dossier.mappedOriginalNames?.length) {
      const names = makeElement('ul', 'mapped-original-names');
      for (const name of dossier.mappedOriginalNames) names.append(makeElement('li', '', name));
      if (dossier.originalNamesTruncated) names.append(makeElement('li', 'muted', 'Liste limitée aux 100 premiers fichiers.'));
      identity.append(names);
    }
    const status = makeElement('span', `status-pill ${dossier.running ? 'ok' : dossier.linked ? 'pending' : 'error'}`);
    status.textContent = dossier.running
      ? `Actif · PID ${dossier.pid}`
      : dossier.linked ? 'Lié · arrêté' : dossier.projectConfigured ? 'Token manquant' : 'Non lié';
    top.append(identity, status);

    const editor = makeElement('div', 'dossier-link-editor');
    const nameLabel = makeElement('label', '', 'Nom de l’Assistant');
    const nameInput = document.createElement('input');
    nameInput.value = dossier.name;
    nameInput.maxLength = 64;
    nameLabel.append(nameInput);
    const tokenLabel = makeElement('label', '', 'Token BotFather');
    const tokenState = makeElement('span', 'secret-state', dossier.token.configured ? `Configuré (${dossier.token.hint})` : 'Non configuré');
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'new-password';
    tokenInput.placeholder = dossier.token.configured ? 'Laisser vide pour conserver' : 'Token requis pour lier';
    tokenLabel.append(tokenState, tokenInput);
    const controls = makeElement('div', 'dossier-controls');
    const save = makeElement('button', 'button primary compact', dossier.linked ? 'Enregistrer' : 'Lier ce bot');
    save.type = 'button';
    save.addEventListener('click', () => saveDossierBot(dossier.id, nameInput, tokenInput, save));
    const start = makeElement('button', 'button secondary compact', 'Démarrer');
    start.type = 'button';
    start.disabled = !capabilities.dossierControl || !dossier.linked || dossier.running;
    start.addEventListener('click', () => controlDossierBot(dossier.id, 'start', start));
    const stop = makeElement('button', 'button subtle-danger compact', 'Arrêter');
    stop.type = 'button';
    stop.disabled = !capabilities.dossierControl || !dossier.running;
    stop.addEventListener('click', () => controlDossierBot(dossier.id, 'stop', stop));
    controls.append(save, start, stop);
    editor.append(nameLabel, tokenLabel, controls);
    card.append(top, editor);
    list.append(card);
  }
}

async function saveDossierBot(id, nameInput, tokenInput, button) {
  const message = byId('telegramMessage');
  button.disabled = true;
  setMessage(message, 'Liaison du dossier…');
  try {
    await api(`/api/admin/telegram/dossiers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: nameInput.value, token: tokenInput.value }),
    });
    tokenInput.value = '';
    setMessage(message, 'Assistant du dossier lié. La configuration d’accès du bot général a été reprise.', 'success');
    await loadTelegram({ quiet: true });
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function controlDossierBot(id, action, button) {
  const message = byId('telegramMessage');
  button.disabled = true;
  setMessage(message, `${action === 'start' ? 'Démarrage' : 'Arrêt'} de l’Assistant du dossier…`);
  try {
    const result = await api(`/api/admin/telegram/dossiers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
    setMessage(message, result.message, 'success');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await loadTelegram({ quiet: true });
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadTelegram({ quiet = false } = {}) {
  const message = byId('telegramMessage');
  if (!quiet) setMessage(message, 'Chargement…');
  try {
    const data = await api('/api/admin/telegram');
    renderTelegram(data);
    if (!quiet) setMessage(message);
  } catch (error) {
    setMessage(message, error.message, 'error');
  }
}

async function saveTelegram(event) {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  const message = byId('telegramMessage');
  const form = new FormData(event.currentTarget);
  button.disabled = true;
  setMessage(message, 'Enregistrement sécurisé…');
  try {
    const data = await api('/api/admin/telegram', {
      method: 'PUT',
      body: JSON.stringify({
        assistantName: form.get('assistantName'),
        assistantToken: form.get('assistantToken'),
        monitorName: form.get('monitorName'),
        monitorToken: form.get('monitorToken'),
      }),
    });
    event.currentTarget.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
    renderTelegram(data);
    setMessage(message, 'Configurations enregistrées. Les tokens complets restent uniquement sur cet ordinateur.', 'success');
    toast('Configuration Telegram enregistrée');
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function controlTelegram(role, action, button) {
  const message = byId('telegramMessage');
  button.disabled = true;
  setMessage(message, `${action === 'start' ? 'Démarrage' : 'Arrêt'} en cours…`);
  try {
    const result = await api(`/api/admin/telegram/${role}/${action}`, { method: 'POST', body: '{}' });
    setMessage(message, result.message, 'success');
    await new Promise((resolve) => setTimeout(resolve, 700));
    await loadTelegram({ quiet: true });
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function fileGroupLabel(kind) {
  return { instructions: 'Instructions', skill: 'Skills', agent: 'Agents', billing: 'Facturation — aperçus' }[kind] || kind;
}

async function loadFiles({ selectPath = null } = {}) {
  const list = byId('fileList');
  list.textContent = 'Chargement…';
  try {
    const { files } = await api('/api/admin/files');
    list.textContent = '';
    for (const kind of ['instructions', 'skill', 'agent', 'billing']) {
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
    const requestedPath = selectPath || (!selectedFile
      ? files.find((item) => item.kind === 'skill')?.path || files.find((item) => item.exists)?.path
      : null);
    if (requestedPath) {
      const button = Array.from(list.querySelectorAll('.file-button')).find((item) => item.dataset.path === requestedPath);
      const file = files.find((item) => item.path === requestedPath);
      if (button && file) await selectFile(file, button);
    }
  } catch (error) {
    list.textContent = error.message;
  }
}

function metadataValues() {
  return {
    name: byId('metadataName').value,
    description: byId('metadataDescription').value,
    model: byId('metadataModel').value,
    tools: byId('metadataTools').value,
  };
}

function currentMarkdown() {
  return joinMarkdownDocument(currentFrontMatter, metadataValues(), visualEditorToMarkdown(byId('fileEditor')));
}

function markEditorDirty() {
  if (!selectedFile || selectedFile.readonly) return;
  editorTouched = true;
  byId('dirtyBadge').hidden = false;
}

async function selectFile(file, button) {
  if (selectedFile && editorTouched && !confirm('Abandonner les modifications non enregistrées ?')) return;
  document.querySelectorAll('.file-button').forEach((item) => item.classList.toggle('active', item === button));
  setMessage(byId('fileMessage'), 'Chargement…');
  try {
    const data = await api(`/api/admin/file?path=${encodeURIComponent(file.path)}`);
    const editor = byId('fileEditor');
    const documentParts = splitMarkdownDocument(data.content);
    selectedFile = data;
    currentFrontMatter = documentParts.frontMatter;
    editorTouched = false;
    editor.innerHTML = markdownToHtml(documentParts.body);
    editor.contentEditable = String(!data.readonly);
    editor.classList.toggle('empty', !documentParts.body.trim());
    byId('editorToolbar').hidden = data.readonly;
    byId('saveFile').disabled = data.readonly;
    byId('metadataEditor').hidden = !documentParts.frontMatter || data.readonly;
    byId('metadataName').value = documentParts.metadata.name || '';
    byId('metadataDescription').value = documentParts.metadata.description || '';
    byId('metadataModel').value = documentParts.metadata.model || '';
    byId('metadataTools').value = documentParts.metadata.tools || '';
    byId('fileTitle').textContent = file.name;
    byId('filePath').textContent = file.path;
    byId('dirtyBadge').hidden = true;
    setMessage(byId('fileMessage'), data.readonly ? 'Aperçu visuel en lecture seule.' : data.exists ? 'Édition visuelle — le fichier enregistré reste en Markdown.' : 'Ce fichier sera créé lors de l’enregistrement.');
  } catch (error) {
    setMessage(byId('fileMessage'), error.message, 'error');
  }
}

async function saveFile() {
  if (!selectedFile || selectedFile.readonly) return;
  const button = byId('saveFile');
  const content = currentMarkdown();
  button.disabled = true;
  setMessage(byId('fileMessage'), 'Enregistrement du Markdown…');
  try {
    const result = await api('/api/admin/file', {
      method: 'PUT',
      body: JSON.stringify({ path: selectedFile.path, content }),
    });
    editorTouched = false;
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
      list.append(createHistoryEmpty('Aucune modification', 'Le dossier correspond au dernier commit.'));
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
    list.append(createHistoryEmpty('Aucun historique', 'Les commits créés par le posthook apparaîtront ici.'));
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
    marker.textContent = '●';
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
  byId('diffContent').textContent = 'Sélectionnez un commit dans l’historique.';
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

    byId('revisionKind').textContent = revision.kind === 'worktree' ? 'Modifications locales' : 'Commit';
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
  byId('repositoryPath').textContent = repositoryData?.root || '—';
  byId('repositoryBranch').textContent = 'Commits du dossier';
  byId('repositoryHead').textContent = legalCase?.shortHead || 'Aucun';
  byId('createCommit').disabled = !legalCase;
}

async function setHistoryView(view) {
  historyView = view;
  selectedRevision = null;
  document.querySelectorAll('[data-history-view]').forEach((button) => button.classList.toggle('active', button.dataset.historyView === view));
  await loadRepositoryHistory({ quiet: true });
}

async function createManualCommit() {
  if (!selectedFolder) return;
  const label = prompt('Message du commit', `Sauvegarde · ${new Date().toLocaleString('fr-FR')}`);
  if (label === null) return;
  const button = byId('createCommit');
  button.disabled = true;
  try {
    const result = await api('/api/admin/commits', { method: 'POST', body: JSON.stringify({ label, case: selectedFolder }) });
    toast(result.created ? 'Commit enregistré' : 'Aucune nouvelle modification à enregistrer');
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
  const confirmed = confirm(`Restaurer le commit « ${title} » du dossier « ${selectedFolder} » ?\n\nPieceMaker enregistrera d’abord l’état actuel dans un commit de sécurité. Les pièces originales ne seront jamais modifiées.`);
  if (!confirmed) return;
  const button = byId('restoreRevision');
  button.disabled = true;
  button.textContent = 'Restauration…';
  try {
    const result = await api('/api/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ hash: selectedRevision.hash, case: selectedFolder, confirm: true }),
    });
    toast(result.safetyCommit ? 'Commit restauré — état précédent enregistré' : 'Commit restauré');
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

document.querySelectorAll('[data-history-view]').forEach((button) => button.addEventListener('click', () => setHistoryView(button.dataset.historyView)));
byId('refreshHistory').addEventListener('click', () => loadRepositoryHistory());
byId('createCommit').addEventListener('click', createManualCommit);
byId('restoreRevision').addEventListener('click', restoreSelectedRevision);

function applyEditorCommand(button) {
  byId('fileEditor').focus();
  const command = button.dataset.command;
  if (command === 'createLink') {
    const url = prompt('Adresse du lien (https://…)');
    if (url) document.execCommand('createLink', false, url);
  } else if (command) {
    document.execCommand(command, false);
  } else if (button.dataset.block) {
    document.execCommand('formatBlock', false, button.dataset.block);
  }
  markEditorDirty();
}

function openCreateDialog(kind) {
  const dialog = byId('createFileDialog');
  byId('createFileForm').reset();
  byId('createFileKind').value = kind;
  byId('createFileTitle').textContent = kind === 'skill' ? 'Créer un skill' : 'Créer un agent';
  setMessage(byId('createFileMessage'));
  dialog.showModal();
}

async function createFile(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(byId('createFileMessage'), 'Création…');
  try {
    const result = await api('/api/admin/files', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form)),
    });
    byId('createFileDialog').close();
    await loadFiles({ selectPath: result.file.path });
    toast(`${form.get('kind') === 'skill' ? 'Skill' : 'Agent'} créé`);
  } catch (error) {
    setMessage(byId('createFileMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  setActiveTab(tab.dataset.tab);
  history.replaceState(null, '', `#${tab.dataset.tab}`);
}));
byId('settingsForm').addEventListener('submit', saveSettings);
byId('telegramForm').addEventListener('submit', saveTelegram);
byId('refreshTelegram').addEventListener('click', () => loadTelegram());
byId('startAssistant').addEventListener('click', (event) => controlTelegram('assistant', 'start', event.currentTarget));
byId('stopAssistant').addEventListener('click', (event) => controlTelegram('assistant', 'stop', event.currentTarget));
byId('startMonitor').addEventListener('click', (event) => controlTelegram('monitor', 'start', event.currentTarget));
byId('stopMonitor').addEventListener('click', (event) => controlTelegram('monitor', 'stop', event.currentTarget));
byId('saveFile').addEventListener('click', saveFile);
byId('fileEditor').addEventListener('input', markEditorDirty);
document.querySelectorAll('#metadataEditor input').forEach((input) => input.addEventListener('input', markEditorDirty));
document.querySelectorAll('#editorToolbar button').forEach((button) => {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => applyEditorCommand(button));
});
byId('blockFormat').addEventListener('change', (event) => {
  byId('fileEditor').focus();
  document.execCommand('formatBlock', false, event.currentTarget.value);
  markEditorDirty();
});
document.querySelectorAll('[data-create-kind]').forEach((button) => button.addEventListener('click', () => openCreateDialog(button.dataset.createKind)));
byId('createFileForm').addEventListener('submit', createFile);
byId('cancelCreateFile').addEventListener('click', () => byId('createFileDialog').close());
window.addEventListener('beforeunload', (event) => {
  if (selectedFile && editorTouched) event.preventDefault();
});

const requestedTab = location.hash.slice(1);
setActiveTab(['dashboard', 'history', 'settings', 'telegram', 'files'].includes(requestedTab) ? requestedTab : 'dashboard');
loadStatus();

setInterval(() => {
  if (document.visibilityState === 'visible' && byId('history').classList.contains('active')) {
    loadRepositoryHistory({ quiet: true });
  }
}, 6000);

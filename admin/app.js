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
let tamponImage = null;          // data URL du tampon courant (cf. anonymization.js)
let dossiers = [];
let selectedPieces = [];         // IDs dans l'ordre du bordereau
let selectedOriginals = new Set(); // chemins des pièces cochées dans le cadre « Pièces originales »
let originalsJob = null;         // travail de conversion/anonymisation en cours
let originalsJobTimer = null;
let mappingDocument = null;      // { mapping, reverse_mapping } en cours d'édition

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
  if (name === 'pieces') loadPieces();
  if (name === 'telegram') loadTelegram();
  if (name === 'files' && !filesLoaded) {
    loadFiles({ selectPath: new URLSearchParams(location.search).get('file') });
  }
}

// ---------------------------------------------------------------------------
// Tampon et tamponnage des pièces
// Reprend les endpoints déjà servis par server.cjs (/api/tampon/*, /api/stamping)
// et la logique du volet Word (taskpane/modules/anonymization.js).
// ---------------------------------------------------------------------------

function showTampon(dataUrl) {
  tamponImage = dataUrl;
  const image = byId('tamponPreviewImage');
  image.src = dataUrl || '';
  image.hidden = !dataUrl;
  byId('tamponEmpty').hidden = Boolean(dataUrl);
  byId('saveTamponBtn').disabled = !dataUrl;
  const state = byId('tamponState');
  state.textContent = dataUrl ? '● Tampon prêt' : 'Aucun tampon';
  state.className = `status-pill ${dataUrl ? 'ok' : 'pending'}`;
}

async function loadTampon() {
  try {
    const response = await fetch('/api/tampon/load');
    if (!response.ok) return showTampon(null);
    const result = await response.json();
    showTampon(result.tamponImage || null);
    byId('saveTamponBtn').disabled = true;
  } catch (error) {
    showTampon(null);
  }
}

function handleTamponImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    setMessage(byId('tamponMessage'), 'Format d’image non supporté. Utilisez PNG ou JPEG.', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (loaded) => {
    showTampon(loaded.target.result);
    setMessage(byId('tamponMessage'), `Image chargée : ${file.name} — pensez à enregistrer.`);
  };
  reader.readAsDataURL(file);
}

/** Dessine un tampon à partir des champs du formulaire (PNG 300×300). */
function buildTampon() {
  const size = 300;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const color = byId('tamponColor').value;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 10;

  if (byId('tamponShape').value === 'circle') {
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 14, 0, Math.PI * 2);
    context.stroke();
  } else {
    context.strokeRect(14, 14, size - 28, size - 28);
  }

  context.textAlign = 'center';
  context.font = 'bold 34px Helvetica, Arial, sans-serif';
  context.fillText(byId('tamponTop').value.slice(0, 24), size / 2, size / 2 - 46);
  context.font = 'bold 26px Helvetica, Arial, sans-serif';
  context.fillText(byId('tamponBottom').value.slice(0, 24), size / 2, size / 2 + 86);

  showTampon(canvas.toDataURL('image/png'));
  setMessage(byId('tamponMessage'), 'Tampon généré — le numéro de pièce s’imprimera au centre.');
}

async function saveTampon() {
  if (!tamponImage) return;
  try {
    await api('/api/tampon/save', { method: 'POST', body: JSON.stringify({ tamponImage }) });
    byId('saveTamponBtn').disabled = true;
    setMessage(byId('tamponMessage'), 'Tampon enregistré.', 'success');
    toast('Tampon enregistré');
    loadDossiers();
  } catch (error) {
    setMessage(byId('tamponMessage'), error.message, 'error');
  }
}

async function clearTampon() {
  try {
    await api('/api/tampon/delete', { method: 'DELETE' });
    byId('tamponImageInput').value = '';
    showTampon(null);
    setMessage(byId('tamponMessage'), 'Tampon supprimé.');
  } catch (error) {
    setMessage(byId('tamponMessage'), error.message, 'error');
  }
}

function currentDossier() {
  return dossiers.find((dossier) => dossier.documentId === byId('dossierSelect').value) || null;
}

function renderPieces() {
  const dossier = currentDossier();
  const list = byId('piecesList');
  const folderInput = byId('workingFolder');
  list.innerHTML = '';
  if (dossier && !folderInput.value) folderInput.value = dossier.folder || '';
  byId('stampedDir').textContent = folderInput.value
    ? `${folderInput.value}/Pièces`
    : 'dossier de travail à renseigner';

  if (!dossier) {
    list.innerHTML = '<p class="muted">Aucun dossier chargé. Chargez des pièces depuis le volet Word.</p>';
    byId('stampPiecesBtn').disabled = true;
    return;
  }

  for (const piece of dossier.documents) {
    const rank = selectedPieces.indexOf(String(piece.id));
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `piece-row${rank >= 0 ? ' selected' : ''}`;
    row.innerHTML = `<span class="piece-rank">${rank >= 0 ? `n°${rank + 1}` : ''}</span>`
      + `<span class="piece-name"></span>`
      + `<span class="muted">${[piece.type_document, piece.date_document].filter(Boolean).join(' · ')}</span>`;
    row.querySelector('.piece-name').textContent = piece.filename || `Pièce ${piece.id}`;
    row.addEventListener('click', () => togglePiece(String(piece.id)));
    list.appendChild(row);
  }

  byId('stampPiecesBtn').disabled = selectedPieces.length === 0 || !tamponImage;
}

function togglePiece(id) {
  const index = selectedPieces.indexOf(id);
  if (index >= 0) selectedPieces.splice(index, 1);
  else selectedPieces.push(id);
  renderPieces();
}

async function loadDossiers() {
  try {
    const result = await api('/api/admin/dossiers');
    dossiers = result.dossiers || [];
    const select = byId('dossierSelect');
    const previous = select.value;
    select.innerHTML = '';
    for (const dossier of dossiers) {
      const option = document.createElement('option');
      option.value = dossier.documentId;
      const label = dossier.informations?.intitule || dossier.informations?.nom || dossier.documentId;
      option.textContent = `${label} — ${dossier.documents.length} pièce(s)`;
      select.appendChild(option);
    }
    if (previous && dossiers.some((dossier) => dossier.documentId === previous)) select.value = previous;
    else selectedPieces = [];
    renderPieces();
  } catch (error) {
    setMessage(byId('piecesMessage'), error.message, 'error');
  }
}

function loadPieces() {
  loadTampon();
  loadDossiers();
}

async function stampPieces() {
  const dossier = currentDossier();
  if (!dossier || selectedPieces.length === 0) return;
  const button = byId('stampPiecesBtn');
  button.disabled = true;
  setMessage(byId('piecesMessage'), 'Tamponnage en cours…');
  try {
    const result = await api('/api/stamping', {
      method: 'POST',
      body: JSON.stringify({
        pieces: selectedPieces,
        documentId: dossier.documentId,
        folder: byId('workingFolder').value.trim(),
      }),
    });
    renderStampResults(result);
    setMessage(byId('piecesMessage'), result.message, result.summary.failure ? 'error' : 'success');
    toast(result.message);
  } catch (error) {
    setMessage(byId('piecesMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderStampResults(result) {
  const container = byId('stampResults');
  container.hidden = false;
  container.innerHTML = '';
  const target = document.createElement('p');
  target.className = 'muted';
  target.textContent = `Sortie : ${result.tamponnedDir}`;
  container.appendChild(target);
  const list = document.createElement('div');
  list.className = 'pieces-list';
  for (const item of result.results) {
    const row = document.createElement('div');
    row.className = `piece-row ${item.success ? 'ok' : 'ko'}`;
    row.innerHTML = `<span class="piece-rank">n°${item.pieceNumber}</span><span class="piece-name"></span><span class="muted"></span>`;
    row.querySelector('.piece-name').textContent = item.outputFileName || item.filename || item.id;
    row.querySelector('.muted').textContent = item.success ? 'tamponnée' : item.error;
    list.appendChild(row);
  }
  container.appendChild(list);
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
    const total = status.files.skills + status.files.agents;
    const assetCount = byId('assetCount');
    assetCount.textContent = `${status.files.skills} / ${status.files.agents}`;
    assetCount.title = `${status.files.registered ?? 0} sur ${total} enregistré(s) dans Claude Code`;
    byId('assetRegistered').textContent = `${status.files.registered ?? 0}/${total} dans Claude Code`;
    const office = byId('officeState');
    office.hidden = status.libreOffice !== false;
    office.textContent = 'LibreOffice introuvable : les pièces Excel et Word ne pourront pas être converties en PDF. '
      + 'Installez LibreOffice (ou renseignez SOFFICE_PATH) puis redémarrez le serveur.';
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
  for (const key of ['LEGIFRANCE_CLIENT_ID', 'LEGIFRANCE_CLIENT_SECRET']) {
    const value = String(form.get(key) || '').trim();
    if (value) env[key] = value;
  }
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

// Un skill / agent n'est utilisable dans Claude Code que s'il est enregistré
// dans ~/.claude (voir websocket-server/claude-assets.cjs) : l'état est
// affiché à côté du fichier pour que l'absence se voie tout de suite.
const CLAUDE_ASSET_BADGES = {
  linked: { text: 'Claude Code', className: 'ok', title: 'Enregistré dans Claude Code (lien vers le dépôt).' },
  copied: { text: 'Claude Code', className: 'ok', title: 'Enregistré dans Claude Code (copie synchronisée à chaque enregistrement).' },
  conflict: { text: 'Conflit', className: 'warn', title: 'Un fichier personnel du même nom existe déjà dans ~/.claude — il n’a pas été remplacé.' },
  missing: { text: 'Non enregistré', className: 'warn', title: 'Pas encore visible par Claude Code — utilisez « ⟳ Claude Code ».' },
};

function claudeAssetBadge(file) {
  const state = file.claudeCode?.state;
  if (!state || !file.exists) return null;
  const badge = CLAUDE_ASSET_BADGES[state];
  if (!badge) return null;
  const element = makeElement('span', `asset-badge ${badge.className}`, badge.text);
  element.title = badge.title;
  return element;
}

async function syncClaudeAssets() {
  const button = byId('syncClaudeAssets');
  const message = byId('claudeAssetsMessage');
  button.disabled = true;
  setMessage(message, 'Enregistrement auprès de Claude Code…');
  try {
    const result = await api('/api/admin/files/sync', { method: 'POST', body: '{}' });
    await loadFiles({ selectPath: selectedFile?.path || null });
    const conflicts = result.conflicts?.length
      ? ` — ${result.conflicts.length} conflit(s) de nom dans ~/.claude`
      : '';
    setMessage(message, `${result.registered} skill(s)/agent(s) enregistré(s)${conflicts}.`, conflicts ? 'error' : 'success');
    toast('Skills et agents synchronisés avec Claude Code');
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function fileGroupLabel(kind) {
  return { instructions: 'Instructions', skill: 'Skills', agent: 'Agents' }[kind] || kind;
}

async function loadFiles({ selectPath = null } = {}) {
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
        button.dataset.path = file.path;
        button.append(makeElement('span', 'file-button-label', file.exists ? file.name : `${file.name} — créer`));
        const registration = claudeAssetBadge(file);
        if (registration) button.append(registration);
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

// `model` et `tools` sont du front matter d'agent : un skill n'en a pas, on
// laisse alors ces clés intactes (undefined = non modifié).
function metadataValues() {
  const isAgent = selectedFile?.kind === 'agent';
  return {
    name: byId('metadataName').value,
    description: byId('metadataDescription').value,
    model: isAgent ? byId('metadataModel').value : undefined,
    tools: isAgent ? byId('metadataTools').value : undefined,
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
    const isAgent = data.kind === 'agent';
    byId('metadataModelField').hidden = !isAgent;
    byId('metadataToolsField').hidden = !isAgent;
    // Un modèle inconnu du menu (valeur épinglée à la main) doit être conservé.
    const model = isAgent ? documentParts.metadata.model || '' : '';
    const modelSelect = byId('metadataModel');
    if (model && !Array.from(modelSelect.options).some((option) => option.value === model)) {
      const option = makeElement('option', '', model);
      option.value = model;
      modelSelect.append(option);
    }
    modelSelect.value = model;
    byId('metadataTools').value = isAgent ? documentParts.metadata.tools || '' : '';
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

// ---------------------------------------------------------------------------
// Pièces originales : conversion Markdown puis pipeline d'anonymisation.
// Le cadre ne liste que les pièces telles qu'elles ont été déposées — le
// Markdown produit par la conversion est exclu, il apparaît déjà dans
// l'historique du dossier. Chaque pièce porte deux badges indépendants :
// « Markdown » quand la conversion existe, « PII » quand le scan GLiNER a
// écrit son `_sensitive_map.json`.
// ---------------------------------------------------------------------------

function caseOriginals() {
  return currentCase()?.originals || [];
}

function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toFixed(1)} Mo`;
}

function renderOriginals() {
  const list = byId('originalList');
  const originals = caseOriginals();
  list.textContent = '';
  byId('originalCount').textContent = String(originals.length);
  const known = new Set(originals.map((original) => original.path));
  for (const selected of [...selectedOriginals]) {
    if (!known.has(selected)) selectedOriginals.delete(selected);
  }
  if (!selectedFolder) {
    list.append(createHistoryEmpty('Sélectionnez un dossier'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }
  if (!originals.length) {
    list.append(createHistoryEmpty('Aucune pièce originale', 'Déposez les pièces dans le sous-dossier « pièces originales ».'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }
  for (const original of originals) {
    const row = document.createElement('label');
    row.className = `original-row${selectedOriginals.has(original.path) ? ' selected' : ''}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedOriginals.has(original.path);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedOriginals.add(original.path);
      else selectedOriginals.delete(original.path);
      row.classList.toggle('selected', checkbox.checked);
      updateOriginalsActions();
    });
    const body = document.createElement('span');
    body.className = 'original-body';
    const name = document.createElement('strong');
    name.textContent = original.path;
    const detail = document.createElement('span');
    detail.textContent = `${formatBytes(original.size)} · ${original.converted
      ? (original.scanned ? 'Markdown et scan PII à jour' : 'Markdown généré, scan PII manquant')
      : 'Markdown non généré'}`;
    body.append(name, detail);
    const badges = document.createElement('span');
    badges.className = 'original-badges';
    if (original.converted) {
      const converted = document.createElement('span');
      converted.className = 'protection-badge converted';
      converted.textContent = 'Markdown';
      badges.append(converted);
    }
    if (original.scanned) {
      const scanned = document.createElement('span');
      scanned.className = 'protection-badge scanned';
      scanned.textContent = 'PII';
      badges.append(scanned);
    }
    if (!original.converted) {
      const pending = document.createElement('span');
      pending.className = 'protection-badge not-converted';
      pending.textContent = 'À convertir';
      badges.append(pending);
    }
    row.append(checkbox, body, badges);
    list.append(row);
  }
  updateOriginalsActions();
  renderMappingSummary();
}

/** Sans sélection explicite, les boutons agissent sur toutes les pièces. */
function originalsToProcess() {
  const originals = caseOriginals();
  if (!selectedOriginals.size) return originals.map((original) => original.path);
  return originals.filter((original) => selectedOriginals.has(original.path)).map((original) => original.path);
}

function updateOriginalsActions() {
  const originals = caseOriginals();
  const running = Boolean(originalsJob && originalsJob.state === 'running');
  const count = originalsToProcess().length;
  const selectAll = byId('selectAllOriginals');
  selectAll.disabled = running || !originals.length;
  selectAll.checked = Boolean(originals.length) && selectedOriginals.size === originals.length;
  selectAll.indeterminate = selectedOriginals.size > 0 && selectedOriginals.size < originals.length;
  const suffix = selectedOriginals.size ? ` (${count})` : '';
  const convert = byId('convertOriginals');
  const anonymize = byId('anonymizeOriginals');
  convert.disabled = running || !count;
  anonymize.disabled = running || !count;
  convert.textContent = `Convertir en Markdown${suffix}`;
  anonymize.textContent = `Anonymiser et mapper${suffix}`;
}

function showOriginalsProgress(message, kind = '') {
  const element = byId('originalsProgress');
  element.hidden = !message;
  element.textContent = message || '';
  element.className = `originals-progress${kind ? ` ${kind}` : ''}`;
}

function describeJob(job) {
  const phase = { convert: 'Conversion', scan: 'Analyse PII', mapping: 'Mise à jour du mapping' }[job.phase] || 'Traitement';
  if (job.state === 'running') return `${phase} · ${job.processed}/${job.total} · ${job.percent}%`;
  if (job.state === 'error') return `Échec : ${job.error}`;
  const result = job.result || {};
  return job.action === 'convert'
    ? `${result.converted || job.total} pièce(s) converties en Markdown.`
    : `${result.scanned || job.total} pièce(s) analysées · ${result.mappingAdded || 0} entrée(s) ajoutée(s) au mapping.`;
}

async function startOriginalsPipeline(action) {
  if (!selectedFolder) return;
  const files = originalsToProcess();
  if (!files.length) return;
  clearTimeout(originalsJobTimer);
  try {
    const result = await api('/api/admin/originals/pipeline', {
      method: 'POST',
      body: JSON.stringify({ case: selectedFolder, action, files }),
    });
    originalsJob = result.job;
    updateOriginalsActions();
    showOriginalsProgress(describeJob(originalsJob));
    pollOriginalsJob();
  } catch (error) {
    showOriginalsProgress(error.message, 'error');
  }
}

async function pollOriginalsJob() {
  if (!originalsJob) return;
  try {
    const { job } = await api(`/api/admin/originals/job?id=${encodeURIComponent(originalsJob.id)}`);
    originalsJob = job;
    showOriginalsProgress(describeJob(job), job.state === 'error' ? 'error' : '');
    if (job.state === 'running') {
      originalsJobTimer = setTimeout(pollOriginalsJob, 1500);
      return;
    }
    updateOriginalsActions();
    toast(job.state === 'error' ? 'Traitement interrompu' : 'Traitement terminé');
    await loadRepositoryHistory({ quiet: true });
  } catch (error) {
    showOriginalsProgress(error.message, 'error');
    originalsJob = null;
    updateOriginalsActions();
  }
}

// ---------------------------------------------------------------------------
// Mapping d'anonymisation du dossier — lecture et édition ligne à ligne.
// ---------------------------------------------------------------------------

function renderMappingSummary() {
  const legalCase = currentCase();
  const button = byId('openMapping');
  const entries = legalCase ? Object.keys(legalCase.mapping?.mapping || {}).length : 0;
  byId('mappingCount').textContent = String(entries);
  byId('mappingName').textContent = legalCase?.mapping?.name || 'Aucun mapping';
  byId('mappingState').textContent = !legalCase
    ? 'Sélectionnez un dossier'
    : legalCase.mapping?.exists
      ? `${entries} entrée(s) · cliquez pour modifier`
      : 'Aucun fichier — lancez « Anonymiser et mapper »';
  button.disabled = !legalCase;
}

function mappingEntries() {
  return byId('mappingRows').querySelectorAll('.mapping-entry');
}

function refreshMappingCount() {
  byId('mappingDialogCount').textContent = String(mappingEntries().length);
}

function addMappingEntry(entity = '', code = '', { focus = false } = {}) {
  const rows = byId('mappingRows');
  const empty = rows.querySelector('.mapping-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'mapping-entry';
  const entityInput = document.createElement('input');
  entityInput.value = entity;
  entityInput.placeholder = 'Jean Dupont';
  entityInput.setAttribute('aria-label', 'Donnée d’origine');
  const codeInput = document.createElement('input');
  codeInput.className = 'code';
  codeInput.value = code;
  codeInput.placeholder = 'PERSON_01';
  codeInput.setAttribute('aria-label', 'Code de remplacement');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.title = 'Supprimer cette entrée';
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    row.remove();
    refreshMappingCount();
    if (!mappingEntries().length) renderMappingRows({});
  });
  for (const input of [entityInput, codeInput]) {
    input.addEventListener('input', () => {
      input.classList.remove('invalid');
      setMessage(byId('mappingMessage'));
    });
  }
  row.append(entityInput, codeInput, remove);
  rows.append(row);
  refreshMappingCount();
  if (focus) entityInput.focus();
}

function renderMappingRows(mapping) {
  const rows = byId('mappingRows');
  rows.textContent = '';
  const pairs = Object.entries(mapping || {});
  if (!pairs.length) {
    const empty = document.createElement('p');
    empty.className = 'mapping-empty';
    empty.textContent = 'Aucune entrée. Ajoutez-en une ou régénérez depuis les scans PII.';
    rows.append(empty);
    refreshMappingCount();
    return;
  }
  for (const [entity, code] of pairs) addMappingEntry(entity, code);
}

/** Le mapping saisi, validé : pas de doublon d'entité, pas de code partagé. */
function collectMapping() {
  const mapping = {};
  const codes = new Map();
  for (const row of mappingEntries()) {
    const [entityInput, codeInput] = row.querySelectorAll('input');
    const entity = entityInput.value.trim();
    const code = codeInput.value.trim();
    if (!entity && !code) continue;
    if (!entity || !code) {
      (entity ? codeInput : entityInput).classList.add('invalid');
      throw new Error('Chaque entrée demande une donnée d’origine et un code.');
    }
    if (mapping[entity]) {
      entityInput.classList.add('invalid');
      throw new Error(`« ${entity} » apparaît deux fois.`);
    }
    if (codes.has(code) && codes.get(code) !== entity) {
      codeInput.classList.add('invalid');
      throw new Error(`Le code « ${code} » est déjà utilisé par une autre donnée.`);
    }
    mapping[entity] = code;
    codes.set(code, entity);
  }
  return mapping;
}

/**
 * Le sens inverse est reconstruit à partir de celui chargé : un code peut
 * couvrir plusieurs variantes d'écriture, et les variantes qui ne sont plus
 * dans le mapping direct sont abandonnées avec lui.
 */
function buildReverseMapping(mapping) {
  const previous = mappingDocument?.reverse_mapping || {};
  const reverse = {};
  for (const [entity, code] of Object.entries(mapping)) {
    const variants = new Set([entity]);
    for (const variant of previous[code] || []) {
      if (!Object.prototype.hasOwnProperty.call(mapping, variant) || mapping[variant] === code) variants.add(variant);
    }
    reverse[code] = [...variants];
  }
  return reverse;
}

async function openMappingDialog() {
  if (!selectedFolder) return;
  const dialog = byId('mappingDialog');
  setMessage(byId('mappingMessage'), 'Chargement…');
  byId('mappingRows').textContent = '';
  dialog.showModal();
  try {
    const data = await api(`/api/admin/mapping?case=${encodeURIComponent(selectedFolder)}`);
    mappingDocument = { mapping: data.mapping, reverse_mapping: data.reverse_mapping };
    byId('mappingDialogTitle').textContent = data.name;
    renderMappingRows(data.mapping);
    setMessage(byId('mappingMessage'), data.exists ? '' : 'Ce dossier n’a pas encore de fichier de mapping.');
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
  }
}

async function saveMapping() {
  const button = byId('saveMapping');
  button.disabled = true;
  try {
    const mapping = collectMapping();
    const data = await api('/api/admin/mapping', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, mapping, reverse_mapping: buildReverseMapping(mapping) }),
    });
    mappingDocument = { mapping: data.mapping, reverse_mapping: data.reverse_mapping };
    renderMappingRows(data.mapping);
    setMessage(byId('mappingMessage'), '');
    toast(`Mapping enregistré · ${Object.keys(data.mapping).length} entrée(s)`);
    await loadRepositoryHistory({ quiet: true });
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function rebuildMapping() {
  const button = byId('rebuildMapping');
  button.disabled = true;
  setMessage(byId('mappingMessage'), 'Régénération depuis les scans PII…');
  try {
    const data = await api('/api/admin/mapping/rebuild', {
      method: 'POST',
      body: JSON.stringify({ case: selectedFolder }),
    });
    mappingDocument = { mapping: data.mapping, reverse_mapping: data.reverse_mapping };
    byId('mappingDialogTitle').textContent = data.name;
    renderMappingRows(data.mapping);
    setMessage(byId('mappingMessage'), `${data.added} entrée(s) ajoutée(s), ${data.total} au total.`);
    await loadRepositoryHistory({ quiet: true });
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
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

    const selected = revision.files.find((file) => file.path === revision.selectedPath);
    const totals = revision.files.reduce((sum, file) => ({
      added: sum.added + (Number.isFinite(file.added) ? file.added : 0),
      deleted: sum.deleted + (Number.isFinite(file.deleted) ? file.deleted : 0),
    }), { added: 0, deleted: 0 });
    byId('diffFile').textContent = revision.selectedPath || `${revision.files.length} fichier${revision.files.length > 1 ? 's' : ''}`;
    byId('diffStats').textContent = selected && selected.added != null
      ? `+${selected.added}  −${selected.deleted}`
      : !revision.selectedPath && (totals.added || totals.deleted)
        ? `+${totals.added}  −${totals.deleted}`
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

let repositoryRefreshInFlight = false;

async function loadRepositoryHistory({ quiet = false } = {}) {
  if (repositoryRefreshInFlight) return;
  repositoryRefreshInFlight = true;
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
  } finally {
    repositoryRefreshInFlight = false;
  }
}

async function selectHistoryFolder(folder) {
  selectedFolder = folder;
  selectedRevision = null;
  selectedOriginals = new Set();
  if (originalsJob?.case !== folder) showOriginalsProgress('');
  updateCaseToolbar();
  renderFolders();
  await loadHistoryItems();
}

// L'administration n'est servie qu'en local (cf. isLocalOrigin côté serveur) :
// le poste du navigateur est celui du serveur, la détection sert donc juste à
// nommer les boutons comme le système de l'utilisateur.
function desktopPlatform() {
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '');
  if (/mac|iphone|ipad/i.test(platform)) return 'mac';
  if (/win/i.test(platform)) return 'windows';
  return 'other';
}

const FILE_MANAGER_LABELS = { mac: 'Afficher dans le Finder', windows: 'Afficher dans l’Explorateur', other: 'Afficher le dossier' };
const TERMINAL_LABELS = { mac: 'Ouvrir dans le Terminal', windows: 'Ouvrir dans le terminal', other: 'Ouvrir dans le terminal' };

function labelFolderActions() {
  const platform = desktopPlatform();
  byId('revealFolder').textContent = FILE_MANAGER_LABELS[platform];
  byId('openTerminal').textContent = TERMINAL_LABELS[platform];
}

async function revealCaseFolder(target, button) {
  const previous = button.textContent;
  button.disabled = true;
  try {
    const result = await api('/api/admin/reveal', {
      method: 'POST',
      body: JSON.stringify({ target, case: selectedFolder || '' }),
    });
    toast(target === 'terminal' ? `Terminal ouvert · ${result.path}` : `Dossier affiché · ${result.path}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function updateCaseToolbar() {
  const legalCase = currentCase();
  byId('repositoryName').textContent = legalCase?.name || 'Aucun dossier';
  byId('repositoryPath').textContent = repositoryData?.root || '—';
  byId('repositoryBranch').textContent = 'Commits du dossier';
  byId('repositoryHead').textContent = legalCase?.shortHead || 'Aucun';
  byId('createCommit').disabled = !legalCase;
  const hasRoot = Boolean(repositoryData?.root);
  byId('revealFolder').disabled = !hasRoot;
  byId('openTerminal').disabled = !hasRoot;
  const scope = legalCase ? `le dossier « ${legalCase.name} »` : 'la racine PieceMaker';
  byId('revealFolder').title = `Afficher ${scope} dans le gestionnaire de fichiers`;
  byId('openTerminal').title = `Ouvrir un terminal dans ${scope}`;
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
byId('revealFolder').addEventListener('click', (event) => revealCaseFolder('files', event.currentTarget));
byId('openTerminal').addEventListener('click', (event) => revealCaseFolder('terminal', event.currentTarget));
labelFolderActions();
byId('createCommit').addEventListener('click', createManualCommit);
byId('restoreRevision').addEventListener('click', restoreSelectedRevision);
byId('selectAllOriginals').addEventListener('change', (event) => {
  selectedOriginals = event.currentTarget.checked ? new Set(caseOriginals().map((original) => original.path)) : new Set();
  renderOriginals();
});
byId('convertOriginals').addEventListener('click', () => startOriginalsPipeline('convert'));
byId('anonymizeOriginals').addEventListener('click', () => startOriginalsPipeline('anonymize'));
byId('openMapping').addEventListener('click', openMappingDialog);
byId('addMappingRow').addEventListener('click', () => addMappingEntry('', '', { focus: true }));
byId('rebuildMapping').addEventListener('click', rebuildMapping);
byId('saveMapping').addEventListener('click', saveMapping);
byId('closeMapping').addEventListener('click', () => byId('mappingDialog').close());

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

// Un agent se règle autrement qu'un skill : il déclare le modèle qui
// l'exécute et les outils auxquels il a droit, et sa description sert à
// décider quand le déléguer.
function openCreateDialog(kind) {
  const dialog = byId('createFileDialog');
  const isAgent = kind === 'agent';
  byId('createFileForm').reset();
  byId('createFileKind').value = kind;
  byId('createFileTitle').textContent = isAgent ? 'Créer un agent' : 'Créer un skill';
  byId('createAgentFields').hidden = !isAgent;
  byId('createFileTools').disabled = !isAgent;
  byId('createFileModel').disabled = !isAgent;
  byId('createFileSlug').placeholder = isAgent ? 'analyste-piece' : 'analyse-contrat';
  byId('createFileDescription').placeholder = isAgent
    ? 'Quand déléguer cette tâche à l’agent, et ce qu’il doit renvoyer.'
    : 'Quand et pourquoi Claude doit utiliser ce skill.';
  byId('createFileHint').textContent = isAgent
    ? 'L’agent sera enregistré dans Claude Code et lançable comme sous-agent.'
    : 'Le skill sera enregistré dans Claude Code et déclenché selon sa description.';
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
    const label = form.get('kind') === 'skill' ? 'Skill' : 'Agent';
    toast(['linked', 'copied'].includes(result.file.claudeCode?.state)
      ? `${label} créé et enregistré dans Claude Code`
      : `${label} créé — enregistrement Claude Code à vérifier`);
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
byId('tamponImageInput').addEventListener('change', handleTamponImageUpload);
byId('buildTamponBtn').addEventListener('click', buildTampon);
byId('saveTamponBtn').addEventListener('click', saveTampon);
byId('clearTamponBtn').addEventListener('click', clearTampon);
byId('refreshDossiers').addEventListener('click', loadDossiers);
byId('dossierSelect').addEventListener('change', () => {
  selectedPieces = [];
  byId('workingFolder').value = currentDossier()?.folder || '';
  renderPieces();
});
byId('workingFolder').addEventListener('input', renderPieces);
byId('stampPiecesBtn').addEventListener('click', stampPieces);
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
byId('syncClaudeAssets').addEventListener('click', syncClaudeAssets);
byId('cancelCreateFile').addEventListener('click', () => byId('createFileDialog').close());
window.addEventListener('beforeunload', (event) => {
  if (selectedFile && editorTouched) event.preventDefault();
});

const requestedTab = location.hash.slice(1);
setActiveTab(['history', 'settings', 'pieces', 'telegram', 'files'].includes(requestedTab) ? requestedTab : 'history');
loadStatus();

const REPOSITORY_REFRESH_MS = 30000;

async function scheduleRepositoryRefresh() {
  if (document.visibilityState === 'visible' && byId('history').classList.contains('active')) {
    await loadRepositoryHistory({ quiet: true });
  }
  setTimeout(scheduleRepositoryRefresh, REPOSITORY_REFRESH_MS);
}

setTimeout(scheduleRepositoryRefresh, REPOSITORY_REFRESH_MS);

import {
  joinMarkdownDocument,
  markdownToHtml,
  splitMarkdownDocument,
  visualEditorToMarkdown,
} from './markdown.mjs';
import {
  PROCEDURE_POSITIONS,
  applyProcedureParties,
  buildMappingDocument,
  groupMappingByCode,
  normalizeProcedureInfo,
  principalPartyOptions,
  procedureSummary,
} from './mapping-model.mjs';
import { drawStamp } from './stamp-builder.mjs';

// ---------------------------------------------------------------------------
// CENTRALIZED LOGGING SYSTEM & LOG VIEWER INTEGRATION
// ---------------------------------------------------------------------------
const DEBUG = true;
const MAX_LOG_ENTRIES = 1000;
window.__PM_LOGS = window.__PM_LOGS || [];

function logToViewer(level, source, message, data = null) {
  const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
  const entry = { id: Date.now() + Math.random(), timestamp, level, source, message, data };
  
  window.__PM_LOGS.push(entry);
  if (window.__PM_LOGS.length > MAX_LOG_ENTRIES) {
    window.__PM_LOGS.shift();
  }

  // Render to viewer if present
  const logContainer = document.getElementById('debugLogContainer');
  if (logContainer) {
    const row = document.createElement('div');
    row.className = `log-row log-${level.toLowerCase()}`;
    const payloadStr = data !== null ? ` | ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
    row.textContent = `[${timestamp}] [${source}] [${level}] ${message}${payloadStr}`;
    logContainer.appendChild(row);
    if (document.getElementById('debugAutoScroll')?.checked) {
      logContainer.scrollTop = logContainer.scrollHeight;
    }
  }

  // Console output
  const prefix = `[PM-DEBUG][${source}]`;
  if (level === 'WARN') console.warn(prefix, message, data || '');
  else if (level === 'ERROR') console.error(prefix, message, data || '');
  else if (DEBUG) console.log(prefix, message, data || '');
}

const dlog = (source, msg, data) => logToViewer('INFO', source, msg, data);
const dwarn = (source, msg, data) => logToViewer('WARN', source, msg, data);
const derror = (source, msg, data) => logToViewer('ERROR', source, msg, data);

// Helper to wrap sync/async operations with high-precision timing
async function traceAsync(name, fn, thresholdMs = 300) {
  const t0 = performance.now();
  dlog(name, 'START execution');
  try {
    const res = await fn();
    const elapsed = performance.now() - t0;
    dlog(name, `FINISHED in ${elapsed.toFixed(2)}ms`);
    if (elapsed > thresholdMs) {
      dwarn(name, `SLOW EXECUTION DETECTED — took ${elapsed.toFixed(2)}ms (threshold: ${thresholdMs}ms)`);
    }
    return res;
  } catch (err) {
    const elapsed = performance.now() - t0;
    derror(name, `FAILED after ${elapsed.toFixed(2)}ms — ${err.message}`, err);
    throw err;
  }
}

let __apiCallCount = 0;
let __apiInFlight = 0;

const api = async (url, options = {}) => {
  const callId = ++__apiCallCount;
  __apiInFlight += 1;
  const method = options.method || 'GET';
  const t0 = performance.now();
  dlog('api', `api#${callId}: START ${method} ${url} (inFlight=${__apiInFlight})`);
  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    const elapsed = performance.now() - t0;
    const serverTiming = response.headers.get('Server-Timing') || '';
    const serverTimingSuffix = serverTiming ? `, server=${serverTiming}` : '';
    dlog('api', `api#${callId}: DONE ${method} ${url} status=${response.status} (${elapsed.toFixed(2)}ms${serverTimingSuffix})`);
    if (elapsed > 800) dwarn('api', `SLOW API CALL — ${method} ${url} took ${elapsed.toFixed(2)}ms`);
    if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
    return data;
  } catch (error) {
    const elapsed = performance.now() - t0;
    derror('api', `api#${callId}: ERROR ${method} ${url} after ${elapsed.toFixed(2)}ms — ${error.message}`);
    throw error;
  } finally {
    __apiInFlight -= 1;
  }
};

const byId = (id) => document.getElementById(id);
const ADMIN_THEME_STORAGE_KEY = 'piecemaker-admin-theme';
let selectedFile = null;
let currentFrontMatter = '';
let editorTouched = false;
let filesLoaded = false;
let historyLoaded = false;
let configurationLoaded = false;
let configurationData = null;
let configurationDetailOrigin = null;
let repositoryData = null;
let historyItems = [];
let selectedFolder = '';
let historyView = 'changes';
let selectedRevision = null;
let revisionRequestSerial = 0;
let tamponImage = null;
let dossiers = [];
let selectedPieces = [];
let selectedOriginals = new Set();
// « pending » ne montre que ce qui reste à convertir ou à scanner ; « all »
// montre tout le dossier, sous-dossiers compris, ce qui est indispensable pour
// décider de la protection d'une pièce déjà traitée.
let originalsScope = 'all';
let originalsJob = null;
let originalsJobTimer = null;
let mappingDocument = null;
let procedureMappingSource = null;
let procedurePartyCounter = 0;
let detailView = 'diff';
let caseTelegram = null;
let caseTelegramFolder = '';

function normalizedAdminTheme(value) {
  return value === 'dark' ? 'dark' : 'light';
}

function applyAdminTheme(value, { cache = true } = {}) {
  const theme = normalizedAdminTheme(value);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0d1117' : '#ffffff');
  const toggle = byId('adminDarkMode');
  if (toggle) toggle.checked = theme === 'dark';
  const label = byId('adminThemeValue');
  if (label) label.textContent = theme === 'dark' ? 'Mode sombre' : 'Mode clair';
  if (cache) {
    try { localStorage.setItem(ADMIN_THEME_STORAGE_KEY, theme); } catch {}
  }
  return theme;
}

async function loadAdminTheme() {
  try {
    const data = await api('/api/admin/settings');
    applyAdminTheme(data.config.adminTheme);
  } catch {
    // Le thème mis en cache reste utilisable si le serveur redémarre.
  }
}

async function saveAdminTheme(event) {
  const toggle = event.currentTarget;
  const previous = normalizedAdminTheme(document.documentElement.dataset.theme);
  const theme = toggle.checked ? 'dark' : 'light';
  const message = byId('adminThemeMessage');
  applyAdminTheme(theme);
  toggle.disabled = true;
  setMessage(message, 'Enregistrement…');
  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ config: { adminTheme: theme } }),
    });
    setMessage(message, 'Thème enregistré.', 'success');
  } catch (error) {
    applyAdminTheme(previous);
    setMessage(message, error.message, 'error');
  } finally {
    toggle.disabled = false;
  }
}

function toast(message) {
  const element = byId('toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 2800);
}

function setMessage(element, message = '', kind = '') {
  if (!element) return;
  element.textContent = message;
  element.className = `message ${kind}`.trim();
}

function setActiveTab(name) {
  dlog('ui', `setActiveTab triggered -> '${name}'`);
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === name));
  if (name === 'configuration' && !configurationLoaded) loadConfiguration();
  if (name === 'settings') loadSettings();
  if (name === 'history' && !historyLoaded) loadRepositoryHistory();
  if (name === 'pieces') loadPieces();
  if (name === 'telegram') loadTelegram();
  if (name === 'files' && !filesLoaded) {
    loadFiles({ selectPath: new URLSearchParams(location.search).get('file') });
  }
}

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
  return traceAsync('loadTampon', async () => {
    try {
      const response = await fetch('/api/tampon/load');
      if (!response.ok) return showTampon(null);
      const result = await response.json();
      showTampon(result.tamponImage || null);
      byId('saveTamponBtn').disabled = true;
    } catch (error) {
      showTampon(null);
    }
  });
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

function buildTampon({ announce = true } = {}) {
  const t0 = performance.now();
  dlog('buildTampon', 'Generating canvas tampon');
  const canvas = document.createElement('canvas');
  drawStamp(canvas, {
    topText: byId('tamponTop').value,
    bottomText: byId('tamponBottom').value,
    shape: byId('tamponShape').value,
    border: byId('tamponBorder').value,
    font: byId('tamponFont').value,
    color: byId('tamponColor').value,
    lineWidth: byId('tamponLineWidth').value,
  });

  showTampon(canvas.toDataURL('image/png'));
  byId('tamponLineWidthValue').textContent = `${byId('tamponLineWidth').value} px`;
  if (announce) {
    setMessage(byId('tamponMessage'), 'Tampon haute définition généré — le numéro de pièce s’imprimera au centre.');
  }
  dlog('buildTampon', `Completed in ${(performance.now() - t0).toFixed(2)}ms`);
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
  const t0 = performance.now();
  const dossier = currentDossier();
  const list = byId('piecesList');
  const folderInput = byId('workingFolder');
  list.innerHTML = '';
  if (dossier && !folderInput.value) folderInput.value = dossier.folder || '';
  byId('stampedDir').textContent = folderInput.value
    ? `${folderInput.value}/Pièces tamponnées`
    : 'dossier de travail à renseigner';

  if (!dossier) {
    list.innerHTML = '<p class="muted">Aucun dossier enregistré ne contient de pièce. Enregistrez un dossier juridique depuis l’onglet « Dossiers ».</p>';
    byId('stampPiecesBtn').disabled = true;
    return;
  }

  const docCount = dossier.documents?.length || 0;
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
  const elapsed = performance.now() - t0;
  dlog('renderPieces', `Rendered ${docCount} pieces in ${elapsed.toFixed(2)}ms`);
  if (elapsed > 100) dwarn('renderPieces', `Slow pieces DOM rendering: ${elapsed.toFixed(2)}ms`);
}

function togglePiece(id) {
  const index = selectedPieces.indexOf(id);
  if (index >= 0) selectedPieces.splice(index, 1);
  else selectedPieces.push(id);
  renderPieces();
}

async function loadDossiers() {
  return traceAsync('loadDossiers', async () => {
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
  });
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
  return traceAsync('loadStatus', async () => {
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
  });
}

async function loadSettings() {
  return traceAsync('loadSettings', async () => {
    const message = byId('settingsMessage');
    setMessage(message, 'Chargement…');
    try {
      const data = await api('/api/admin/settings');
      byId('port').value = data.config.port || 43098;
      byId('pythonPath').value = data.config.pythonPath || data.env.PYTHON_PATH || '';
      applyAdminTheme(data.config.adminTheme);
      byId('commitUserName').value = data.env.PIECEMAKER_USER_NAME || '';
      byId('legifranceEnv').value = 'production';
      document.querySelectorAll('[data-secret-state]').forEach((element) => {
        const state = data.secrets[element.dataset.secretState];
        element.textContent = state?.configured ? `Déjà configurée (${state.hint})` : 'Non configurée';
      });
      loadInstitutionalTerms();
      setMessage(message);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const message = byId('settingsMessage');
  const button = event.submitter || formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(message, 'Enregistrement…');
  const form = new FormData(formElement);
  const env = {
    PIECEMAKER_USER_NAME: String(form.get('PIECEMAKER_USER_NAME') || '').trim(),
  };
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
          port: Number(form.get('port')),
          pythonPath: form.get('pythonPath'),
          adminTheme: byId('adminDarkMode').checked ? 'dark' : 'light',
        },
        env,
      }),
    });
    formElement.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
    await loadSettings();
    setMessage(message, 'Enregistré. L’identité sera appliquée dès le prochain commit ; redémarrez le serveur pour les autres changements.', 'success');
    toast('Paramètres enregistrés');
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ── Carte visuelle de configuration ─────────────────────────────────────────

function formatConfigurationBytes(value) {
  const bytes = Number(value) || 0;
  if (!bytes) return 'taille inconnue';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const rank = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: rank > 2 ? 1 : 0 }).format(bytes / (1024 ** rank))} ${units[rank]}`;
}

function componentState(element, component, { configurable = false } = {}) {
  const optional = Boolean(component.optional);
  const needsConfiguration = (configurable || optional) && component.installed && component.configured === false;
  let cls, label;
  if (!component.installed) { cls = optional ? 'warn' : 'error'; label = optional ? 'Optionnel · absent' : 'Non installé'; }
  else if (needsConfiguration) { cls = 'warn'; label = 'À configurer'; }
  else { cls = 'ok'; label = 'Actif'; }
  element.className = `component-state ${cls}`;
  element.replaceChildren(makeElement('i'), document.createTextNode(label));
}

const CONFIGURABLE_COMPONENTS = new Set(['mcp', 'telegram']);

function renderConfigurationComponent(key, component) {
  const node = document.querySelector(`[data-config-component="${key}"]`);
  if (!node || !component) return;
  node.classList.remove('loading', 'installed', 'missing', 'optional-off');
  if (component.installed) node.classList.add('installed');
  else node.classList.add(component.optional ? 'optional-off' : 'missing');
  if (key === 'client') byId('configurationClientName').textContent = component.name;
  const cap = key[0].toUpperCase() + key.slice(1);
  const summaryEl = byId(`configuration${cap}Summary`);
  if (summaryEl) summaryEl.textContent = component.summary;
  const statusEl = byId(`configuration${cap}Status`);
  if (statusEl) componentState(statusEl, component, { configurable: CONFIGURABLE_COMPONENTS.has(key) });
}

function renderConfigurationModels(models) {
  const list = byId('configurationModelList');
  list.textContent = '';
  byId('configurationOllamaVersion').textContent = models.version ? `v${models.version}` : '';
  byId('configurationModelCount').textContent = String(models.items.length);
  if (!models.installed) {
    list.append(makeElement('div', 'configuration-empty', 'Ollama n’est pas démarré ou n’est pas installé sur ce poste.'));
    return;
  }
  if (!models.items.length) {
    list.append(makeElement('div', 'configuration-empty', 'Ollama est actif, mais aucun modèle local n’est installé.'));
    return;
  }
  for (const model of models.items) {
    const button = makeElement('button', 'configuration-model-row');
    button.type = 'button';
    button.dataset.model = model.name;
    button.title = `Vérifier les mises à jour de ${model.name}`;
    const mark = makeElement('span', 'model-mark', 'OL');
    const copy = makeElement('span', 'configuration-row-copy');
    copy.append(
      makeElement('strong', '', model.name),
      makeElement('span', '', [model.parameterSize, model.quantization, formatConfigurationBytes(model.size)].filter(Boolean).join(' · ')),
    );
    const state = makeElement('span', 'model-check-state', 'Vérifier la MAJ');
    button.append(mark, copy, state);
    button.addEventListener('click', () => checkConfigurationModel(model, button, state));
    list.append(button);
  }
}

async function checkConfigurationModel(model, button, state) {
  if (button.disabled) return;
  button.disabled = true;
  state.textContent = 'Vérification…';
  state.className = 'model-check-state checking';
  try {
    const result = await api('/api/admin/configuration/models/check', {
      method: 'POST',
      body: JSON.stringify({ model: model.name }),
    });
    const labels = { current: 'À jour', update: 'MAJ disponible', unknown: 'Indéterminé' };
    state.textContent = labels[result.status] || 'Vérifié';
    state.className = `model-check-state ${result.status === 'unknown' ? 'error' : result.status}`;
    button.title = result.message;
    toast(`${model.name} · ${result.message}`);
  } catch (error) {
    state.textContent = 'Échec';
    state.className = 'model-check-state error';
    button.title = error.message;
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderConfigurationFolders(folders) {
  const list = byId('configurationFolderList');
  list.textContent = '';
  byId('configurationFolderCount').textContent = String(folders.length);
  if (!folders.length) {
    list.append(makeElement('div', 'configuration-empty', 'Aucun dossier enregistré. Ajoutez-en un depuis l’onglet Dossiers.'));
    return;
  }
  for (const folder of folders) {
    const button = makeElement('button', 'configuration-folder-row');
    button.type = 'button';
    const copy = makeElement('span', 'configuration-row-copy');
    copy.append(makeElement('strong', '', folder.name), makeElement('span', '', folder.path));
    const bot = makeElement('span', `folder-bot ${folder.bot?.configured ? 'configured' : ''} ${folder.bot?.running ? 'running' : ''}`.trim());
    bot.append(makeElement('span', '', folder.bot?.configured ? folder.bot.name : 'Telegram non associé'));
    button.append(copy, bot, makeElement('span', 'folder-row-arrow', '›'));
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'configurationDetail');
    button.addEventListener('click', () => openConfigurationDetail('folder', folder.id, button));
    list.append(button);
  }
}

function renderConfiguration(data) {
  configurationData = data;
  const models = data.models || { installed: false, items: [], version: '' };
  // Ollama : nœud synthétique dérivé de la liste des modèles locaux.
  data.components.ollama = {
    name: 'Ollama',
    installed: models.installed,
    configured: true,
    summary: models.installed
      ? `${models.items.length} modèle${models.items.length > 1 ? 's' : ''}${models.version ? ` · v${models.version}` : ''}`
      : 'Ollama non démarré',
    version: models.version,
    count: models.items.length,
  };
  for (const key of ['client', 'terminal', 'mcp', 'telegram', 'hooks', 'gliner', 'mineru', 'ollama']) {
    renderConfigurationComponent(key, data.components[key]);
  }
  renderConfigurationModels(models);
  renderConfigurationFolders(data.folders);
  byId('configurationMap').setAttribute('aria-busy', 'false');
}

async function loadConfiguration({ quiet = false } = {}) {
  const button = byId('refreshConfiguration');
  button.disabled = true;
  if (!quiet) {
    byId('configurationMap').setAttribute('aria-busy', 'true');
    for (const node of document.querySelectorAll('[data-config-component]')) node.classList.add('loading');
  }
  try {
    const data = await api('/api/admin/configuration');
    renderConfiguration(data);
    configurationLoaded = true;
  } catch (error) {
    byId('configurationMap').setAttribute('aria-busy', 'false');
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

function appendConfigurationDetails(container, rows, title = 'Détails') {
  const section = makeElement('section', 'configuration-detail-section');
  section.append(makeElement('h3', '', title));
  const list = makeElement('ul', 'configuration-detail-list');
  for (const [label, value] of rows) {
    const item = document.createElement('li');
    item.append(makeElement('span', '', label), makeElement('strong', '', String(value || '—')));
    list.append(item);
  }
  section.append(list);
  container.append(section);
}

function configurationStatus(component, { configurable = false } = {}) {
  const wrapper = makeElement('div', 'configuration-detail-status');
  wrapper.append(makeElement('strong', '', 'État de la brique'));
  const state = makeElement('span');
  componentState(state, component, { configurable });
  wrapper.append(state);
  return wrapper;
}

function addConfigurationAction(label, tab, { primary = false, beforeNavigate = null } = {}) {
  const button = makeElement('button', `button ${primary ? 'primary' : 'secondary'}`, label);
  button.type = 'button';
  button.addEventListener('click', () => {
    if (beforeNavigate) beforeNavigate();
    closeConfigurationDetail();
    setActiveTab(tab);
    history.replaceState(null, '', `#${tab}`);
  });
  byId('configurationDetailActions').append(button);
}

// Bouton du détail ouvrant un autre nœud de la carte (sans changer d'onglet).
function addConfigurationLink(label, kind, { primary = false } = {}) {
  const button = makeElement('button', `button ${primary ? 'primary' : 'secondary'}`, label);
  button.type = 'button';
  button.addEventListener('click', () => openConfigurationDetail(kind));
  byId('configurationDetailActions').append(button);
}

// Les formulaires Paramètres / Telegram / termes institutionnels vivent dans la
// fenêtre de configuration : on déplace l'élément existant (ses écouteurs restent liés) puis
// on le remet à sa place d'origine à la fermeture.
let mountedConfigurationForm = null;

function mountConfigurationForm(elementId, loader) {
  const el = byId(elementId);
  if (!el) return;
  mountedConfigurationForm = { el, parent: el.parentNode, next: el.nextSibling };
  el.classList.add('in-configuration-detail');
  byId('configurationDetailBody').append(el);
  if (typeof loader === 'function') { try { loader(); } catch { /* rechargé au prochain refresh */ } }
}

function restoreConfigurationForm() {
  if (!mountedConfigurationForm) return;
  const { el, parent, next } = mountedConfigurationForm;
  el.classList.remove('in-configuration-detail');
  if (next && next.parentNode === parent) parent.insertBefore(el, next);
  else parent.append(el);
  mountedConfigurationForm = null;
}

const CONFIGURATION_DESCRIPTIONS = {
  client: 'Pilote le projet et charge le plugin PieceMaker. Réglages généraux, signature des commits et identifiants Légifrance ci-dessous.',
  terminal: 'Shell local interactif ouvert depuis le volet Word, dans le contexte du dossier actif.',
  mcp: 'Relie le client aux outils documentaires PieceMaker et à la recherche juridique Légifrance.',
  telegram: 'Deux bots séparés — un Assistant conversationnel et une surveillance sans LLM — chacun avec son propre token BotFather.',
  gliner: 'Détection PII locale (Presidio + GLiNER2). Construit le mapping du dossier. Aucune donnée ne quitte le poste.',
  mineru: 'OCR local pour les PDF scannés et les images. Optionnel : les PDF texte passent par markitdown.',
  ollama: 'Modèles LLM exécutés localement (analyse, embeddings). Aucune requête vers un service distant.',
  docs: 'Les pièces restent sur le disque avec leurs vrais noms. Les hooks ne recodent que ce que le modèle lit ; aucun fichier n’est réécrit.',
  hooks: 'La barrière entre le modèle et le dossier. À chaque lecture, les noms deviennent des codes ; à chaque écriture, les codes redeviennent des noms.',
};
const CONFIGURATION_TITLES = {
  client: 'Client IA & Paramètres', terminal: 'Terminal', mcp: 'MCP locaux', telegram: 'Telegram',
  gliner: 'GLiNER · détection PII', mineru: 'MinerU · OCR', ollama: 'Ollama · modèles locaux',
  docs: 'Dossier & pièces', hooks: 'Hooks — barrière d’anonymisation',
};

// Détail visuel du rôle des hooks à la lecture / écriture des documents.
function appendConfigurationHooksFlow(container) {
  const section = makeElement('section', 'configuration-detail-section');
  section.append(makeElement('h3', '', 'À chaque accès du modèle'));
  const flow = makeElement('div', 'configuration-hooks-flow');
  const steps = [
    ['read', 'Lecture d’une pièce', 'Jean Dupont', 'PERSONNE_1', 'Le modèle ne reçoit que des codes.'],
    ['write', 'Écriture / réponse', 'PERSONNE_1', 'Jean Dupont', 'Le dossier récupère les vrais noms.'],
  ];
  for (const [dir, title, from, to, note] of steps) {
    const row = makeElement('div', `configuration-hook-step ${dir}`);
    row.append(makeElement('strong', '', title));
    const line = makeElement('div', 'configuration-hook-line');
    line.append(
      makeElement('span', `cfg-chip ${dir === 'read' ? 'name' : 'code'}`, from),
      makeElement('span', 'cfg-arrow', '→'),
      makeElement('span', `cfg-chip ${dir === 'read' ? 'code' : 'name'}`, to),
    );
    row.append(line, makeElement('span', 'configuration-hook-note', note));
    flow.append(row);
  }
  section.append(flow);
  container.append(section);
}

function openConfigurationDetail(kind, reference = '', origin = null) {
  if (!configurationData) return;
  restoreConfigurationForm();
  const detail = byId('configurationDetail');
  const body = byId('configurationDetailBody');
  const actions = byId('configurationDetailActions');
  body.textContent = '';
  actions.textContent = '';
  document.querySelectorAll('[aria-controls="configurationDetail"]').forEach((node) => {
    node.classList.remove('active');
  });
  const selectedNode = origin || document.querySelector(`[data-config-component="${kind}"]`);
  if (!detail.open) configurationDetailOrigin = selectedNode || document.activeElement;
  selectedNode?.classList.add('active');

  if (kind === 'folder') {
    const folder = configurationData.folders.find((entry) => entry.id === reference);
    if (!folder) return;
    byId('configurationDetailEyebrow').textContent = 'DOSSIER JURIDIQUE';
    byId('configurationDetailTitle').textContent = folder.name;
    body.append(configurationStatus({ installed: true }), makeElement('p', 'configuration-detail-description', 'Dossier enregistré dans PieceMaker. Son Assistant Telegram reste isolé des autres dossiers.'));
    appendConfigurationDetails(body, [
      ['Emplacement', folder.path],
      ['Bot Telegram', folder.bot?.configured ? folder.bot.name : 'Non associé'],
      ['État du bot', folder.bot?.running ? 'Actif' : folder.bot?.configured ? 'Arrêté' : 'À configurer'],
    ]);
    addConfigurationAction('Ouvrir le dossier', 'history', {
      primary: true,
      beforeNavigate: () => {
        selectedFolder = folder.id;
        if (historyLoaded) void selectHistoryFolder(folder.id);
      },
    });
  } else if (kind === 'docs') {
    byId('configurationDetailEyebrow').textContent = 'SUR LE DISQUE';
    byId('configurationDetailTitle').textContent = CONFIGURATION_TITLES.docs;
    body.append(makeElement('p', 'configuration-detail-description', CONFIGURATION_DESCRIPTIONS.docs));
    appendConfigurationDetails(body, [
      ['Pièces originales', 'Protégées par défaut'],
      ['Markdown / JSON', 'Anonymisés à la volée'],
      ['Réécriture disque', 'Jamais'],
    ]);
    addConfigurationAction('Voir les dossiers', 'history', { primary: true });
  } else {
    const component = configurationData.components[kind];
    if (!component) return;
    byId('configurationDetailEyebrow').textContent = 'COMPOSANT';
    byId('configurationDetailTitle').textContent = CONFIGURATION_TITLES[kind] || component.name;
    body.append(configurationStatus(component, { configurable: CONFIGURABLE_COMPONENTS.has(kind) }), makeElement('p', 'configuration-detail-description', CONFIGURATION_DESCRIPTIONS[kind] || component.summary));

    if (kind === 'client') {
      appendConfigurationDetails(body, [
        ['Client détecté', component.name],
        ['Plugin PieceMaker', component.pluginInstalled ? `Installé${component.pluginVersion ? ` · v${component.pluginVersion}` : ''}` : 'Non installé'],
      ]);
      if (component.clients.length > 1) appendConfigurationDetails(body, component.clients.map((client) => [client.name, client.version || 'Détecté']), 'Clients détectés');
      mountConfigurationForm('settingsConfigurationGroup', loadSettings);
      addConfigurationAction('Skills et agents', 'files', { primary: true });
    } else if (kind === 'terminal') {
      appendConfigurationDetails(body, [['Shell', component.shell], ['Transport', 'PTY local chiffré via WebSocket']]);
      addConfigurationAction('Voir les dossiers', 'history', { primary: true });
    } else if (kind === 'hooks') {
      appendConfigurationHooksFlow(body);
      appendConfigurationDetails(body, [
        ['Garde-fous présents', `${component.count}/5`],
        ['Déclencheurs', 'Lecture · écriture · arrêt de session'],
        ['Fichiers sur disque', 'Jamais modifiés'],
      ]);
      addConfigurationAction('Voir le plugin', 'files', { primary: true });
    } else if (kind === 'gliner') {
      appendConfigurationDetails(body, [
        ['Moteur', component.installed ? (component.engine || '—') : 'Non installé'],
        ['Accélération', component.coreml ? 'GPU CoreML' : 'CPU (torch)'],
        ['Réseau', 'Aucun — 100 % local'],
      ]);
      if (component.installed) mountConfigurationForm('institutionalTermsCard', loadInstitutionalTerms);
      else appendInstallAction(body, 'gliner');
    } else if (kind === 'mineru') {
      appendConfigurationDetails(body, [
        ['Rôle', 'OCR PDF scannés / images'],
        ['Statut', component.installed ? 'Installé' : 'Optionnel · non installé'],
      ]);
      if (!component.installed) appendInstallAction(body, 'mineru');
    } else if (kind === 'ollama') {
      appendConfigurationDetails(body, [
        ['Version', component.version ? `v${component.version}` : 'Indéterminée'],
        ['Modèles locaux', String(component.count || 0)],
      ]);
    } else if (kind === 'telegram') {
      if (Array.isArray(component.bots)) {
        const section = makeElement('section', 'configuration-detail-section');
        section.append(makeElement('h3', '', 'Bots'));
        for (const bot of component.bots) {
          const service = makeElement('div', 'configuration-service');
          service.append(
            makeElement('strong', '', bot.name || bot.role),
            makeElement('span', `component-state ${bot.running ? 'ok' : bot.configured ? 'warn' : 'error'}`, bot.running ? 'En ligne' : bot.configured ? 'Arrêté' : 'À configurer'),
            makeElement('p', '', bot.role),
          );
          section.append(service);
        }
        body.append(section);
      }
      mountConfigurationForm('telegramConfigurationGroup', loadTelegram);
    } else if (kind === 'mcp') {
      const section = makeElement('section', 'configuration-detail-section');
      section.append(makeElement('h3', '', 'Serveurs disponibles'));
      for (const item of component.items) {
        const service = makeElement('div', 'configuration-service');
        service.append(
          makeElement('strong', '', item.name),
          makeElement('span', `component-state ${item.installed && item.configured ? 'ok' : item.installed ? 'warn' : 'error'}`, item.installed ? item.configured ? 'Prêt' : 'À configurer' : 'Absent'),
          makeElement('p', '', item.detail),
        );
        section.append(service);
      }
      body.append(section);
      addConfigurationLink('Identifiants Légifrance', 'client', { primary: true });
    }
  }

  if (!detail.open) detail.showModal();
  byId('configurationDetailTitle').focus({ preventScroll: true });
}

function closeConfigurationDetail() {
  if (installPollTimer) { clearTimeout(installPollTimer); installPollTimer = null; }
  restoreConfigurationForm();
  const detail = byId('configurationDetail');
  if (detail.open) detail.close();
  document.querySelectorAll('[aria-controls="configurationDetail"]').forEach((node) => {
    node.classList.remove('active');
  });
  configurationDetailOrigin?.focus?.();
  configurationDetailOrigin = null;
}

// Bloc « Installer » d'un moteur local absent (GLiNER / MinerU) : lance l'étape
// d'installateur côté serveur puis suit sa progression sans quitter la page.
let installPollTimer = null;

const INSTALL_HINTS = {
  gliner: 'Le modèle d’anonymisation (~400 Mo) sera téléchargé. L’installation continue même si vous fermez cette fenêtre.',
  mineru: 'MinerU est volumineux (plusieurs centaines de Mo). L’installation continue même si vous fermez cette fenêtre.',
};

function appendInstallAction(body, kind) {
  const section = makeElement('section', 'configuration-detail-section configuration-install');
  section.append(makeElement('p', 'configuration-install-note', INSTALL_HINTS[kind] || ''));
  const button = makeElement('button', 'button primary', 'Installer');
  button.type = 'button';
  const progress = makeElement('p', 'configuration-install-progress');
  progress.hidden = true;
  button.addEventListener('click', () => startComponentInstall(kind, button, progress));
  section.append(button, progress);
  body.append(section);
}

async function startComponentInstall(kind, button, progress) {
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = 'Installation…';
  progress.hidden = false;
  progress.className = 'configuration-install-progress running';
  progress.textContent = 'Démarrage…';
  try {
    const { job } = await api('/api/admin/configuration/install', {
      method: 'POST',
      body: JSON.stringify({ component: kind }),
    });
    pollComponentInstall(job.id, kind, button, progress);
  } catch (error) {
    progress.className = 'configuration-install-progress error';
    progress.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Réessayer';
    toast(error.message);
  }
}

function pollComponentInstall(id, kind, button, progress) {
  const tick = async () => {
    try {
      const { job } = await api(`/api/admin/configuration/install?id=${encodeURIComponent(id)}`);
      progress.textContent = job.progress || 'Installation en cours…';
      if (job.state === 'running') { installPollTimer = setTimeout(tick, 2500); return; }
      if (job.state === 'done') {
        progress.className = 'configuration-install-progress ok';
        progress.textContent = 'Installé.';
        toast(`${CONFIGURATION_TITLES[kind] || kind} · installé.`);
        await loadConfiguration({ quiet: true });
        closeConfigurationDetail();
      } else {
        progress.className = 'configuration-install-progress error';
        progress.textContent = job.error || 'Échec de l’installation.';
        button.disabled = false;
        button.textContent = 'Réessayer';
        toast(job.error || 'Échec de l’installation.');
      }
    } catch (error) {
      progress.className = 'configuration-install-progress error';
      progress.textContent = error.message;
      button.disabled = false;
      button.textContent = 'Réessayer';
    }
  };
  tick();
}

// ── Entités institutionnelles à ne jamais anonymiser ─────────────────────────
let institutionalTerms = [];

/** Forme comparable côté client (casse et accents ignorés) — miroir du serveur. */
function normalizeTermKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function renderInstitutionalTerms() {
  const list = byId('institutionalTermsList');
  list.textContent = '';
  if (!institutionalTerms.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Aucun terme. Ajoutez les juridictions et institutions à préserver.';
    list.append(empty);
    return;
  }
  for (const term of institutionalTerms) {
    const chip = document.createElement('span');
    chip.className = 'term-chip';
    const label = document.createElement('span');
    label.textContent = term;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Retirer « ${term} »`;
    remove.setAttribute('aria-label', `Retirer ${term}`);
    remove.addEventListener('click', () => {
      institutionalTerms = institutionalTerms.filter((entry) => entry !== term);
      renderInstitutionalTerms();
    });
    chip.append(label, remove);
    list.append(chip);
  }
}

function addInstitutionalTermFromInput() {
  const input = byId('institutionalTermInput');
  const value = input.value.replace(/\s+/g, ' ').trim();
  if (!value) return;
  const key = normalizeTermKey(value);
  if (institutionalTerms.some((term) => normalizeTermKey(term) === key)) {
    setMessage(byId('institutionalTermsMessage'), 'Ce terme est déjà dans la liste.');
  } else {
    institutionalTerms.push(value);
    institutionalTerms.sort((a, b) => normalizeTermKey(a).localeCompare(normalizeTermKey(b), 'fr'));
    renderInstitutionalTerms();
    setMessage(byId('institutionalTermsMessage'), 'Terme ajouté — pensez à enregistrer.');
  }
  input.value = '';
  input.focus();
}

async function loadInstitutionalTerms() {
  const message = byId('institutionalTermsMessage');
  try {
    const data = await api('/api/admin/institutional-terms');
    institutionalTerms = Array.isArray(data.terms) ? data.terms : [];
    renderInstitutionalTerms();
    setMessage(message);
  } catch (error) {
    setMessage(message, error.message, 'error');
  }
}

async function saveInstitutionalTerms() {
  const message = byId('institutionalTermsMessage');
  const button = byId('saveInstitutionalTerms');
  button.disabled = true;
  setMessage(message, 'Enregistrement…');
  try {
    const data = await api('/api/admin/institutional-terms', {
      method: 'PUT',
      body: JSON.stringify({ terms: institutionalTerms }),
    });
    institutionalTerms = Array.isArray(data.terms) ? data.terms : institutionalTerms;
    renderInstitutionalTerms();
    setMessage(message, `${institutionalTerms.length} terme(s) enregistré(s). Appliqué immédiatement, sans redémarrage.`, 'success');
    toast('Liste enregistrée');
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

/**
 * Sépare les trailers techniques `PieceMaker-*` du corps d'un commit.
 * Renvoie le commentaire nettoyé, l'identifiant de session et le temps de
 * session écoulé sous sa forme lisible (ex. « 5 min 07 s »).
 */
function parsePieceMakerTrailers(body) {
  const lines = String(body || '').split('\n');
  const kept = [];
  let sessionId = '';
  let elapsed = '';
  for (const line of lines) {
    const session = line.match(/^PieceMaker-Session:\s*(.+)$/);
    if (session) { sessionId = session[1].trim(); continue; }
    const time = line.match(/^PieceMaker-Temps-Session:\s*(.+?)(?:\s*\(\d+\s*ms\))?\s*$/);
    if (time) { elapsed = time[1].trim(); continue; }
    kept.push(line);
  }
  return { comment: kept.join('\n').trim(), sessionId, elapsed };
}

function renderDossierBots(dossiers, capabilities) {
  const t0 = performance.now();
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
  dlog('renderDossierBots', `Rendered ${dossiers.length} dossiers in ${(performance.now() - t0).toFixed(2)}ms`);
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
  return traceAsync('loadTelegram', async () => {
    const message = byId('telegramMessage');
    if (!quiet) setMessage(message, 'Chargement…');
    try {
      const data = await api('/api/admin/telegram');
      renderTelegram(data);
      if (!quiet) setMessage(message);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  });
}

async function saveTelegram(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  const button = event.submitter || formElement.querySelector('button[type="submit"]');
  const message = byId('telegramMessage');
  const form = new FormData(formElement);
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
    formElement.querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
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
    const adopted = result.adopted ? `, dont ${result.adopted} repris d’une autre installation` : '';
    setMessage(message, `${result.registered} skill(s)/agent(s) enregistré(s)${adopted}${conflicts}.`, conflicts ? 'error' : 'success');
    toast('Skills et agents synchronisés avec Claude Code');
  } catch (error) {
    setMessage(message, error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Pop-up « Ajouter le plugin legal Claude » (bouton de l'onglet Skills et
// agents). Deux onglets :
//  - « Plugin PieceMaker » : installe/rafraîchit le plugin puis enregistre
//    auprès de Claude Code les skills et agents cochés (arborescence
//    repliable — voir GET/POST /api/admin/plugin/{components,install}).
//  - « Marketplace officiel » : parcourt/recherche les plugins-connecteurs
//    des marketplaces Claude Code déjà enregistrées sur ce poste (hors
//    PieceMaker) et installe/active/désactive la sélection — voir
//    GET /api/admin/plugin/marketplace et POST .../marketplace/{register,install}.
//    Claude Code n'expose aucune recherche distante (pas de sous-commande
//    `claude plugin search`) : la recherche ci-dessous filtre côté client la
//    liste déjà renvoyée par le serveur, elle-même déjà limitée à ce que la
//    CLI a listé localement — voir le commentaire de listMarketplaceConnectors
//    dans admin-routes.cjs pour le détail de cette limite.
// ---------------------------------------------------------------------------

/**
 * Arborescence repliable générique (native <details>/<summary>, sans
 * dépendance externe) : une racine par groupe (kind, ou marketplace),
 * feuilles cochables en dessous. La case du groupe est tri-state — cochée si
 * tous ses éléments sélectionnables le sont, indéterminée si certains
 * seulement, décochée sinon — et bascule tous ses éléments d'un coup. Les
 * lignes réutilisent .original-row/.original-body/.original-badges pour garder
 * une présentation compacte. Construit une fois par rafraîchissement
 * de données ; les cases individuelles mettent seulement à jour leurs
 * propres éléments DOM, donc l'état replié/déplié de chaque groupe survit
 * aux clics sur les cases (pas de reconstruction du DOM à chaque coche).
 * `groups` : [{ label, items: [{ id, name, description, disabled,
 * disabledTitle, hint, badge: {text, className}|null, badgeTitle }] }].
 * `selected` : Set mutée en place. `onSelectionChange` : rappelé après
 * chaque coche (groupe ou feuille).
 */
function buildComponentTree(groups, selected, onSelectionChange) {
  const fragment = document.createDocumentFragment();
  for (const group of groups) {
    if (!group.items.length) continue;
    const details = document.createElement('details');
    details.className = 'plugin-tree-node';
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'plugin-tree-summary';
    const groupCheckbox = document.createElement('input');
    groupCheckbox.type = 'checkbox';
    groupCheckbox.setAttribute('aria-label', `Tout sélectionner : ${group.label}`);
    summary.append(groupCheckbox, makeElement('span', '', group.label), makeElement('span', 'count-badge', String(group.items.length)));
    details.append(summary);

    const children = makeElement('div', 'plugin-tree-children');
    const itemRows = [];
    const refreshGroupCheckbox = () => {
      const selectable = group.items.filter((item) => !item.disabled);
      const checkedCount = selectable.filter((item) => selected.has(item.id)).length;
      groupCheckbox.disabled = selectable.length === 0;
      groupCheckbox.checked = selectable.length > 0 && checkedCount === selectable.length;
      groupCheckbox.indeterminate = checkedCount > 0 && checkedCount < selectable.length;
    };

    for (const item of group.items) {
      const selectable = !item.disabled;
      const row = document.createElement('label');
      row.className = `original-row${selected.has(item.id) ? ' selected' : ''}`;
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.has(item.id);
      checkbox.disabled = !selectable;
      checkbox.title = selectable ? (item.hint || '') : (item.disabledTitle || 'Non modifiable ici.');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        row.classList.toggle('selected', checkbox.checked);
        refreshGroupCheckbox();
        onSelectionChange();
      });
      itemRows.push({ item, checkbox, row });
      const body = makeElement('span', 'original-body');
      body.append(makeElement('strong', '', item.name), makeElement('span', '', item.description || item.id));
      const badges = makeElement('span', 'original-badges');
      if (item.badge) {
        const span = makeElement('span', `asset-badge ${item.badge.className || ''}`.trim(), item.badge.text);
        if (item.badgeTitle) span.title = item.badgeTitle;
        badges.append(span);
      }
      row.append(checkbox, body, badges);
      children.append(row);
    }

    // La case du groupe est dans <summary> : sans stopPropagation, la cocher
    // rouvrirait/refermerait aussi le <details> (comportement natif du clic).
    groupCheckbox.addEventListener('click', (event) => event.stopPropagation());
    groupCheckbox.addEventListener('change', () => {
      for (const { item, checkbox, row } of itemRows) {
        if (item.disabled) continue;
        checkbox.checked = groupCheckbox.checked;
        if (groupCheckbox.checked) selected.add(item.id);
        else selected.delete(item.id);
        row.classList.toggle('selected', checkbox.checked);
      }
      onSelectionChange();
    });
    refreshGroupCheckbox();

    details.append(children);
    fragment.append(details);
  }
  return fragment;
}

const MARKETPLACE_BADGES = {
  active: { text: 'Actif', className: 'ok' },
  installed: { text: 'Installé · désactivé', className: 'warn' },
};

// Contrôleur générique d'un onglet marketplace du pop-up. Deux instances (voir
// plus bas) : « legal » ↔ marketplace anthropics/claude-for-legal (plugins
// juridiques par domaine), « official » ↔ anthropics/claude-plugins-official
// (marketplace généraliste). Chaque instance porte son propre état et ses
// propres éléments DOM, donc les deux onglets sont indépendants. Coché =
// connecteur actif (installé + activé) ; décocher désactive (jamais désinstallé,
// choix réversible côté serveur). La recherche filtre localement — Claude Code
// n'expose aucune recherche distante. `scope` est transmis au serveur pour
// borner l'énumération et l'installation au seul marketplace de l'onglet.
function createMarketplaceController({ scope, ids, labels }) {
  let data = null;
  let selected = new Set();
  let searchQuery = '';
  const msg = () => byId('pluginComponentsMessage');

  function treeGroups() {
    const plugins = data?.plugins || [];
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? plugins.filter((plugin) => plugin.name.toLowerCase().includes(query) || (plugin.description || '').toLowerCase().includes(query))
      : plugins;
    const byMarketplace = new Map();
    for (const plugin of filtered) {
      const key = plugin.marketplace || labels.marketplaceName;
      if (!byMarketplace.has(key)) byMarketplace.set(key, []);
      byMarketplace.get(key).push(plugin);
    }
    return Array.from(byMarketplace.entries()).map(([marketplaceName, items]) => ({
      label: marketplaceName,
      items: items
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          description: plugin.description || (plugin.installCount ? `${plugin.installCount} installation(s)` : ''),
          disabled: false,
          hint: 'Installer/activer (ou désactiver) ce connecteur',
          badge: plugin.installed ? (plugin.enabled ? MARKETPLACE_BADGES.active : MARKETPLACE_BADGES.installed) : null,
        })),
    }));
  }

  function render() {
    const container = byId(ids.list);
    container.textContent = '';
    const groups = treeGroups();
    if (!groups.length) {
      container.append(createHistoryEmpty(
        searchQuery ? 'Aucun résultat' : 'Aucun connecteur disponible',
        searchQuery ? 'Essayez un autre terme.' : labels.emptyHint,
      ));
      return;
    }
    container.append(buildComponentTree(groups, selected, () => {}));
  }

  async function load() {
    byId(ids.list).textContent = 'Chargement…';
    byId(ids.status).textContent = 'Chargement…';
    byId(ids.registerBtn).hidden = true;
    try {
      data = await api(`/api/admin/plugin/marketplace?scope=${scope}`);
      // Idempotent : ré-ouvrir reflète l'état réel — coché = déjà actif
      // (installé et activé) au chargement.
      selected = new Set(data.plugins.filter((plugin) => plugin.installed && plugin.enabled).map((plugin) => plugin.id));
      byId(ids.status).textContent = data.registered
        ? `Marketplace « ${data.marketplaceName} » enregistré.${data.reason ? ` ${data.reason}` : ''}`
        : labels.notRegistered;
      byId(ids.registerBtn).hidden = data.registered;
      render();
    } catch (error) {
      byId(ids.list).textContent = '';
      setMessage(msg(), error.message, 'error');
    }
  }

  async function registerMarketplace() {
    const button = byId(ids.registerBtn);
    button.disabled = true;
    setMessage(msg(), `Enregistrement du marketplace « ${labels.marketplaceName} »…`);
    try {
      const result = await api('/api/admin/plugin/marketplace/register', { method: 'POST', body: JSON.stringify({ scope }) });
      if (result.ok) {
        setMessage(msg(), `Marketplace « ${labels.marketplaceName} » enregistré.`, 'success');
        await load();
      } else {
        setMessage(msg(), result.reason || 'Échec de l’enregistrement du marketplace.', 'error');
      }
    } catch (error) {
      setMessage(msg(), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function applySelection() {
    const button = byId(ids.applyBtn);
    button.disabled = true;
    setMessage(msg(), 'Installation/activation en cours (peut prendre quelques secondes)…');
    try {
      const result = await api('/api/admin/plugin/marketplace/install', {
        method: 'POST',
        body: JSON.stringify({ scope, plugins: Array.from(selected) }),
      });
      const failed = result.failed?.length ? ` — ${result.failed.length} échec(s)` : '';
      setMessage(
        msg(),
        `${result.installed} installé(s), ${result.enabled} activé(s), ${result.disabled} désactivé(s)${failed}.`,
        failed ? 'error' : 'success',
      );
      await load();
      if (!failed) toast('Plugins Claude Code mis à jour');
    } catch (error) {
      setMessage(msg(), error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  return {
    reset() {
      data = null;
      selected = new Set();
      searchQuery = '';
      const search = byId(ids.search);
      if (search) search.value = '';
    },
    ensureLoaded() { if (!data) void load(); },
    setSearch(value) { searchQuery = value; render(); },
    registerMarketplace,
    applySelection,
  };
}

const legalMarketplace = createMarketplaceController({
  scope: 'legal',
  ids: { list: 'legalList', status: 'legalStatus', registerBtn: 'registerLegalMarketplace', search: 'legalSearch', applyBtn: 'applyLegalComponents' },
  labels: {
    marketplaceName: 'claude-for-legal',
    notRegistered: 'Le plugin legal Claude n’est pas encore enregistré sur ce poste — cliquez sur « Découvrir le plugin legal Claude » pour récupérer le catalogue.',
    emptyHint: 'Le marketplace « claude-for-legal » est enregistré mais son catalogue est vide.',
  },
});

const officialMarketplace = createMarketplaceController({
  scope: 'official',
  ids: { list: 'marketplaceList', status: 'marketplaceStatus', registerBtn: 'registerOfficialMarketplace', search: 'marketplaceSearch', applyBtn: 'applyMarketplaceComponents' },
  labels: {
    marketplaceName: 'claude-plugins-official',
    notRegistered: 'Le marketplace officiel Claude Code n’est pas encore enregistré — cliquez sur « Découvrir le marketplace officiel ».',
    emptyHint: 'Le marketplace « claude-plugins-official » est enregistré mais son catalogue est vide.',
  },
});

function switchPluginTab(tab) {
  const isOfficial = tab === 'official';
  byId('pluginTabButtonLegal').classList.toggle('active', !isOfficial);
  byId('pluginTabButtonLegal').setAttribute('aria-selected', String(!isOfficial));
  byId('pluginTabButtonOfficial').classList.toggle('active', isOfficial);
  byId('pluginTabButtonOfficial').setAttribute('aria-selected', String(isOfficial));
  byId('pluginTabLegal').hidden = isOfficial;
  byId('pluginTabOfficial').hidden = !isOfficial;
  setMessage(byId('pluginComponentsMessage'));
  (isOfficial ? officialMarketplace : legalMarketplace).ensureLoaded();
}

function openPluginComponentsDialog() {
  const dialog = byId('pluginComponentsDialog');
  legalMarketplace.reset();
  officialMarketplace.reset();
  byId('pluginDialogStatus').textContent = 'Installez les plugins juridiques Claude ou parcourez le marketplace officiel.';
  setMessage(byId('pluginComponentsMessage'));
  switchPluginTab('legal');
  dialog.showModal();
}

function fileGroupLabel(kind) {
  return { instructions: 'Instructions', agent: 'Collabs IA (Agents)', skill: 'Compétences (skills PieceMaker)', 'official-skill': 'Compétences (Skills Marketplace Claude)' }[kind] || kind;
}

async function loadFiles({ selectPath = null } = {}) {
  return traceAsync('loadFiles', async () => {
    const list = byId('fileList');
    list.textContent = 'Chargement…';
    try {
      const { files } = await api('/api/admin/files');
      list.textContent = '';
      for (const kind of ['instructions', 'agent', 'skill', 'official-skill']) {
        const groupFiles = files.filter((file) => file.kind === kind);
        if (!groupFiles.length) continue;
        const heading = document.createElement('div');
        heading.className = 'file-group';
        heading.append(makeElement('span', 'file-group-title', fileGroupLabel(kind)));
        if (kind === 'skill' || kind === 'agent') {
          const createLabel = kind === 'agent' ? 'Créer un agent' : 'Créer un skill';
          const createButton = document.createElement('button');
          createButton.type = 'button';
          createButton.className = 'file-group-add';
          createButton.dataset.createKind = kind;
          createButton.textContent = '+';
          createButton.title = createLabel;
          createButton.setAttribute('aria-label', createLabel);
          createButton.addEventListener('click', () => openCreateDialog(kind));
          heading.append(createButton);
        }
        list.append(heading);
        for (const file of groupFiles) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `file-button${file.exists ? '' : ' missing'}`;
          button.dataset.path = file.path;
          button.append(makeElement('span', 'file-button-label', file.exists ? file.name : `${file.name} — créer`));
          if (file.kind === 'official-skill') {
            // Skill fourni par un plugin de marketplace installé : lecture
            // seule, badge indiquant son plugin d'origine.
            const badge = makeElement('span', 'asset-badge ok', 'Officiel');
            badge.title = file.marketplace ? `${file.plugin} · ${file.marketplace}` : file.plugin || 'Plugin installé';
            button.append(badge);
          }
          button.addEventListener('click', () => selectFile(file, button));

          if (file.kind !== 'skill') {
            list.append(button);
            continue;
          }

          // Un skill obtient une rangée dédiée (bouton + suppression du skill
          // entier) : le contrôle de suppression est un élément frère du
          // bouton, jamais imbriqué dedans (bouton dans bouton = HTML invalide).
          const row = document.createElement('div');
          row.className = 'file-row';
          row.append(button);
          if (file.exists) {
            const removeSkill = document.createElement('button');
            removeSkill.type = 'button';
            removeSkill.className = 'file-row-delete';
            removeSkill.textContent = '×';
            removeSkill.title = 'Supprimer ce skill';
            removeSkill.setAttribute('aria-label', 'Supprimer ce skill');
            removeSkill.addEventListener('click', (event) => {
              event.stopPropagation();
              deleteSkillFromPanel(file);
            });
            row.append(removeSkill);
          }
          list.append(row);

          // Annexes (assets/scripts) du skill, indentées en dessous — nom
          // seul affiché, le chemin ne sert qu'à l'appel de suppression.
          if (Array.isArray(file.assets) && file.assets.length) {
            const assetList = document.createElement('div');
            assetList.className = 'file-assets';
            for (const asset of file.assets) {
              const assetRow = document.createElement('div');
              assetRow.className = 'file-asset';
              assetRow.append(makeElement('span', 'file-asset-name', asset.name));
              const removeAsset = document.createElement('button');
              removeAsset.type = 'button';
              removeAsset.className = 'file-asset-delete';
              removeAsset.textContent = '×';
              removeAsset.title = 'Supprimer ce fichier';
              removeAsset.setAttribute('aria-label', 'Supprimer ce fichier');
              removeAsset.addEventListener('click', (event) => {
                event.stopPropagation();
                deleteSkillAsset(asset);
              });
              assetRow.append(removeAsset);
              assetList.append(assetRow);
            }
            list.append(assetList);
          }
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
  });
}

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
  const t0 = performance.now();
  const editorElem = byId('fileEditor');
  const markdownContent = visualEditorToMarkdown(editorElem);
  const result = joinMarkdownDocument(currentFrontMatter, metadataValues(), markdownContent);
  dlog('currentMarkdown', `Built Markdown content (${result.length} chars) in ${(performance.now() - t0).toFixed(2)}ms`);
  return result;
}

function markEditorDirty() {
  if (!selectedFile || selectedFile.readonly) return;
  editorTouched = true;
  byId('dirtyBadge').hidden = false;
}

async function selectFile(file, button) {
  return traceAsync(`selectFile(${file.name})`, async () => {
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
      byId('editorToolbar').classList.remove('is-floating');
      editor.contentEditable = String(!data.readonly);
      editor.classList.toggle('empty', !documentParts.body.trim());
      byId('editorToolbar').hidden = data.readonly;
      // L'ajout d'un fichier annexe (asset/script) suppose un dossier propre :
      // seuls les skills en ont un. Instructions, agents et fichiers en lecture
      // seule n'exposent pas le bouton.
      byId('insertAssetBtn').hidden = data.readonly || data.kind !== 'skill' || !data.exists;
      byId('saveFile').disabled = data.readonly;
      // Suppression réservée aux skills et agents du dépôt qui existent déjà —
      // ni instructions, ni skills officiels, ni fichiers en lecture seule.
      byId('deleteFile').hidden = !(data.exists && !data.readonly && (data.kind === 'skill' || data.kind === 'agent'));
      byId('metadataEditor').hidden = !documentParts.frontMatter || data.readonly || data.kind === 'instructions';
      byId('metadataName').value = documentParts.metadata.name || '';
      byId('metadataDescription').value = documentParts.metadata.description || '';
      const isAgent = data.kind === 'agent';
      byId('metadataModelField').hidden = !isAgent;
      byId('metadataToolsField').hidden = !isAgent;
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
  });
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
    // Changer le champ « nom » renomme le dossier/fichier côté serveur : on
    // adopte le nouveau chemin (sinon un second enregistrement écrirait vers
    // l'ancien emplacement, désormais absent) et on rafraîchit la liste.
    const renamed = result.path && result.path !== selectedFile.path;
    if (result.path) {
      selectedFile.path = result.path;
      selectedFile.exists = true;
      byId('filePath').textContent = result.path;
    }
    setMessage(byId('fileMessage'), renamed ? 'Renommé et enregistré.' : result.backup ? 'Enregistré avec sauvegarde.' : 'Fichier créé.', 'success');
    toast(renamed ? 'Skill/agent renommé' : 'Fichier Markdown enregistré');
    if (renamed) await loadFiles({ selectPath: result.path });
  } catch (error) {
    setMessage(byId('fileMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// Ramène le panneau d'édition à son état vide (« aucun fichier sélectionné ») —
// factorisé pour être partagé entre la suppression depuis l'éditeur
// (deleteFile) et celle depuis le panneau de gauche (deleteSkillFromPanel),
// qui peut viser un skill non sélectionné.
function resetFileEditor() {
  byId('fileTitle').textContent = 'Sélectionnez un fichier';
  byId('filePath').textContent = '';
  byId('fileEditor').innerHTML = '';
  byId('fileEditor').contentEditable = 'false';
  byId('editorToolbar').hidden = true;
  byId('metadataEditor').hidden = true;
  byId('saveFile').disabled = true;
  byId('deleteFile').hidden = true;
  byId('dirtyBadge').hidden = true;
}

async function deleteFile() {
  if (!selectedFile || selectedFile.readonly || !selectedFile.exists) return;
  if (!['skill', 'agent'].includes(selectedFile.kind)) return;
  const label = selectedFile.kind === 'skill' ? 'ce skill' : 'cet agent';
  if (!confirm(`Supprimer définitivement ${label} « ${selectedFile.name || selectedFile.path} » ?\nUne sauvegarde est conservée, mais le fichier disparaît de Claude Code.`)) return;
  const button = byId('deleteFile');
  button.disabled = true;
  setMessage(byId('fileMessage'), 'Suppression…');
  try {
    await api(`/api/admin/file?path=${encodeURIComponent(selectedFile.path)}`, { method: 'DELETE' });
    editorTouched = false;
    selectedFile = null;
    toast('Fichier supprimé');
    resetFileEditor();
    await loadFiles();
    setMessage(byId('fileMessage'), 'Fichier supprimé.', 'success');
  } catch (error) {
    setMessage(byId('fileMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

// Suppression d'un skill directement depuis le panneau « Skills et agents »,
// indépendamment du fichier actuellement ouvert dans l'éditeur (contrairement
// à deleteFile(), qui n'agit que sur selectedFile).
async function deleteSkillFromPanel(file) {
  if (!confirm(`Supprimer définitivement ce skill « ${file.name || file.path} » ?\nUne sauvegarde est conservée, mais le fichier disparaît de Claude Code.`)) return;
  try {
    await api(`/api/admin/file?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
    toast('Skill supprimé');
    if (selectedFile?.path === file.path) {
      editorTouched = false;
      selectedFile = null;
      resetFileEditor();
    }
    await loadFiles();
  } catch (error) {
    toast(error.message);
  }
}

// Suppression d'une seule annexe (asset/script) d'un skill, sans toucher au
// reste du dossier ni à la sélection courante dans l'éditeur.
async function deleteSkillAsset(asset) {
  if (!confirm(`Supprimer définitivement le fichier « ${asset.name} » ?\nUne sauvegarde est conservée.`)) return;
  try {
    await api(`/api/admin/asset?path=${encodeURIComponent(asset.path)}`, { method: 'DELETE' });
    toast('Fichier supprimé');
    await loadFiles({ selectPath: selectedFile?.path || null });
  } catch (error) {
    toast(error.message);
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
  const t0 = performance.now();
  const select = byId('caseSelect');
  select.textContent = '';
  const folders = repositoryData?.folders || [];
  const duplicateNames = new Map();
  for (const folder of folders) duplicateNames.set(folder.name, (duplicateNames.get(folder.name) || 0) + 1);
  if (!folders.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Aucun dossier';
    select.append(option);
  }
  for (const folder of folders) {
    const option = document.createElement('option');
    option.value = folder.path;
    const name = duplicateNames.get(folder.name) > 1 && folder.location
      ? `${folder.name} — ${folder.location}`
      : folder.name;
    option.textContent = folder.changes ? `${name} (${folder.changes})` : name;
    select.append(option);
  }
  // La valeur active est synchronisée une fois la liste complète insérée : le
  // menu natif conserve ainsi une option distincte pour chaque dossier.
  select.value = selectedFolder;
  select.disabled = !folders.length;
  renderOriginals();
  dlog('renderFolders', `Rendered ${folders.length} folders in ${(performance.now() - t0).toFixed(2)}ms`);
}

function caseOriginals() {
  return currentCase()?.originals || [];
}

function formatBytes(size) {
  const value = Number(size) || 0;
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toFixed(1)} Mo`;
}

function pendingOriginals() {
  return caseOriginals().filter((original) => !original.converted || !original.scanned);
}

function visibleOriginals() {
  return originalsScope === 'all' ? caseOriginals() : pendingOriginals();
}

/**
 * Bascule de protection. L'état complet est renvoyé au serveur à chaque clic :
 * `protection.json` ne stocke que les exceptions, donc la liste des pièces
 * laissées accessibles est la seule chose à écrire.
 */
async function toggleProtection(original, button) {
  const unprotected = caseOriginals()
    .filter((file) => (file.path === original.path ? original.protected : !file.protected))
    .map((file) => file.path);
  button.disabled = true;
  try {
    await api('/api/admin/protection', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, unprotected }),
    });
    original.protected = !original.protected;
    toast(original.protected ? 'Pièce protégée' : 'Pièce accessible à l’IA');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    renderOriginals();
  }
}

function shieldButton(original) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `shield-toggle ${original.protected ? 'on' : 'off'}`;
  button.textContent = original.protected ? '🛡 Protégé' : '🔓 Accessible';
  button.title = original.protected
    ? 'L’IA ne peut pas ouvrir cette pièce. Cliquez pour la lui rendre accessible.'
    : 'L’IA peut ouvrir cette pièce. Cliquez pour la protéger.';
  button.addEventListener('click', (event) => {
    // La ligne est un <label> : sans ça, le clic cocherait aussi la sélection.
    event.preventDefault();
    event.stopPropagation();
    toggleProtection(original, button);
  });
  return button;
}

function originalStatusBadge(className, label) {
  const badge = document.createElement('span');
  badge.className = `protection-badge ${className}`;
  badge.textContent = label;
  return badge;
}

function statusLabel(original) {
  if (!original.converted) return 'Non converti';
  return original.scanned ? 'Converti et analysé' : 'Converti, analyse PII en attente';
}

function renderOriginals() {
  const t0 = performance.now();
  const mosaic = byId('originalMosaic');
  const originals = visibleOriginals().slice().sort((a, b) => {
    if (a.protected !== b.protected) return a.protected ? 1 : -1;
    return a.path.localeCompare(b.path, 'fr');
  });
  mosaic.textContent = '';
  if (historyView === 'protected') {
    byId('historyCount').textContent = `${originals.length} pièce${originals.length > 1 ? 's' : ''}`;
    byId('originalsViewCount').textContent = String(originals.length);
  }
  for (const button of document.querySelectorAll('.scope-button')) {
    button.classList.toggle('active', button.dataset.scope === originalsScope);
  }

  // La sélection pilote le pipeline, qui ne porte que sur les pièces non
  // traitées : la restreindre à celles-là évite de lancer une conversion sur
  // une pièce cochée dans la vue « Toutes » puis devenue à jour.
  const known = new Set(pendingOriginals().map((original) => original.path));
  for (const selected of [...selectedOriginals]) {
    if (!known.has(selected)) selectedOriginals.delete(selected);
  }

  if (!selectedFolder) {
    mosaic.append(createHistoryEmpty('Sélectionnez un dossier'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }
  if (!originals.length) {
    mosaic.append(originalsScope === 'all'
      ? createHistoryEmpty('Aucune pièce', 'Ce dossier ne contient aucun document hors Markdown.')
      : createHistoryEmpty('Toutes les pièces sont traitées', 'Basculez sur « Toutes » pour gérer leur protection.'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }

  const fragment = document.createDocumentFragment();
  const groups = [
    { protected: false, label: 'Accessibles à l’IA', icon: '🔓', className: 'accessible' },
    { protected: true, label: 'Pièces protégées', icon: '🛡', className: 'protected' },
  ];
  for (const group of groups) {
    const groupOriginals = originals.filter((original) => original.protected === group.protected);
    const column = document.createElement('section');
    column.className = `original-mosaic-column ${group.className}`;
    const heading = document.createElement('header');
    heading.className = 'original-mosaic-heading';
    const headingLabel = document.createElement('strong');
    headingLabel.textContent = `${group.icon} ${group.label}`;
    const headingCount = document.createElement('span');
    headingCount.className = 'count-badge';
    headingCount.textContent = String(groupOriginals.length);
    heading.append(headingLabel, headingCount);
    const cards = document.createElement('div');
    cards.className = 'original-card-grid';
    for (const original of groupOriginals) {
      const selectable = known.has(original.path);
      const row = document.createElement('label');
      row.className = `original-card ${group.className}${selectedOriginals.has(original.path) ? ' selected' : ''}`;
      const controls = document.createElement('span');
      controls.className = 'original-card-controls';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedOriginals.has(original.path);
      checkbox.disabled = !selectable;
      checkbox.title = selectable ? 'Sélectionner pour la conversion ou l’analyse' : 'Pièce déjà convertie et analysée';
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedOriginals.add(original.path);
        else selectedOriginals.delete(original.path);
        row.classList.toggle('selected', checkbox.checked);
        updateOriginalsActions();
      });
      controls.append(checkbox, shieldButton(original));
      const body = document.createElement('span');
      body.className = 'original-body';
      const name = document.createElement('strong');
      name.textContent = original.path;
      const detail = document.createElement('span');
      detail.textContent = `${formatBytes(original.size)} · ${statusLabel(original)}`;
      body.append(name, detail);
      const badges = document.createElement('span');
      badges.className = 'original-badges';
      if (original.converted) badges.append(originalStatusBadge('converted', 'Converti'));
      if (original.scanned) badges.append(originalStatusBadge('scanned', 'Anonymisé'));
      row.append(controls, body, badges);
      cards.append(row);
    }
    if (!groupOriginals.length) {
      const empty = document.createElement('p');
      empty.className = 'original-column-empty';
      empty.textContent = group.protected ? 'Aucune pièce protégée' : 'Aucune pièce accessible';
      cards.append(empty);
    }
    column.append(heading, cards);
    fragment.append(column);
  }
  mosaic.append(fragment);
  updateOriginalsActions();
  renderMappingSummary();
  dlog('renderOriginals', `Rendered ${originals.length} originals in ${(performance.now() - t0).toFixed(2)}ms`);
}

function originalsToProcess() {
  const pending = pendingOriginals();
  if (!selectedOriginals.size) return pending.map((original) => original.path);
  return pending.filter((original) => selectedOriginals.has(original.path)).map((original) => original.path);
}

function updateOriginalsActions() {
  const pending = pendingOriginals();
  // Un traitement en file d'attente occupe l'interface au même titre qu'un
  // traitement en cours : les boutons restent désactivés jusqu'à sa fin.
  const running = Boolean(originalsJob && ['running', 'queued'].includes(originalsJob.state));
  const count = originalsToProcess().length;
  const selectAll = byId('selectAllOriginals');
  selectAll.disabled = running || !pending.length;
  selectAll.checked = Boolean(pending.length) && selectedOriginals.size === pending.length;
  selectAll.indeterminate = selectedOriginals.size > 0 && selectedOriginals.size < pending.length;
  // Sans case cochée les boutons portent sur tout le dossier et ne refont que
  // ce qui manque ; cocher des pièces revient à demander leur retraitement.
  const suffix = selectedOriginals.size ? ` (${count} sélectionnée${count > 1 ? 's' : ''})` : ' (tout le dossier)';
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
  const phase = { convert: 'Conversion', scan: 'Analyse PII', mapping: 'Mise à jour du mapping', commit: 'Enregistrement du commit' }[job.phase] || 'Traitement';
  if (job.state === 'queued') {
    const ahead = (job.queuePosition || 1) - 1;
    return ahead > 0
      ? `En file d'attente · ${ahead} traitement${ahead > 1 ? 's' : ''} devant`
      : 'En file d\'attente · démarrage imminent';
  }
  if (job.state === 'running') return `${phase} · ${job.processed}/${job.total} · ${job.percent}%`;
  if (job.state === 'error') return `Échec : ${job.error}`;
  const result = job.result || {};
  if (result.upToDate) {
    return job.action === 'convert'
      ? `Rien à convertir : les ${result.skipped} pièce(s) ont déjà leur Markdown.`
      : `Rien à analyser : les ${result.skipped} pièce(s) sont déjà scannées.`;
  }
  const untouched = result.skipped ? ` · ${result.skipped} déjà à jour` : '';
  const committed = result.commit?.created ? ' · commit enregistré' : '';
  return job.action === 'convert'
    ? `${result.converted || job.total} pièce(s) converties en Markdown${untouched}${committed}.`
    : `${result.scanned || job.total} pièce(s) analysées · ${result.mappingAdded || 0} entrée(s) ajoutée(s) au mapping${untouched}${committed}.`;
}

async function startOriginalsPipeline(action) {
  if (!selectedFolder) return;
  const files = originalsToProcess();
  if (!files.length) return;
  clearTimeout(originalsJobTimer);
  dlog('pipeline', `Starting pipeline '${action}' on ${files.length} files`);
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
    // On continue à sonder tant que le traitement est en cours OU en file : le
    // passage de « en attente » à « en cours » se fait côté serveur.
    if (job.state === 'running' || job.state === 'queued') {
      originalsJobTimer = setTimeout(pollOriginalsJob, 1500);
      return;
    }
    updateOriginalsActions();
    toast(job.state === 'error' ? 'Traitement interrompu' : job.result?.commit?.created ? 'Traitement terminé et commité' : 'Traitement terminé');
    await loadSelectedCase({ quiet: true });
  } catch (error) {
    showOriginalsProgress(error.message, 'error');
    originalsJob = null;
    updateOriginalsActions();
  }
}

function renderMappingSummary() {
  const legalCase = currentCase();
  const button = byId('openMapping');
  // `/api/admin/repository` ne joint au dossier que le nombre d'entrées : le
  // contenu du mapping ne circule que par `/api/admin/mapping`, à l'ouverture
  // de l'éditeur. Compter les clés d'un `mapping` absent affichait « 0 entrée »
  // même sur un dossier entièrement mappé.
  const entries = legalCase?.mapping?.entries || 0;
  byId('mappingCount').textContent = String(entries);
  byId('mappingState').textContent = !legalCase
    ? 'Sélectionnez un dossier'
    : legalCase.mapping?.exists
      ? `${entries} entrée(s) · cliquez pour modifier`
      : 'Aucun fichier — lancez « Anonymiser et mapper »';
  button.disabled = !legalCase;
}

function renderProcedureSummary() {
  const summary = procedureSummary(mappingDocument?.informations_dossier);
  const renderSide = (id, names) => {
    const element = byId(id);
    element.textContent = names.length ? names.join(' · ') : 'À renseigner';
    element.classList.toggle('empty', !names.length);
  };
  renderSide('procedureClientSummary', summary.client);
  renderSide('procedureAdverseSummary', summary.adverse);
}

function procedurePartyList(side) {
  return byId(side === 'client' ? 'clientParties' : 'adverseParties');
}

function refreshEmptyProcedureList(side) {
  const list = procedurePartyList(side);
  const rows = list.querySelectorAll('.procedure-party-item');
  list.querySelector('.procedure-party-empty')?.remove();
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'procedure-party-empty';
    empty.textContent = side === 'client' ? 'Aucune partie cliente.' : 'Aucune partie adverse.';
    list.append(empty);
  }
}

function fillPartyDatalist(datalist, type) {
  datalist.textContent = '';
  const source = procedureMappingSource || mappingDocument || {};
  for (const optionData of principalPartyOptions(source.mapping, source.reverse_mapping, type)) {
    const option = document.createElement('option');
    option.value = optionData.principal;
    option.label = optionData.code;
    datalist.append(option);
  }
}

function addProcedureParty(side, data = {}) {
  const party = normalizeProcedureInfo(side === 'client'
    ? { parties_clientes: [data] }
    : { parties_adverses: [data] });
  const normalizedParty = side === 'client' ? party.parties_clientes[0] : party.parties_adverses[0];
  const list = procedurePartyList(side);
  list.querySelector('.procedure-party-empty')?.remove();
  const row = document.createElement('article');
  row.className = 'procedure-party-item';
  row.dataset.side = side;
  const personListId = `procedure-person-${++procedurePartyCounter}`;
  const companyListId = `procedure-company-${procedurePartyCounter}`;
  const legalFormListId = `procedure-legal-form-${procedurePartyCounter}`;
  row.innerHTML = `
    <div class="procedure-party-item-head">
      <label>Nature<select class="procedure-party-type"><option value="personne_physique">Personne physique</option><option value="societe">Personne morale</option></select></label>
      <label>Position<select class="procedure-party-position"></select></label>
      <button class="remove-procedure-party" type="button" title="Supprimer cette partie" aria-label="Supprimer cette partie">×</button>
    </div>
    <label class="procedure-position-custom" hidden>Position personnalisée<input class="procedure-position-label" placeholder="Ex. créancier poursuivant"></label>
    <div class="procedure-party-fields procedure-person-fields">
      <label>Civilité<select class="procedure-civility"><option value="">—</option><option>M.</option><option>Mme</option><option>Mlle</option><option>Me</option><option>Dr</option></select></label>
      <label class="wide">Nom complet — variant principal<input class="procedure-person-name" list="${personListId}" placeholder="Claire Reynaud" autocomplete="off"><datalist id="${personListId}"></datalist></label>
      <label>Date de naissance<input class="procedure-birth-date" placeholder="12 septembre 1984"></label>
      <label>Lieu de naissance<input class="procedure-birth-place" placeholder="Lyon"></label>
      <label class="wide">Domicile<input class="procedure-address" placeholder="12 rue…, 75000 Paris"></label>
    </div>
    <div class="procedure-party-fields procedure-company-fields" hidden>
      <label class="wide">Dénomination — variant principal<input class="procedure-company-name" list="${companyListId}" placeholder="Société Alpha" autocomplete="off"><datalist id="${companyListId}"></datalist></label>
      <label>Forme sociale<input class="procedure-company-form" list="${legalFormListId}" placeholder="SAS"></label>
      <label>SIREN<input class="procedure-company-siren" inputmode="numeric" placeholder="123 456 789"></label>
      <label class="wide">Siège social<input class="procedure-company-address" placeholder="12 rue…, 75000 Paris"></label>
      <label class="wide">Représentant légal<input class="procedure-company-representative" placeholder="Mme Claire Reynaud"></label>
    </div>
    <datalist id="${legalFormListId}"><option value="SAS"><option value="SASU"><option value="SARL"><option value="EURL"><option value="SA"><option value="SCI"><option value="SELARL"><option value="Association"></datalist>`;

  const position = row.querySelector('.procedure-party-position');
  for (const { value, label } of PROCEDURE_POSITIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    position.append(option);
  }
  row.querySelector('.procedure-party-type').value = normalizedParty.type;
  position.value = normalizedParty.position;
  row.querySelector('.procedure-position-label').value = normalizedParty.position_libelle;
  row.querySelector('.procedure-civility').value = normalizedParty.civilite;
  row.querySelector('.procedure-person-name').value = normalizedParty.nom;
  row.querySelector('.procedure-birth-date').value = normalizedParty.date_naissance;
  row.querySelector('.procedure-birth-place').value = normalizedParty.lieu_naissance;
  row.querySelector('.procedure-address').value = normalizedParty.adresse;
  row.querySelector('.procedure-company-name').value = normalizedParty.societe_nom;
  row.querySelector('.procedure-company-form').value = normalizedParty.forme_sociale;
  row.querySelector('.procedure-company-siren').value = normalizedParty.siren;
  row.querySelector('.procedure-company-address').value = normalizedParty.siege_social;
  row.querySelector('.procedure-company-representative').value = normalizedParty.representant;
  fillPartyDatalist(row.querySelector(`#${personListId}`), 'personne_physique');
  fillPartyDatalist(row.querySelector(`#${companyListId}`), 'societe');

  const refreshFields = () => {
    const company = row.querySelector('.procedure-party-type').value === 'societe';
    row.querySelector('.procedure-person-fields').hidden = company;
    row.querySelector('.procedure-company-fields').hidden = !company;
    row.querySelector('.procedure-position-custom').hidden = position.value !== 'autre';
  };
  row.querySelector('.procedure-party-type').addEventListener('change', refreshFields);
  position.addEventListener('change', refreshFields);
  row.querySelector('.remove-procedure-party').addEventListener('click', () => {
    row.remove();
    refreshEmptyProcedureList(side);
  });
  for (const input of row.querySelectorAll('input')) {
    input.addEventListener('input', () => {
      input.classList.remove('invalid');
      setMessage(byId('procedurePartiesMessage'));
    });
  }
  refreshFields();
  list.append(row);
}

function renderProcedureParties(info) {
  const normalizedInfo = normalizeProcedureInfo(info);
  const clientList = procedurePartyList('client');
  const adverseList = procedurePartyList('adversaire');
  clientList.textContent = '';
  adverseList.textContent = '';
  normalizedInfo.parties_clientes.forEach((party) => addProcedureParty('client', party));
  normalizedInfo.parties_adverses.forEach((party) => addProcedureParty('adversaire', party));
  refreshEmptyProcedureList('client');
  refreshEmptyProcedureList('adversaire');
}

function collectProcedureParties() {
  const collectSide = (side) => [...procedurePartyList(side).querySelectorAll('.procedure-party-item')].map((row) => {
    const value = (selector) => row.querySelector(selector)?.value.trim() || '';
    const type = value('.procedure-party-type');
    const position = value('.procedure-party-position');
    const identityInput = row.querySelector(type === 'societe' ? '.procedure-company-name' : '.procedure-person-name');
    if (!identityInput.value.trim()) {
      identityInput.classList.add('invalid');
      identityInput.focus();
      throw new Error('Chaque partie ajoutée doit avoir un nom ou une dénomination.');
    }
    const positionLabel = value('.procedure-position-label');
    if (position === 'autre' && !positionLabel) {
      const input = row.querySelector('.procedure-position-label');
      input.classList.add('invalid');
      input.focus();
      throw new Error('Précisez la position procédurale personnalisée.');
    }
    const siren = value('.procedure-company-siren');
    if (type === 'societe' && siren && siren.replace(/\D/g, '').length !== 9) {
      const input = row.querySelector('.procedure-company-siren');
      input.classList.add('invalid');
      input.focus();
      throw new Error('Le SIREN doit contenir exactement 9 chiffres.');
    }
    return type === 'societe' ? {
      type,
      position,
      position_libelle: positionLabel,
      societe_nom: value('.procedure-company-name'),
      forme_sociale: value('.procedure-company-form'),
      siren,
      siege_social: value('.procedure-company-address'),
      representant: value('.procedure-company-representative'),
    } : {
      type,
      position,
      position_libelle: positionLabel,
      civilite: value('.procedure-civility'),
      nom: value('.procedure-person-name'),
      date_naissance: value('.procedure-birth-date'),
      lieu_naissance: value('.procedure-birth-place'),
      adresse: value('.procedure-address'),
    };
  });
  return {
    parties_clientes: collectSide('client'),
    parties_adverses: collectSide('adversaire'),
  };
}

function openProcedurePartiesDialog() {
  try {
    procedureMappingSource = collectMappingDocument();
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
    return;
  }
  setMessage(byId('procedurePartiesMessage'));
  const info = mappingDocument?.informations_dossier;
  renderProcedureParties(info);
  if (!normalizeProcedureInfo(info).parties_clientes.length) addProcedureParty('client');
  if (!normalizeProcedureInfo(info).parties_adverses.length) addProcedureParty('adversaire');
  byId('procedurePartiesDialog').showModal();
}

function closeProcedurePartiesDialog() {
  procedureMappingSource = null;
  byId('procedurePartiesDialog').close();
}

async function saveProcedureParties(event) {
  event.preventDefault();
  const button = byId('saveProcedureParties');
  button.disabled = true;
  try {
    const nextInfo = collectProcedureParties();
    const currentDocument = collectMappingDocument();
    const document = applyProcedureParties(
      currentDocument,
      mappingDocument?.informations_dossier,
      nextInfo,
    );
    const data = await api('/api/admin/mapping', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, ...document }),
    });
    mappingDocument = {
      mapping: data.mapping,
      reverse_mapping: data.reverse_mapping,
      informations_dossier: data.informations_dossier,
    };
    renderMappingRows(data.mapping, data.reverse_mapping);
    renderProcedureSummary();
    closeProcedurePartiesDialog();
    toast(`Parties enregistrées${data.commit?.created ? ' et commitées' : ''}`);
    await loadSelectedCase({ quiet: true });
    showMappingEditorHeader();
  } catch (error) {
    setMessage(byId('procedurePartiesMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function mappingEntries() {
  return byId('mappingRows').querySelectorAll('.mapping-entry');
}

function refreshMappingCount() {
  byId('mappingDialogCount').textContent = String(mappingEntries().length);
}

function watchMappingInput(input) {
  input.addEventListener('input', () => {
    input.classList.remove('invalid');
    setMessage(byId('mappingMessage'));
  });
  return input;
}

function addMappingVariant(container, value = '', { focus = false } = {}) {
  const variantRow = document.createElement('div');
  variantRow.className = 'mapping-variant-row';
  const input = watchMappingInput(document.createElement('input'));
  input.className = 'mapping-variant';
  input.value = value;
  input.placeholder = 'M. Dupont';
  input.setAttribute('aria-label', 'Autre variant');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-mapping-variant';
  remove.title = 'Supprimer ce variant';
  remove.textContent = '×';
  remove.addEventListener('click', () => variantRow.remove());
  variantRow.append(input, remove);
  container.append(variantRow);
  if (focus) input.focus();
}

function addMappingEntry(group = {}, { focus = false } = {}) {
  const rows = byId('mappingRows');
  const empty = rows.querySelector('.mapping-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'mapping-entry';
  const codeInput = watchMappingInput(document.createElement('input'));
  codeInput.className = 'mapping-code code';
  codeInput.value = group.code || '';
  codeInput.placeholder = 'PERSONNE_PHYSIQUE_01';
  codeInput.setAttribute('aria-label', 'Nom anonymisé');
  const principalInput = watchMappingInput(document.createElement('input'));
  principalInput.className = 'mapping-primary';
  principalInput.value = group.principal || '';
  principalInput.placeholder = 'Jean Dupont';
  principalInput.setAttribute('aria-label', 'Variant principal pour le revert');
  const variants = document.createElement('div');
  variants.className = 'mapping-variants';
  const variantList = document.createElement('div');
  variantList.className = 'mapping-variant-list';
  for (const variant of group.variants || []) addMappingVariant(variantList, variant);
  const addVariant = document.createElement('button');
  addVariant.type = 'button';
  addVariant.className = 'add-mapping-variant';
  addVariant.textContent = '+ Variant';
  addVariant.addEventListener('click', () => addMappingVariant(variantList, '', { focus: true }));
  variants.append(variantList, addVariant);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-mapping-entry';
  remove.title = 'Supprimer cette entrée';
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    row.remove();
    refreshMappingCount();
    if (!mappingEntries().length) renderMappingRows({}, {});
  });
  row.append(codeInput, principalInput, variants, remove);
  rows.append(row);
  refreshMappingCount();
  if (focus) codeInput.focus();
}

function renderMappingRows(mapping, reverseMapping) {
  const t0 = performance.now();
  const rows = byId('mappingRows');
  rows.textContent = '';
  const groups = groupMappingByCode(mapping, reverseMapping);
  if (!groups.length) {
    const empty = document.createElement('p');
    empty.className = 'mapping-empty';
    empty.textContent = 'Aucune entrée. Ajoutez-en une ou régénérez depuis les scans PII.';
    rows.append(empty);
    refreshMappingCount();
    return;
  }
  for (const group of groups) addMappingEntry(group);
  dlog('renderMappingRows', `Rendered ${groups.length} grouped rows in ${(performance.now() - t0).toFixed(2)}ms`);
}

function collectMappingDocument() {
  const rows = [...mappingEntries()];
  const groups = rows.map((row) => ({
    code: row.querySelector('.mapping-code')?.value,
    principal: row.querySelector('.mapping-primary')?.value,
    variants: [...row.querySelectorAll('.mapping-variant')].map((input) => input.value),
  }));
  try {
    return buildMappingDocument(groups);
  } catch (error) {
    const row = rows[error.rowIndex];
    let input = null;
    if (error.field === 'code') input = row?.querySelector('.mapping-code');
    if (error.field === 'principal') input = row?.querySelector('.mapping-primary');
    if (error.field === 'variant') {
      input = [...(row?.querySelectorAll('.mapping-variant') || [])]
        .find((candidate) => candidate.value.trim() === error.variant);
    }
    input?.classList.add('invalid');
    input?.focus();
    throw error;
  }
}

function setDetailView(view) {
  detailView = view;
  byId('diffView').hidden = view !== 'diff';
  byId('originalsView').hidden = view !== 'originals';
  byId('mappingView').hidden = view !== 'mapping';
  byId('telegramCaseView').hidden = view !== 'telegram';
  byId('chronologyPane').hidden = view !== 'chronology';
  const protectedDetail = ['originals', 'mapping', 'chronology'].includes(view);
  // Ces panneaux ont leur propre barre d'outils. Masquer l'en-tête de révision
  // évite un titre en double et rend sa hauteur au contenu utile.
  document.querySelector('.revision-column')?.classList.toggle('protected-detail-mode', protectedDetail);
  for (const button of document.querySelectorAll('[data-protected-detail]')) {
    const active = button.dataset.protectedDetail === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  byId('caseTelegramCard').classList.toggle('active', view === 'telegram');
  if (view !== 'diff') {
    revisionRequestSerial += 1;
    setChangedFilesPane(false);
  }
}

function showOriginalsView() {
  setDetailView('originals');
  selectedRevision = null;
  renderOriginals();
}

// Affiche la chronologie dans le volet de droite depuis la vue « Pièces
// protégées » (la frise est reconstruite à partir des pièces du dossier).
function openChronologyView() {
  if (!selectedFolder) {
    toast('Sélectionnez un dossier');
    return;
  }
  setDetailView('chronology');
  selectedRevision = null;
  byId('revisionKind').textContent = 'Chronologie';
  byId('revisionSha').textContent = '';
  byId('revisionTitle').textContent = 'Chronologie du dossier';
  byId('revisionMeta').textContent = `Dossier « ${currentCase()?.name || selectedFolder} »`;
  loadChronology();
}

function showMappingEditorHeader() {
  setDetailView('mapping');
  selectedRevision = null;
  byId('revisionKind').textContent = 'Mapping';
  byId('revisionSha').textContent = '';
  byId('revisionTitle').textContent = 'Mapping d’anonymisation';
  byId('revisionMeta').textContent = `Dossier « ${currentCase()?.name || selectedFolder} »`;
}

async function openMappingEditor() {
  if (!selectedFolder) return;
  showMappingEditorHeader();
  setMessage(byId('mappingMessage'), 'Chargement…');
  byId('mappingRows').textContent = '';
  try {
    const data = await api(`/api/admin/mapping?case=${encodeURIComponent(selectedFolder)}`);
    mappingDocument = {
      mapping: data.mapping,
      reverse_mapping: data.reverse_mapping,
      informations_dossier: data.informations_dossier,
    };
    byId('mappingDialogTitle').textContent = data.name;
    renderMappingRows(data.mapping, data.reverse_mapping);
    renderProcedureSummary();
    setMessage(byId('mappingMessage'), data.exists ? '' : 'Ce dossier n’a pas encore de fichier de mapping.');
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
  }
}

async function saveMapping() {
  const button = byId('saveMapping');
  button.disabled = true;
  try {
    const document = {
      ...collectMappingDocument(),
      informations_dossier: mappingDocument?.informations_dossier,
    };
    const data = await api('/api/admin/mapping', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, ...document }),
    });
    mappingDocument = {
      mapping: data.mapping,
      reverse_mapping: data.reverse_mapping,
      informations_dossier: data.informations_dossier,
    };
    renderMappingRows(data.mapping, data.reverse_mapping);
    renderProcedureSummary();
    setMessage(byId('mappingMessage'), '');
    toast(`Mapping enregistré${data.commit?.created ? ' et commité' : ''} · ${Object.keys(data.reverse_mapping).length} nom(s) anonymisé(s)`);
    await loadSelectedCase({ quiet: true });
    showMappingEditorHeader();
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
    mappingDocument = {
      mapping: data.mapping,
      reverse_mapping: data.reverse_mapping,
      informations_dossier: data.informations_dossier,
    };
    byId('mappingDialogTitle').textContent = data.name;
    renderMappingRows(data.mapping, data.reverse_mapping);
    renderProcedureSummary();
    setMessage(byId('mappingMessage'), `${data.added} entrée(s) ajoutée(s), ${data.total} au total${data.commit?.created ? ' · commit enregistré' : ''}.`);
    await loadSelectedCase({ quiet: true });
    showMappingEditorHeader();
  } catch (error) {
    setMessage(byId('mappingMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function renderHistoryItems() {
  const t0 = performance.now();
  const list = byId('historyList');
  const changes = currentCase()?.workingChanges || [];
  byId('changesView').textContent = `Modifications (${changes.length})`;
  list.textContent = '';
  updateManualCommitForm();
  const protectedMode = historyView === 'protected';
  document.querySelector('.history-column')?.classList.toggle('protected-mode', protectedMode);
  byId('protectedTools').hidden = !protectedMode;
  list.hidden = protectedMode;
  if (protectedMode) {
    renderOriginals();
    if (!['originals', 'mapping', 'chronology'].includes(detailView)) showOriginalsView();
    return;
  }
  if (historyView === 'changes') {
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
    // Le diff est volontairement paresseux : aucun calcul au rendu ou au
    // rafraîchissement, seulement après un clic explicite sur une modification.
    return;
  }

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

  const elapsed = performance.now() - t0;
  dlog('renderHistoryItems', `Rendered history items in ${elapsed.toFixed(2)}ms`);
}

function showRevisionPlaceholder(title) {
  revisionRequestSerial += 1;
  selectedRevision = null;
  setDetailView('diff');
  setChangedFilesPane(false);
  byId('revisionFiles').textContent = '';
  byId('revisionFileCount').textContent = '0';
  byId('revisionKind').textContent = 'Révision';
  byId('revisionSha').textContent = '';
  byId('revisionTitle').textContent = title;
  byId('revisionMeta').textContent = 'Le diff sera calculé uniquement après votre clic.';
  byId('revisionComment').hidden = true;
  byId('revisionComment').textContent = '';
  byId('diffFile').textContent = 'Aucun fichier sélectionné';
  byId('diffStats').textContent = '';
  byId('diffContent').className = 'diff-content empty-state';
  byId('diffContent').textContent = 'Cliquez sur une modification ou un commit pour produire son diff.';
}

const REVISION_FILE_BATCH = 250;

function setChangedFilesPane(visible) {
  byId('changedFilesPane').hidden = !visible;
  byId('changedFilesPane').parentElement.classList.toggle('has-file-list', visible);
}

function renderRevisionFiles(files, hash, selectedPath, limit = REVISION_FILE_BATCH) {
  const list = byId('revisionFiles');
  const safeFiles = Array.isArray(files) ? files : [];
  setChangedFilesPane(true);
  byId('revisionFileCount').textContent = String(safeFiles.length);
  list.textContent = '';

  const fragment = document.createDocumentFragment();
  for (const file of safeFiles.slice(0, limit)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `changed-file-row${file.path === selectedPath ? ' active' : ''}`;
    button.title = file.path;
    if (file.path === selectedPath) button.setAttribute('aria-current', 'true');
    const badge = document.createElement('span');
    badge.className = `file-status ${file.kind || 'modified'}`;
    badge.textContent = statusLetter(file);
    const name = document.createElement('span');
    name.textContent = file.path;
    button.append(badge, name);
    button.addEventListener('click', () => loadRevision(hash, file.path));
    fragment.append(button);
  }

  if (limit < safeFiles.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'changed-files-more';
    more.textContent = `Afficher ${Math.min(REVISION_FILE_BATCH, safeFiles.length - limit)} fichier(s) de plus`;
    more.addEventListener('click', () => renderRevisionFiles(safeFiles, hash, selectedPath, limit + REVISION_FILE_BATCH));
    fragment.append(more);
  }
  list.append(fragment);
}

function diffLineKind(line) {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'addition';
  if (line.startsWith('-') && !line.startsWith('---')) return 'deletion';
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) return 'header';
  return 'context';
}

function renderDiffSegments(container, patch) {
  const fragment = document.createDocumentFragment();
  const lines = patch.split('\n');
  let kind = null;
  let segment = [];

  const flush = () => {
    if (!segment.length) return;
    const span = document.createElement('span');
    span.className = `diff-segment ${kind}`;
    span.textContent = segment.join('\n');
    fragment.append(span);
    segment = [];
  };

  for (const line of lines) {
    const nextKind = diffLineKind(line);
    if (kind !== null && nextKind !== kind) flush();
    kind = nextKind;
    segment.push(line || ' ');
  }
  flush();
  container.replaceChildren(fragment);
}

function renderPatch(patch) {
  const t0 = performance.now();
  const container = byId('diffContent');
  container.textContent = '';
  container.className = 'diff-content';
  if (!patch) {
    container.classList.add('empty-state');
    container.textContent = 'Aucune différence textuelle à afficher.';
    return;
  }
  const lineCount = patch.split('\n').length;
  // Le premier caractère pilote la classe CSS. Les lignes contiguës de même
  // nature sont regroupées pour conserver un DOM léger sur les gros diffs.
  renderDiffSegments(container, patch);
  const elapsed = performance.now() - t0;
  dlog('renderPatch', `Rendered ${lineCount} patch lines in ${elapsed.toFixed(2)}ms`);
  if (elapsed > 100) dwarn('renderPatch', `Slow diff patch rendering: ${elapsed.toFixed(2)}ms for ${lineCount} lines`);
}

async function loadRevision(hash, filePath = '') {
  return traceAsync(`loadRevision(${hash}, ${filePath})`, async () => {
    const requestSerial = ++revisionRequestSerial;
    setDetailView('diff');
    setChangedFilesPane(hash !== 'WORKTREE');
    if (hash !== 'WORKTREE' && !filePath) {
      byId('revisionFiles').textContent = 'Chargement des fichiers…';
      byId('revisionFileCount').textContent = '…';
    }
    byId('diffContent').className = 'diff-content empty-state';
    byId('diffContent').textContent = filePath ? 'Chargement du diff…' : 'Chargement de la révision…';
    try {
      if (!selectedFolder) return;
      const query = new URLSearchParams({ hash, case: selectedFolder });
      if (filePath) query.set('path', filePath);
      if (hash === 'WORKTREE' && currentCase()?.snapshot) query.set('snapshot', currentCase().snapshot);
      const revision = await api(`/api/admin/revision?${query}`);
      if (requestSerial !== revisionRequestSerial) return;
      selectedRevision = { hash, path: revision.selectedPath || '' };
      document.querySelectorAll('.commit-row').forEach((row) => row.classList.toggle('active', row.dataset.hash === hash));
      document.querySelectorAll('.change-row').forEach((row) => row.classList.toggle('active', hash === 'WORKTREE' && row.querySelector('.change-path')?.textContent === revision.selectedPath));

      byId('revisionKind').textContent = revision.kind === 'worktree' ? 'Modifications locales' : 'Commit';
      byId('revisionSha').textContent = revision.shortHash || '';
      byId('revisionTitle').textContent = revision.subject;
      // Les trailers techniques (PieceMaker-Session, PieceMaker-Temps-Session)
      // sont extraits du corps : le temps passé enrichit la ligne de méta, et les
      // lignes brutes sont retirées du commentaire affiché au cabinet.
      const trailers = parsePieceMakerTrailers(revision.body);
      const timeMeta = trailers.elapsed ? ` · ⏱ ${trailers.elapsed}` : '';
      byId('revisionMeta').textContent = revision.kind === 'worktree'
        ? `${revision.filesCount} fichier${revision.filesCount > 1 ? 's' : ''} modifié${revision.filesCount > 1 ? 's' : ''}`
        : `${revision.author} · ${new Date(revision.timestamp).toLocaleString('fr-FR')} · ${revision.filesCount} fichier${revision.filesCount > 1 ? 's' : ''}${timeMeta}`;
      const comment = byId('revisionComment');
      comment.textContent = trailers.comment;
      comment.hidden = !trailers.comment;
      if (revision.kind === 'commit') renderRevisionFiles(revision.files, hash, revision.selectedPath);
      else setChangedFilesPane(false);
      byId('diffFile').textContent = revision.selectedPath || 'Sélectionnez un fichier';
      const stats = revision.stats || {};
      const statLabel = stats.added || stats.deleted ? `+${stats.added || 0}  −${stats.deleted || 0}` : '';
      byId('diffStats').textContent = `${statLabel}${revision.truncated ? `${statLabel ? ' · ' : ''}Diff tronqué` : ''}`;
      if (revision.selectedPath) {
        renderPatch(revision.patch);
      } else {
        byId('diffContent').className = 'diff-content empty-state';
        byId('diffContent').textContent = 'Sélectionnez un fichier modifié pour afficher uniquement son diff.';
      }
    } catch (error) {
      if (requestSerial !== revisionRequestSerial) return;
      byId('diffContent').textContent = error.message;
      toast(error.message);
      showRevisionPlaceholder('Révision indisponible');
    }
  });
}

async function loadHistoryItems() {
  if (historyView !== 'commits') {
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

function mergeSelectedCase(folder) {
  const index = repositoryData?.folders?.findIndex((item) => item.path === folder.path) ?? -1;
  if (index >= 0) repositoryData.folders[index] = { ...repositoryData.folders[index], ...folder };
}

async function loadSelectedCase({ quiet = false } = {}) {
  if (!selectedFolder) {
    historyItems = [];
    renderFolders();
    renderHistoryItems();
    return;
  }
  if (!quiet) byId('historyList').textContent = 'Chargement du dossier…';
  const detailQuery = new URLSearchParams({ case: selectedFolder });
  const detailRequest = api(`/api/admin/repository/case?${detailQuery}`);
  const historyRequest = historyView === 'commits'
    ? api(`/api/admin/history?${new URLSearchParams({ limit: '120', case: selectedFolder })}`)
    : Promise.resolve(null);
  const [{ folder }, historyData] = await Promise.all([detailRequest, historyRequest]);
  mergeSelectedCase(folder);
  if (historyData) historyItems = historyData.history;

  if (selectedRevision?.hash === 'WORKTREE'
      && !folder.workingChanges.some((change) => change.path === selectedRevision.path)) {
    showRevisionPlaceholder('Sélectionnez une modification');
  }
  if (selectedRevision && selectedRevision.hash !== 'WORKTREE'
      && historyView === 'commits'
      && !historyItems.some((item) => item.hash === selectedRevision.hash)) {
    showRevisionPlaceholder('Sélectionnez un commit');
  }
  updateCaseToolbar();
  renderFolders();
  renderHistoryItems();
  historyLoaded = true;
  void loadCaseTelegramState();
}

let repositoryRefreshInFlight = false;

async function loadRepositoryHistory({ quiet = false } = {}) {
  if (repositoryRefreshInFlight) {
    dlog('loadRepositoryHistory', 'Skipping request: already in flight');
    return;
  }
  repositoryRefreshInFlight = true;
  if (!quiet) byId('historyList').textContent = 'Chargement…';
  try {
    repositoryData = await api('/api/admin/repository');
    if (!repositoryData.folders.some((folder) => folder.path === selectedFolder)) {
      selectedFolder = repositoryData.folders[0]?.path || '';
      selectedRevision = null;
      showRevisionPlaceholder('Sélectionnez une modification');
    }
    updateCaseToolbar();
    renderFolders();
    await loadSelectedCase({ quiet });
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
  caseTelegram = null;
  caseTelegramFolder = '';
  if ((originalsJob?.reference || originalsJob?.case) !== folder) showOriginalsProgress('');
  showRevisionPlaceholder('Sélectionnez une modification');
  updateCaseToolbar();
  renderFolders();
  try {
    await loadSelectedCase();
  } catch (error) {
    byId('historyList').textContent = error.message;
    toast(error.message);
  }
}

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
  byId('repositoryPath').textContent = legalCase?.location || repositoryData?.root || '—';
  byId('repositoryHead').textContent = legalCase?.shortHead || 'Aucun';
  byId('pushState').textContent = legalCase?.shortHead ? `À jour · ${legalCase.shortHead}` : 'Actualiser l’historique local';
  const branchSelect = byId('branchSelect');
  branchSelect.textContent = '';
  const branches = legalCase?.branches?.branches || [];
  for (const branch of branches) {
    const option = document.createElement('option');
    option.value = branch;
    option.textContent = branch;
    option.selected = branch === legalCase.branches.active;
    branchSelect.append(option);
  }
  branchSelect.disabled = !legalCase || !branches.length;
  byId('openCreateBranch').disabled = !legalCase;
  const hasRoot = Boolean(legalCase || repositoryData?.root);
  byId('revealFolder').disabled = !hasRoot;
  byId('openTerminal').disabled = !hasRoot;
  const scope = legalCase ? `le dossier « ${legalCase.name} »` : 'la racine PieceMaker';
  byId('revealFolder').title = `Afficher ${scope} dans le gestionnaire de fichiers`;
  byId('openTerminal').title = `Ouvrir un terminal dans ${scope}`;
  renderCaseTelegramCard();
}

function renderCaseTelegramCard() {
  const card = byId('caseTelegramCard');
  card.disabled = !selectedFolder || !caseTelegram;
  card.classList.toggle('configured', Boolean(caseTelegram?.token?.configured));
  byId('caseTelegramTitle').textContent = !selectedFolder
    ? 'Aucun dossier'
    : !caseTelegram ? 'Chargement…' : caseTelegram.name || currentCase()?.name || 'Bot du dossier';
  byId('caseTelegramState').textContent = !caseTelegram
    ? 'Configuration indisponible'
    : caseTelegram.token?.configured
      ? `${caseTelegram.token.hint} · modifier le token`
      : 'Ajouter un token BotFather';
}

async function loadCaseTelegramState() {
  const legalCase = currentCase();
  const caseName = legalCase?.name || '';
  const caseKey = legalCase?.path || '';
  if (caseKey && caseTelegramFolder === caseKey && caseTelegram) {
    renderCaseTelegramCard();
    return;
  }
  caseTelegram = null;
  caseTelegramFolder = caseKey;
  renderCaseTelegramCard();
  if (!selectedFolder || !caseName) return;
  try {
    const data = await api('/api/admin/telegram');
    if (caseTelegramFolder === caseKey) {
      caseTelegram = data.dossiers?.find((dossier) => dossier.workdir === legalCase.location)
        || data.dossiers?.find((dossier) => dossier.directoryName === caseName)
        || null;
    }
  } catch (error) {
    dwarn('telegram', `État du bot du dossier indisponible : ${error.message}`);
  }
  renderCaseTelegramCard();
}

function openCaseTelegramEditor() {
  if (!caseTelegram) return;
  setDetailView('telegram');
  selectedRevision = null;
  byId('revisionKind').textContent = 'Telegram';
  byId('revisionSha').textContent = '';
  byId('revisionTitle').textContent = `Bot · ${currentCase()?.name || selectedFolder}`;
  byId('revisionMeta').textContent = caseTelegram.running ? `Bot actif · PID ${caseTelegram.pid}` : 'Configuration locale du bot du dossier';
  byId('telegramCaseName').value = caseTelegram.name || currentCase()?.name || '';
  byId('telegramCaseToken').value = '';
  byId('telegramCaseToken').placeholder = caseTelegram.token?.configured ? 'Laisser vide pour conserver le token' : '123456789:secret';
  byId('telegramCaseHint').textContent = caseTelegram.token?.configured
    ? `Token configuré (${caseTelegram.token.hint}). Saisissez-en un nouveau uniquement pour le remplacer.`
    : 'Ajoutez le token transmis par BotFather pour lier ce dossier.';
  setMessage(byId('telegramCaseMessage'));
}

async function saveCaseTelegramBot(event) {
  event.preventDefault();
  if (!caseTelegram) return;
  const button = byId('saveTelegramCase');
  button.disabled = true;
  setMessage(byId('telegramCaseMessage'), 'Enregistrement…');
  try {
    const result = await api(`/api/admin/telegram/dossiers/${encodeURIComponent(caseTelegram.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: byId('telegramCaseName').value,
        token: byId('telegramCaseToken').value,
      }),
    });
    caseTelegram = result.dossier;
    renderCaseTelegramCard();
    openCaseTelegramEditor();
    setMessage(byId('telegramCaseMessage'), 'Bot du dossier enregistré.', 'success');
    toast('Configuration Telegram enregistrée');
  } catch (error) {
    setMessage(byId('telegramCaseMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

const CATEGORY_LABELS = {
  personne: 'Personne',
  societe: 'Société',
  adresse: 'Adresse',
  siren: 'SIREN',
  autre: 'Autre',
};

const NATURE_ICONS = {
  assignation: '⚖️', conclusions: '📝', requête: '📄', courrier: '✉️',
  courriel: '✉️', 'mise en demeure': '⚠️', contrat: '🤝', facture: '🧾',
  devis: '🧾', attestation: '📃', jugement: '⚖️', arrêt: '⚖️',
  ordonnance: '⚖️', 'procès-verbal': '📋', constat: '📋', expertise: '🔬',
  'statuts de société': '🏛️', 'extrait Kbis': '🏛️', 'relevé bancaire': '🏦',
  'acte notarié': '🖋️', 'bordereau de pièces': '📚',
};

let chronologyData = null;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function loadChronology() {
  const body = byId('chronologyBody');
  if (!selectedFolder) {
    chronologyData = null;
    byId('chronologyStats').textContent = '0';
    body.innerHTML = '<p class="chronology-empty">Sélectionnez un dossier pour afficher sa chronologie.</p>';
    return;
  }
  body.innerHTML = '<p class="chronology-empty">Chargement de la chronologie…</p>';
  try {
    const data = await api(`/api/admin/repository/chronology?${new URLSearchParams({ case: selectedFolder })}`);
    chronologyData = data;
    renderChronology(data);
  } catch (error) {
    body.innerHTML = `<p class="chronology-empty">${escapeHtml(error.message)}</p>`;
  }
}

function renderChronology(data) {
  const body = byId('chronologyBody');
  body.textContent = '';
  const { stats } = data;
  byId('chronologyStats').textContent = `${stats.documents}`;

  if (!stats.indexed) {
    body.innerHTML = '<p class="chronology-empty">Aucune pièce scannée pour l’instant. Lancez « Anonymiser & mapper » sur les pièces pour alimenter la chronologie.</p>';
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'chronology-summary';
  const spanText = stats.span
    ? `${formatChronoDate(stats.span.from)} → ${formatChronoDate(stats.span.to)}`
    : 'dates non détectées';
  summary.innerHTML = `<span>${stats.indexed} pièce${stats.indexed > 1 ? 's' : ''} indexée${stats.indexed > 1 ? 's' : ''}</span>`
    + `<span>${stats.dated} datée${stats.dated > 1 ? 's' : ''}</span>`
    + `<span>${stats.entities} entité${stats.entities > 1 ? 's' : ''}</span>`
    + `<span>${spanText}</span>`;
  body.append(summary);

  // Sélecteur de vue : frise chronologique / graphe des liens.
  const toggle = document.createElement('div');
  toggle.className = 'chronology-toggle';
  toggle.innerHTML = '<button type="button" class="active" data-chrono-view="timeline">Frise</button>'
    + '<button type="button" data-chrono-view="graph">Graphe des liens</button>';
  body.append(toggle);

  const timeline = document.createElement('div');
  timeline.className = 'chronology-timeline';
  timeline.append(renderTimeline(data));
  body.append(timeline);

  const graph = document.createElement('div');
  graph.className = 'chronology-graph';
  graph.hidden = true;
  body.append(graph);

  toggle.querySelectorAll('[data-chrono-view]').forEach((button) => {
    button.addEventListener('click', () => {
      toggle.querySelectorAll('[data-chrono-view]').forEach((other) => other.classList.toggle('active', other === button));
      const wantGraph = button.dataset.chronoView === 'graph';
      timeline.hidden = wantGraph;
      graph.hidden = !wantGraph;
      if (wantGraph && !graph.dataset.rendered) {
        graph.append(renderChronologyGraph(data));
        graph.dataset.rendered = '1';
      }
    });
  });
}

function formatChronoDate(iso) {
  if (!iso) return 'Sans date';
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

function renderTimeline(data) {
  const fragment = document.createDocumentFragment();
  const dated = data.documents.filter((doc) => doc.dateIso);
  const undated = data.documents.filter((doc) => !doc.dateIso);
  for (const doc of dated) fragment.append(renderTimelineRow(doc));
  if (undated.length) {
    const header = document.createElement('div');
    header.className = 'chronology-undated-head';
    header.textContent = `Sans date détectée (${undated.length})`;
    fragment.append(header);
    for (const doc of undated) fragment.append(renderTimelineRow(doc));
  }
  return fragment;
}

function renderTimelineRow(doc) {
  const row = document.createElement('div');
  row.className = 'chronology-row';
  const icon = doc.nature ? (NATURE_ICONS[doc.nature] || '📄') : '📄';

  const rail = document.createElement('div');
  rail.className = 'chronology-rail';
  rail.innerHTML = `<span class="chronology-dot"></span><span class="chronology-date">${escapeHtml(formatChronoDate(doc.dateIso))}</span>`;
  row.append(rail);

  const card = document.createElement('div');
  card.className = 'chronology-card';
  if (doc.protected) card.classList.add('protected');

  const head = document.createElement('div');
  head.className = 'chronology-card-head';
  const nature = doc.nature ? `<span class="chronology-nature">${icon} ${escapeHtml(doc.nature)}</span>` : '';
  head.innerHTML = `${nature}<strong class="chronology-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</strong>`;
  card.append(head);

  if (doc.juridiction) {
    const juris = document.createElement('div');
    juris.className = 'chronology-juris';
    juris.textContent = doc.juridiction;
    card.append(juris);
  }

  if (doc.codes.length) {
    const chips = document.createElement('div');
    chips.className = 'chronology-chips';
    chips.title = 'Cliquer pour corriger les entités détectées';
    for (const entity of doc.codes) {
      const chip = document.createElement('span');
      chip.className = `entity-chip cat-${entity.category}`;
      chip.textContent = entity.label || entity.code;
      chip.title = `${CATEGORY_LABELS[entity.category] || entity.category} · ${entity.code}`;
      chips.append(chip);
    }
    chips.addEventListener('click', () => openChronologyEntityDialog(doc));
    card.append(chips);
  } else if (doc.indexed) {
    const none = document.createElement('div');
    none.className = 'chronology-nochip';
    none.textContent = 'Aucune entité citée';
    card.append(none);
  }

  const actions = document.createElement('div');
  actions.className = 'chronology-card-actions';

  const correctButton = document.createElement('button');
  correctButton.type = 'button';
  correctButton.className = 'button ghost compact';
  correctButton.textContent = '📝 Corriger / contenu';
  correctButton.title = 'Voir le Markdown converti et corriger les entités détectées';
  correctButton.disabled = !doc.indexed;
  correctButton.addEventListener('click', () => openChronologyEntityDialog(doc));
  actions.append(correctButton);

  const revealButton = document.createElement('button');
  revealButton.type = 'button';
  revealButton.className = 'button ghost compact';
  revealButton.textContent = '📂 Afficher l’original';
  revealButton.title = 'Révéler la pièce originale dans le gestionnaire de fichiers du poste';
  revealButton.addEventListener('click', () => revealChronologyPiece(doc, revealButton));
  actions.append(revealButton);

  card.append(actions);

  row.append(card);
  return row;
}

// Révèle la pièce ORIGINALE (pas son Markdown) dans le Finder/Explorateur du
// poste — jamais de contenu affiché dans le navigateur, donc sûr même pour une
// pièce protégée : `/api/admin/reveal` ouvre un outil du système, il ne
// renvoie aucun texte de la pièce.
async function revealChronologyPiece(doc, button) {
  const previous = button.textContent;
  button.disabled = true;
  try {
    const result = await api('/api/admin/reveal', {
      method: 'POST',
      body: JSON.stringify({ target: 'files', case: selectedFolder, path: doc.path }),
    });
    toast(`Pièce révélée · ${result.path}`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

// Graphify produit lui-même le document interactif (clustering Leiden, moteur
// physique vis-network, recherche, inspection et filtres). L'iframe sans
// `allow-same-origin` lui permet d'exécuter son renderer sans lui donner accès à
// la page d'administration ni à ses données JavaScript.
function renderChronologyGraph(data) {
  const graphData = data.graph || {};
  if (graphData.status === 'error') {
    const error = document.createElement('p');
    error.className = 'chronology-empty';
    error.textContent = graphData.error || 'Le graphe Graphify n’a pas pu être généré.';
    return error;
  }
  if (!graphData.viewerHtml) {
    const empty = document.createElement('p');
    empty.className = 'chronology-empty';
    empty.textContent = 'Pas assez de liens GLiNER pour tracer un graphe.';
    return empty;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'graphify-viewer-wrap';
  const meta = document.createElement('p');
  meta.className = 'chronology-graph-meta';
  meta.textContent = 'Visualiseur officiel Graphify · résultats GLiNER locaux · sans LLM (0 token)';
  const frame = document.createElement('iframe');
  frame.className = 'graphify-viewer-frame';
  frame.title = 'Graphe interactif Graphify';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.referrerPolicy = 'no-referrer';
  frame.srcdoc = graphData.viewerHtml;

  // Bascule plein écran CSS (pas la Fullscreen API : l'iframe, en sandbox
  // `allow-scripts` seul, ne peut pas fiablement la demander). L'écouteur
  // Escape n'est posé que pendant le plein écran et retiré à la sortie — sinon
  // rouvrir la chronologie plusieurs fois empilerait un écouteur par graphe.
  const fullscreenButton = document.createElement('button');
  fullscreenButton.type = 'button';
  fullscreenButton.className = 'button ghost compact graphify-fullscreen-toggle';
  const setFullscreenLabel = (active) => {
    fullscreenButton.textContent = active ? '⤡ Réduire' : '⤢ Plein écran';
    fullscreenButton.title = active ? 'Revenir à l’affichage normal' : 'Agrandir le graphe en plein écran';
  };
  const onEscape = (event) => {
    if (event.key === 'Escape') setFullscreen(false);
  };
  const setFullscreen = (active) => {
    wrapper.classList.toggle('graphify-fullscreen', active);
    setFullscreenLabel(active);
    document.removeEventListener('keydown', onEscape);
    if (active) document.addEventListener('keydown', onEscape);
  };
  fullscreenButton.addEventListener('click', () => setFullscreen(!wrapper.classList.contains('graphify-fullscreen')));
  setFullscreenLabel(false);

  wrapper.append(meta, fullscreenButton, frame);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Correction des entités détectées (chronologie) — popup à deux colonnes :
// les entités de la pièce à gauche (éditables), son Markdown converti à
// droite pour le contexte. Toute modification passe par les MÊMES helpers que
// l'éditeur de mapping (`groupMappingByCode` / `buildMappingDocument`) et le
// même endpoint `PUT /api/admin/mapping` — jamais de substitution maison.
// `chronologyEntityContext.groups` porte TOUT le mapping du dossier : seuls
// les groupes des codes de cette pièce sont montrés/édités, les autres sont
// renvoyés inchangés pour ne rien perdre du reste du dossier.
let chronologyEntityDoc = null;
let chronologyEntityContext = null;

function closeChronologyEntityDialog() {
  chronologyEntityDoc = null;
  chronologyEntityContext = null;
  byId('chronologyEntityDialog').close();
}

async function openChronologyEntityDialog(doc) {
  if (!selectedFolder || !doc.indexed) return;
  chronologyEntityDoc = doc;
  chronologyEntityContext = null;
  byId('chronologyEntityTitle').textContent = doc.name;
  byId('chronologyEntityRows').textContent = '';
  byId('chronologyEntityPreview').textContent = 'Chargement…';
  setMessage(byId('chronologyEntityMessage'), 'Chargement…');
  byId('chronologyEntityDialog').showModal();
  try {
    const [mappingData, documentData] = await Promise.all([
      api(`/api/admin/mapping?${new URLSearchParams({ case: selectedFolder })}`),
      api(`/api/admin/repository/document?${new URLSearchParams({ case: selectedFolder, path: doc.path })}`),
    ]);
    chronologyEntityContext = {
      groups: groupMappingByCode(mappingData.mapping, mappingData.reverse_mapping),
      informations_dossier: mappingData.informations_dossier,
    };
    renderChronologyEntityRows(doc);
    renderChronologyEntityPreview(documentData.content);
    setMessage(byId('chronologyEntityMessage'), '');
  } catch (error) {
    setMessage(byId('chronologyEntityMessage'), error.message, 'error');
  }
}

function chronologyEntityRowsList() {
  return byId('chronologyEntityRows').querySelectorAll('.chronology-entity-row');
}

function showChronologyEntityEmptyState() {
  const rows = byId('chronologyEntityRows');
  const empty = document.createElement('p');
  empty.className = 'chronology-entity-empty';
  empty.textContent = 'Toutes les entités de cette pièce ont été écartées.';
  rows.append(empty);
}

function renderChronologyEntityRows(doc) {
  const rows = byId('chronologyEntityRows');
  rows.textContent = '';
  const codes = [...new Set(doc.codes.map((entity) => entity.code))];
  if (!codes.length) {
    const empty = document.createElement('p');
    empty.className = 'chronology-entity-empty';
    empty.textContent = 'Aucune entité détectée dans cette pièce.';
    rows.append(empty);
    return;
  }
  for (const code of codes) {
    const entity = doc.codes.find((item) => item.code === code);
    const group = chronologyEntityContext.groups.find((candidate) => candidate.code === code);
    const row = document.createElement('div');
    row.className = 'chronology-entity-row';
    row.dataset.code = code;

    const badge = document.createElement('span');
    badge.className = `entity-chip cat-${entity.category}`;
    badge.textContent = CATEGORY_LABELS[entity.category] || entity.category;

    const field = document.createElement('div');
    const input = document.createElement('input');
    input.className = 'chronology-entity-label';
    input.value = group?.principal || entity.label || '';
    input.setAttribute('aria-label', `Libellé de ${code}`);
    input.addEventListener('input', () => {
      input.classList.remove('invalid');
      setMessage(byId('chronologyEntityMessage'), '');
    });
    const codeLabel = document.createElement('span');
    codeLabel.className = 'chronology-entity-code';
    codeLabel.textContent = code;
    field.append(input, codeLabel);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-chronology-entity';
    remove.title = 'Écarter cette entité (fausse détection) — ses variants iront dans les entrées ignorées';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      row.remove();
      if (!chronologyEntityRowsList().length) showChronologyEntityEmptyState();
    });

    row.append(badge, field, remove);
    rows.append(row);
  }
}

function renderChronologyEntityPreview(content) {
  const preview = byId('chronologyEntityPreview');
  const text = String(content || '');
  if (!text.trim()) {
    preview.textContent = 'Contenu vide.';
    return;
  }
  preview.innerHTML = markdownToHtml(text);
}

// Reconstruit un groupe édité pour `buildMappingDocument` : le nouveau
// libellé devient le variant principal, mais l'ancien texte détecté (et les
// autres variants déjà connus) restent dans le mapping — renommer l'affichage
// ne doit pas faire disparaître une écriture réellement présente dans les
// pièces, sous peine de fuite au prochain scan (le texte redeviendrait en
// clair, non substitué). Écarter une variante précise reste le rôle du bouton
// « × » (toute l'entrée) ou de l'éditeur de mapping complet (variant par
// variant).
function chronologyRelabeledGroup(group, code, rawLabel) {
  const label = String(rawLabel || '').trim();
  const known = group ? [group.principal, ...group.variants] : [];
  const variants = known.filter((variant) => variant && variant !== label);
  return { code, principal: label, variants };
}

async function saveChronologyEntityChanges(event) {
  event.preventDefault();
  if (!chronologyEntityDoc || !chronologyEntityContext) return;
  const button = byId('saveChronologyEntity');
  button.disabled = true;
  try {
    const editedCodes = new Set(chronologyEntityDoc.codes.map((entity) => entity.code));
    const kept = [...chronologyEntityRowsList()].map((row) => {
      const code = row.dataset.code;
      const group = chronologyEntityContext.groups.find((candidate) => candidate.code === code);
      return chronologyRelabeledGroup(group, code, row.querySelector('.chronology-entity-label').value);
    });
    const untouched = chronologyEntityContext.groups.filter((group) => !editedCodes.has(group.code));
    const nextGroups = [...untouched, ...kept];
    let document;
    try {
      // eslint-disable-next-line no-shadow -- même convention que saveMapping() : `document` désigne ici le document de mapping envoyé au serveur, pas le DOM.
      document = {
        ...buildMappingDocument(nextGroups),
        informations_dossier: chronologyEntityContext.informations_dossier,
      };
    } catch (validationError) {
      // Le libellé en cause est forcément un des groupes édités dans cette
      // popup (les groupes intouchés viennent du mapping déjà valide) —
      // on retrouve la ligne par son code pour la mettre en évidence.
      const offending = nextGroups[validationError.rowIndex];
      const input = offending && byId('chronologyEntityRows').querySelector(`[data-code="${CSS.escape(offending.code)}"] .chronology-entity-label`);
      input?.classList.add('invalid');
      input?.focus();
      throw validationError;
    }
    const data = await api('/api/admin/mapping', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, ...document }),
    });
    toast(`Entités mises à jour${data.commit?.created ? ' et commitées' : ''}`);
    closeChronologyEntityDialog();
    await loadChronology();
  } catch (error) {
    setMessage(byId('chronologyEntityMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function setHistoryView(view) {
  historyView = view;
  selectedRevision = null;
  // Les pièces protégées ouvrent directement le premier des trois outils ; les
  // vues Git conservent leur en-tête de révision et leur placeholder de diff.
  if (view === 'protected') showOriginalsView();
  else showRevisionPlaceholder(view === 'changes' ? 'Sélectionnez une modification' : 'Sélectionnez un commit');
  document.querySelectorAll('[data-history-view]').forEach((button) => button.classList.toggle('active', button.dataset.historyView === view));
  await loadHistoryItems();
}

function updateManualCommitForm() {
  const form = byId('manualCommitForm');
  const changes = currentCase()?.workingChanges || [];
  const visible = historyView === 'changes' && Boolean(selectedFolder);
  form.hidden = !visible;
  const title = byId('commitTitle').value.trim();
  const button = byId('createCommit');
  button.disabled = !visible || !changes.length || !title;
  button.textContent = changes.length
    ? `Enregistrer ${changes.length} fichier${changes.length > 1 ? 's' : ''}`
    : 'Aucune modification à enregistrer';
}

async function createManualCommit(event) {
  event.preventDefault();
  if (!selectedFolder) return;
  const label = byId('commitTitle').value.trim();
  const description = byId('commitDescription').value.trim();
  if (!label) {
    byId('commitTitle').focus();
    return;
  }
  const button = byId('createCommit');
  button.disabled = true;
  try {
    const result = await api('/api/admin/commits', {
      method: 'POST',
      body: JSON.stringify({ label, description, case: selectedFolder }),
    });
    toast(result.created ? 'Commit enregistré' : 'Aucune nouvelle modification à enregistrer');
    if (result.created) {
      byId('commitTitle').value = '';
      byId('commitDescription').value = '';
    }
    await loadSelectedCase({ quiet: true });
  } catch (error) {
    toast(error.message);
  } finally {
    updateManualCommitForm();
  }
}

function openCreationDialog(kind) {
  const dialog = byId('createBranchDialog');
  const input = byId('newBranchName');
  const message = byId('createBranchMessage');
  input.value = '';
  setMessage(message);
  dialog.showModal();
  requestAnimationFrame(() => input.focus());
}

async function selectAndRegisterCase() {
  const button = byId('openCreateCase');
  button.disabled = true;
  toast('Sélectionnez un dossier existant sur votre ordinateur');
  try {
    const result = await api('/api/admin/repository/cases', {
      method: 'POST',
      body: '{}',
    });
    if (result.cancelled) {
      toast('Sélection annulée');
      return;
    }
    selectedFolder = result.folder.path;
    await loadRepositoryHistory();
    toast('Dossier enregistré · plugin PieceMaker actif pour toutes ses sessions');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function createBranchFromForm(event) {
  event.preventDefault();
  if (!selectedFolder) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(byId('createBranchMessage'), 'Création de la branche…');
  try {
    const result = await api('/api/admin/branches', {
      method: 'POST',
      body: JSON.stringify({ case: selectedFolder, name: byId('newBranchName').value }),
    });
    byId('createBranchDialog').close();
    selectedRevision = null;
    await loadSelectedCase({ quiet: true });
    toast(`Branche « ${result.active} » créée`);
  } catch (error) {
    setMessage(byId('createBranchMessage'), error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function selectHistoryBranch(event) {
  if (!selectedFolder) return;
  const select = event.currentTarget;
  select.disabled = true;
  try {
    await api('/api/admin/branches/current', {
      method: 'PUT',
      body: JSON.stringify({ case: selectedFolder, name: select.value }),
    });
    selectedRevision = null;
    historyItems = [];
    showRevisionPlaceholder(historyView === 'commits'
      ? 'Sélectionnez un commit'
      : historyView === 'protected' ? 'Sélectionnez une modification ou ouvrez le mapping' : 'Sélectionnez une modification');
    await loadSelectedCase({ quiet: true });
    toast(`Branche « ${select.value} » active`);
  } catch (error) {
    toast(error.message);
    updateCaseToolbar();
  } finally {
    select.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// LOG VIEWER EVENT LISTENERS
// ---------------------------------------------------------------------------
function initLogViewer() {
  byId('toggleLogConsole')?.addEventListener('click', () => {
    const consoleElem = byId('debugConsoleDrawer');
    if (consoleElem) {
      consoleElem.hidden = !consoleElem.hidden;
    }
  });

  byId('clearDebugLogs')?.addEventListener('click', () => {
    window.__PM_LOGS = [];
    const container = byId('debugLogContainer');
    if (container) container.innerHTML = '';
  });

  byId('copyDebugLogs')?.addEventListener('click', () => {
    const text = (window.__PM_LOGS || []).map((l) => `[${l.timestamp}] [${l.source}] [${l.level}] ${l.message} ${l.data ? JSON.stringify(l.data) : ''}`).join('\n');
    navigator.clipboard.writeText(text).then(() => toast('Logs copiés dans le presse-papier'));
  });
}

function initPerformanceMonitoring() {
  if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attribution = entry.attribution?.[0];
        dwarn('longtask', `Main thread blocked for ${entry.duration.toFixed(2)}ms`, {
          startTime: Number(entry.startTime.toFixed(2)),
          container: attribution?.containerName || attribution?.name || 'unknown',
        });
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
    window.__PM_LONG_TASK_OBSERVER = longTaskObserver;
  } else {
    dlog('performance', 'Long Task API unavailable in this browser');
  }

  window.addEventListener('load', () => {
    requestAnimationFrame(() => {
      const navigation = performance.getEntriesByType('navigation')[0];
      if (!navigation) return;
      dlog('performance', 'Window load completed', {
        domContentLoadedMs: Number(navigation.domContentLoadedEventEnd.toFixed(2)),
        loadEventMs: Number(navigation.loadEventEnd.toFixed(2)),
        transferredBytes: navigation.transferSize,
      });
    });
  }, { once: true });
}

document.querySelectorAll('[data-history-view]').forEach((button) => button.addEventListener('click', () => setHistoryView(button.dataset.historyView)));
byId('showOriginals').addEventListener('click', showOriginalsView);
byId('showChronology').addEventListener('click', openChronologyView);
byId('refreshHistory').addEventListener('click', () => loadRepositoryHistory());
byId('caseSelect').addEventListener('change', (event) => selectHistoryFolder(event.currentTarget.value));
byId('branchSelect').addEventListener('change', selectHistoryBranch);
byId('openCreateCase').addEventListener('click', selectAndRegisterCase);
byId('openCreateBranch').addEventListener('click', () => openCreationDialog('branch'));
byId('createBranchForm').addEventListener('submit', createBranchFromForm);
byId('cancelCreateBranch').addEventListener('click', () => byId('createBranchDialog').close());
byId('revealFolder').addEventListener('click', (event) => revealCaseFolder('files', event.currentTarget));
byId('openTerminal').addEventListener('click', (event) => revealCaseFolder('terminal', event.currentTarget));
labelFolderActions();
byId('manualCommitForm').addEventListener('submit', createManualCommit);
byId('commitTitle').addEventListener('input', updateManualCommitForm);
for (const button of document.querySelectorAll('.scope-button')) {
  button.addEventListener('click', (event) => {
    originalsScope = event.currentTarget.dataset.scope;
    renderOriginals();
  });
}

byId('selectAllOriginals').addEventListener('change', (event) => {
  selectedOriginals = event.currentTarget.checked ? new Set(pendingOriginals().map((original) => original.path)) : new Set();
  renderOriginals();
});
byId('convertOriginals').addEventListener('click', () => startOriginalsPipeline('convert'));
byId('anonymizeOriginals').addEventListener('click', () => startOriginalsPipeline('anonymize'));
byId('openMapping').addEventListener('click', openMappingEditor);
byId('addMappingRow').addEventListener('click', () => addMappingEntry({}, { focus: true }));
byId('rebuildMapping').addEventListener('click', rebuildMapping);
byId('saveMapping').addEventListener('click', saveMapping);
byId('openProcedureParties').addEventListener('click', openProcedurePartiesDialog);
byId('addClientParty').addEventListener('click', () => addProcedureParty('client'));
byId('addAdverseParty').addEventListener('click', () => addProcedureParty('adversaire'));
byId('closeProcedureParties').addEventListener('click', closeProcedurePartiesDialog);
byId('cancelProcedureParties').addEventListener('click', closeProcedurePartiesDialog);
byId('procedurePartiesForm').addEventListener('submit', saveProcedureParties);
byId('closeChronologyEntity').addEventListener('click', closeChronologyEntityDialog);
byId('cancelChronologyEntity').addEventListener('click', closeChronologyEntityDialog);
byId('chronologyEntityForm').addEventListener('submit', saveChronologyEntityChanges);
byId('caseTelegramCard').addEventListener('click', openCaseTelegramEditor);
byId('telegramCaseView').addEventListener('submit', saveCaseTelegramBot);

function applyEditorCommand(button) {
  const command = button.dataset.command;
  if (command === 'insertAsset') {
    // Le clic sur l'input fichier ouvre le sélecteur système ; l'insertion se
    // fait au retour, dans le listener 'change' (uploadAsset).
    byId('assetInput').click();
    return;
  }
  byId('fileEditor').focus();
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

// Insère du HTML au curseur, en repositionnant la sélection à la fin de
// l'éditeur si le focus l'avait quitté (retour du sélecteur de fichier).
function insertHtmlIntoEditor(html) {
  const editor = byId('fileEditor');
  editor.focus();
  const selection = window.getSelection();
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  document.execCommand('insertHTML', false, html);
  editor.classList.remove('empty');
  markEditorDirty();
}

// Téléverse le fichier choisi dans le dossier du skill sélectionné et insère un
// lien Markdown relatif vers lui. Réservé aux skills — un agent n'a pas de
// dossier propre pour ses annexes.
async function uploadAsset(file) {
  if (!file) return;
  if (!selectedFile || selectedFile.kind !== 'skill') {
    toast('Un fichier annexe ne s’ajoute qu’à un skill.');
    return;
  }
  try {
    const buffer = await file.arrayBuffer();
    const result = await api('/api/admin/asset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Skill-Path': selectedFile.path,
        'X-Filename': encodeURIComponent(file.name),
      },
      body: buffer,
    });
    const name = escapeHtml(result.name);
    insertHtmlIntoEditor(`<a href="${name}">${name}</a>&nbsp;`);
    toast(`« ${result.name} » ajouté au skill et inséré`);
  } catch (error) {
    toast(error.message || 'Échec de l’ajout du fichier');
  }
}

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
byId('refreshConfiguration').addEventListener('click', () => loadConfiguration());
document.querySelectorAll('[data-config-component]').forEach((node) => {
  node.addEventListener('click', () => openConfigurationDetail(node.dataset.configComponent, '', node));
});
byId('closeConfigurationDetail').addEventListener('click', closeConfigurationDetail);
byId('configurationDetail').addEventListener('cancel', (event) => {
  event.preventDefault();
  closeConfigurationDetail();
});
byId('configurationDetail').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) closeConfigurationDetail();
});
byId('settingsForm').addEventListener('submit', saveSettings);
byId('adminDarkMode').addEventListener('change', saveAdminTheme);
byId('addInstitutionalTerm').addEventListener('click', addInstitutionalTermFromInput);
byId('institutionalTermInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addInstitutionalTermFromInput();
  }
});
byId('saveInstitutionalTerms').addEventListener('click', saveInstitutionalTerms);
byId('tamponImageInput').addEventListener('change', handleTamponImageUpload);
byId('buildTamponBtn').addEventListener('click', buildTampon);
document.querySelectorAll('[data-tampon-control]').forEach((control) => {
  control.addEventListener('input', () => buildTampon({ announce: false }));
  control.addEventListener('change', () => buildTampon({ announce: false }));
});
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
byId('deleteFile').addEventListener('click', deleteFile);
byId('fileEditor').addEventListener('input', markEditorDirty);
byId('fileEditor').addEventListener('scroll', (event) => {
  byId('editorToolbar').classList.toggle('is-floating', event.currentTarget.scrollTop > 4);
});
document.querySelectorAll('#metadataEditor input').forEach((input) => input.addEventListener('input', markEditorDirty));
document.querySelectorAll('#editorToolbar button').forEach((button) => {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => applyEditorCommand(button));
});
byId('assetInput').addEventListener('change', (event) => {
  const [file] = event.currentTarget.files;
  uploadAsset(file);
  event.currentTarget.value = '';
});
byId('blockFormat').addEventListener('change', (event) => {
  byId('fileEditor').focus();
  document.execCommand('formatBlock', false, event.currentTarget.value);
  markEditorDirty();
});
byId('createFileForm').addEventListener('submit', createFile);
byId('syncClaudeAssets').addEventListener('click', syncClaudeAssets);
byId('cancelCreateFile').addEventListener('click', () => byId('createFileDialog').close());
byId('addClaudePluginBtn').addEventListener('click', openPluginComponentsDialog);
byId('cancelPluginComponents').addEventListener('click', () => byId('pluginComponentsDialog').close());
byId('closePluginComponentsDialog').addEventListener('click', () => byId('pluginComponentsDialog').close());
document.querySelectorAll('[data-plugin-tab]').forEach((button) => button.addEventListener('click', () => switchPluginTab(button.dataset.pluginTab)));
byId('registerLegalMarketplace').addEventListener('click', () => legalMarketplace.registerMarketplace());
byId('legalSearch').addEventListener('input', (event) => legalMarketplace.setSearch(event.currentTarget.value));
byId('applyLegalComponents').addEventListener('click', () => legalMarketplace.applySelection());
byId('registerOfficialMarketplace').addEventListener('click', () => officialMarketplace.registerMarketplace());
byId('marketplaceSearch').addEventListener('input', (event) => officialMarketplace.setSearch(event.currentTarget.value));
byId('applyMarketplaceComponents').addEventListener('click', () => officialMarketplace.applySelection());
window.addEventListener('beforeunload', (event) => {
  if (selectedFile && editorTouched) event.preventDefault();
});

initLogViewer();
initPerformanceMonitoring();
loadAdminTheme();

const requestedTab = location.hash.slice(1);
setActiveTab(['history', 'configuration', 'pieces', 'files'].includes(requestedTab) ? requestedTab : 'history');
// Un hash de section peut faire défiler le document avant que les panneaux
// inactifs ne soient masqués. La coque tient déjà dans le viewport : on la
// replace explicitement en haut après l'activation de l'onglet demandé.
requestAnimationFrame(() => window.scrollTo(0, 0));
loadStatus();

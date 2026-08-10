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
let selectedFile = null;
let currentFrontMatter = '';
let editorTouched = false;
let filesLoaded = false;
let historyLoaded = false;
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
      byId('workspacePath').value = data.config.workspacePath || '';
      byId('port').value = data.config.port || 43098;
      byId('pythonPath').value = data.config.pythonPath || data.env.PYTHON_PATH || '';
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
          workspacePath: form.get('workspacePath'),
          port: Number(form.get('port')),
          pythonPath: form.get('pythonPath'),
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

const CLAUDE_ASSET_BADGES = {
  linked: { text: 'Claude Code', className: 'ok', title: 'Enregistré dans Claude Code (lien vers le dépôt).' },
  copied: { text: 'Claude Code', className: 'ok', title: 'Enregistré dans Claude Code (copie synchronisée à chaque enregistrement).' },
  stale: { text: 'À réenregistrer', className: 'warn', title: 'Enregistrement PieceMaker périmé (autre installation) — « ⟳ Claude Code » le reprend.' },
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
    const adopted = result.adopted ? `, dont ${result.adopted} repris d’une autre installation` : '';
    setMessage(message, `${result.registered} skill(s)/agent(s) enregistré(s)${adopted}${conflicts}.`, conflicts ? 'error' : 'success');
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
  return traceAsync('loadFiles', async () => {
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
  const list = byId('originalList');
  const originals = visibleOriginals().slice().sort((a, b) => {
    if (a.protected !== b.protected) return a.protected ? 1 : -1;
    return a.path.localeCompare(b.path, 'fr');
  });
  list.textContent = '';
  if (historyView === 'protected') {
    byId('historyTitle').textContent = originalsScope === 'all' ? 'Pièces du dossier' : 'Pièces non traitées';
    byId('historyCount').textContent = `${originals.length} pièce${originals.length > 1 ? 's' : ''}`;
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
    list.append(createHistoryEmpty('Sélectionnez un dossier'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }
  if (!originals.length) {
    list.append(originalsScope === 'all'
      ? createHistoryEmpty('Aucune pièce', 'Ce dossier ne contient aucun document hors Markdown.')
      : createHistoryEmpty('Toutes les pièces sont traitées', 'Basculez sur « Toutes » pour gérer leur protection.'));
    updateOriginalsActions();
    renderMappingSummary();
    return;
  }

  const fragment = document.createDocumentFragment();
  const groups = [
    { protected: false, label: 'Pièces accessibles à l’IA' },
    { protected: true, label: 'Pièces protégées' },
  ];
  for (const group of groups) {
    const groupOriginals = originals.filter((original) => original.protected === group.protected);
    if (!groupOriginals.length) continue;
    const heading = document.createElement('div');
    heading.className = 'original-group-title';
    const headingLabel = document.createElement('span');
    headingLabel.textContent = group.label;
    const headingCount = document.createElement('span');
    headingCount.className = 'count-badge';
    headingCount.textContent = String(groupOriginals.length);
    heading.append(headingLabel, headingCount);
    fragment.append(heading);
    for (const original of groupOriginals) {
      const selectable = known.has(original.path);
      const row = document.createElement('label');
      row.className = `original-row${selectedOriginals.has(original.path) ? ' selected' : ''}`;
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
      badges.append(shieldButton(original));
      row.append(checkbox, body, badges);
      fragment.append(row);
    }
  }
  list.append(fragment);
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
  byId('mappingName').textContent = legalCase?.mapping?.name || 'Aucun mapping';
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
  byId('mappingView').hidden = view !== 'mapping';
  byId('telegramCaseView').hidden = view !== 'telegram';
  byId('caseTelegramCard').classList.toggle('active', view === 'telegram');
  if (view !== 'diff') {
    revisionRequestSerial += 1;
    setChangedFilesPane(false);
  }
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
  list.textContent = '';
  updateManualCommitForm();
  const protectedMode = historyView === 'protected';
  byId('protectedTools').hidden = !protectedMode;
  byId('originalList').hidden = !protectedMode;
  list.hidden = protectedMode;
  if (protectedMode) {
    renderOriginals();
    if (detailView === 'diff') showRevisionPlaceholder('Sélectionnez une modification ou ouvrez le mapping');
    return;
  }
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
    // Le diff est volontairement paresseux : aucun calcul au rendu ou au
    // rafraîchissement, seulement après un clic explicite sur une modification.
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
      byId('revisionMeta').textContent = revision.kind === 'worktree'
        ? `${revision.filesCount} fichier${revision.filesCount > 1 ? 's' : ''} modifié${revision.filesCount > 1 ? 's' : ''}`
        : `${revision.author} · ${new Date(revision.timestamp).toLocaleString('fr-FR')} · ${revision.filesCount} fichier${revision.filesCount > 1 ? 's' : ''}`;
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

async function setHistoryView(view) {
  historyView = view;
  selectedRevision = null;
  showRevisionPlaceholder(view === 'protected'
    ? 'Sélectionnez une modification ou ouvrez le mapping'
    : view === 'changes' ? 'Sélectionnez une modification' : 'Sélectionnez un commit');
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
byId('caseTelegramCard').addEventListener('click', openCaseTelegramEditor);
byId('telegramCaseView').addEventListener('submit', saveCaseTelegramBot);

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

initLogViewer();
initPerformanceMonitoring();

const requestedTab = location.hash.slice(1);
setActiveTab(['history', 'settings', 'pieces', 'telegram', 'files'].includes(requestedTab) ? requestedTab : 'history');
loadStatus();

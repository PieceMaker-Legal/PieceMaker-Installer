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

document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
byId('settingsForm').addEventListener('submit', saveSettings);
byId('saveFile').addEventListener('click', saveFile);
byId('fileEditor').addEventListener('input', (event) => {
  byId('dirtyBadge').hidden = event.currentTarget.value === originalContent;
});
window.addEventListener('beforeunload', (event) => {
  if (selectedFile && byId('fileEditor').value !== originalContent) event.preventDefault();
});

loadStatus();

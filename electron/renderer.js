const { ipcRenderer } = require('electron');
// Exposer ipcRenderer pour les boutons HTML inline
window.ipcRenderer = require('electron').ipcRenderer;

let serverRunning = false;
let mcpRunning = false;
let pendingUpdate = null;

// Éléments DOM
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const serverStatus = document.getElementById('serverStatus');
const mcpStatus = document.getElementById('mcpStatus');
const serverDot = document.getElementById('serverDot');
const mcpDot = document.getElementById('mcpDot');
const serverPort = document.getElementById('serverPort');
const logsSection = document.getElementById('logsSection');
const logs = document.getElementById('logs');

// Initialisation
init();

async function init() {
    // Charger le chemin du manifest
    try {
        const addonPath = await ipcRenderer.invoke('get-addon-path');
        const manifestFilePath = `${addonPath}/manifest.xml`;

        // Stocker dans une variable globale pour usage ultérieur
        window.manifestFilePath = manifestFilePath;
    } catch (error) {
        console.error('Erreur chargement manifest path:', error);
    }

    // Charger la version de l'addon
    await loadAddonVersion();

    // Vérifier le statut initial
    await updateStatus();

    // Mettre à jour le statut toutes les 3 secondes
    setInterval(updateStatus, 3000);
}

async function loadAddonVersion() {
    try {
        const result = await ipcRenderer.invoke('get-addon-version');
        if (result.success) {
            const versionEl = document.getElementById('addonVersion');
            if (versionEl) {
                versionEl.textContent = `v${result.version}`;
            }
        }
    } catch (error) {
        console.error('Erreur chargement version:', error);
    }
}

async function updateStatus() {
    try {
        const status = await ipcRenderer.invoke('get-server-status');
        
        serverRunning = status.serverRunning;
        mcpRunning = status.mcpRunning;
        
        // Mise à jour serveur local
        if (serverRunning) {
            serverStatus.textContent = 'En cours d\'exécution';
            serverDot.classList.remove('stopped');
            serverDot.classList.add('running');
            startBtn.disabled = true;
            stopBtn.disabled = false;
        } else {
            serverStatus.textContent = 'Arrêté';
            serverDot.classList.remove('running');
            serverDot.classList.add('stopped');
            startBtn.disabled = false;
            stopBtn.disabled = true;
        }
        
        // Mise à jour serveur MCP
        if (mcpRunning) {
            mcpStatus.textContent = 'En cours d\'exécution';
            mcpDot.classList.remove('stopped');
            mcpDot.classList.add('running');
        } else {
            mcpStatus.textContent = 'Arrêté';
            mcpDot.classList.remove('running');
            mcpDot.classList.add('stopped');
        }
        
        serverPort.textContent = status.port;
        
    } catch (error) {
        console.error('Erreur mise à jour statut:', error);
    }
}

// Démarrer les serveurs
startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.innerHTML = '<span>⏳</span><span>Démarrage...</span>';
    
    addLog('Démarrage des serveurs...', 'info');
    logsSection.style.display = 'block';
    
    try {
        const result = await ipcRenderer.invoke('start-servers');
        
        if (result.success) {
            addLog('✅ Serveurs démarrés avec succès', 'success');
            addLog(`🌐 Serveur local accessible sur https://localhost:${result.port}`, 'info');
            await updateStatus();
        } else {
            addLog(`❌ Erreur: ${result.error}`, 'error');
            startBtn.disabled = false;
            startBtn.innerHTML = '<span>▶️</span><span>Démarrer les serveurs</span>';
        }
    } catch (error) {
        addLog(`❌ Erreur: ${error.message}`, 'error');
        startBtn.disabled = false;
        startBtn.innerHTML = '<span>▶️</span><span>Démarrer les serveurs</span>';
    }
});

// Arrêter les serveurs
stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    addLog('Arrêt des serveurs...', 'info');
    
    try {
        await ipcRenderer.invoke('stop-servers');
        addLog('✅ Serveurs arrêtés', 'success');
        await updateStatus();
    } catch (error) {
        addLog(`❌ Erreur: ${error.message}`, 'error');
    }
});

// Ajouter un log
function addLog(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logs.appendChild(entry);
    logs.scrollTop = logs.scrollHeight;
    
    // Limiter à 100 entrées
    while (logs.children.length > 100) {
        logs.removeChild(logs.firstChild);
    }
}

// Recevoir les logs du serveur
ipcRenderer.on('server-log', (event, data) => {
    addLog(data.message, data.type);
});

ipcRenderer.on('server-status', (event, status) => {
    if (status === 'stopped') {
        addLog('⚠️ Le serveur s\'est arrêté', 'error');
        updateStatus();
    }
});

// ============================================
// GESTION DES MISES À JOUR
// ============================================

// Recevoir la notification de mise à jour disponible
ipcRenderer.on('update-available', (event, updateInfo) => {
    pendingUpdate = updateInfo;
    showUpdateNotification(updateInfo);
});

// Recevoir la progression de téléchargement
ipcRenderer.on('update-progress', (event, progress) => {
    updateProgressDisplay(progress);
});

// Vérifier manuellement les mises à jour
async function checkForUpdates() {
    try {
        addLog('🔍 Vérification des mises à jour...', 'info');
        
        const result = await ipcRenderer.invoke('check-for-updates');
        
        if (result.success && result.update && result.update.available) {
            pendingUpdate = result.update;
            showUpdateNotification(result.update);
        } else if (result.success) {
            addLog('✅ Aucune mise à jour disponible', 'success');
        } else {
            addLog(`⚠️ Erreur vérification MAJ: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Erreur vérification MAJ:', error);
    }
}

// Afficher la notification de mise à jour
function showUpdateNotification(updateInfo) {
    // Créer l'élément de notification
    const notification = document.createElement('div');
    notification.id = 'updateNotification';
    notification.className = 'update-notification';
    notification.innerHTML = `
        <div class="update-header">
            <span class="update-icon">🔔</span>
            <span class="update-title">Mise à jour disponible</span>
            <button class="update-close" onclick="closeUpdateNotification()">×</button>
        </div>
        <div class="update-content">
            <p class="update-version">Version ${updateInfo.version} disponible</p>
            <p class="update-description">${updateInfo.description}</p>
            ${updateInfo.changelog && updateInfo.changelog.length > 0 ? `
                <div class="update-changelog">
                    <strong>Nouveautés :</strong>
                    <ul>
                        ${updateInfo.changelog.map(item => `<li>${item}</li>`).join('')}
                    </ul>
                </div>
            ` : ''}
            <p class="update-size">Taille : ${formatBytes(updateInfo.size)}</p>
            ${updateInfo.mandatory ? '<p class="update-mandatory">⚠️ Cette mise à jour est obligatoire</p>' : ''}
        </div>
        <div class="update-actions">
            ${!updateInfo.mandatory ? `
                <button class="btn-secondary" onclick="skipUpdate()">Plus tard</button>
            ` : ''}
            <button class="btn-primary" onclick="installUpdate()">Installer</button>
        </div>
    `;

    // Supprimer l'ancienne notification si elle existe
    const existing = document.getElementById('updateNotification');
    if (existing) {
        existing.remove();
    }

    // Ajouter la nouvelle notification
    document.body.appendChild(notification);
    
    addLog(`🔔 Mise à jour ${updateInfo.version} disponible`, 'info');
}

// Fermer la notification
window.closeUpdateNotification = function() {
    const notification = document.getElementById('updateNotification');
    if (notification) {
        notification.remove();
    }
};

// Ignorer la mise à jour
window.skipUpdate = async function() {
    if (pendingUpdate) {
        await ipcRenderer.invoke('skip-update', pendingUpdate.version);
        closeUpdateNotification();
        addLog('⏭️ Mise à jour ignorée', 'info');
    }
};

// Installer la mise à jour
window.installUpdate = async function() {
    if (!pendingUpdate) return;

    try {
        // Désactiver les boutons pendant l'installation
        const notification = document.getElementById('updateNotification');
        if (notification) {
            const actions = notification.querySelector('.update-actions');
            actions.innerHTML = '<p class="update-installing">Installation en cours...</p>';
        }

        addLog('📥 Téléchargement de la mise à jour...', 'info');

        // Créer la barre de progression
        showUpdateProgress();

        const result = await ipcRenderer.invoke('install-update', pendingUpdate);

        if (result.success && result.needsRestart) {
            addLog('✅ Téléchargement terminé !', 'success');
            addLog('🔄 Redémarrage dans 2 secondes...', 'info');
            
            closeUpdateNotification();
            hideUpdateProgress();
            
            // Redémarrer après 2 secondes
            setTimeout(async () => {
                await ipcRenderer.invoke('restart-app');
            }, 2000);
        } else {
            addLog(`❌ Erreur installation: ${result.error}`, 'error');
            closeUpdateNotification();
            hideUpdateProgress();
        }
    } catch (error) {
        addLog(`❌ Erreur: ${error.message}`, 'error');
        closeUpdateNotification();
        hideUpdateProgress();
    }
};

// Afficher la barre de progression
function showUpdateProgress() {
    const progressContainer = document.createElement('div');
    progressContainer.id = 'updateProgress';
    progressContainer.className = 'update-progress-container';
    progressContainer.innerHTML = `
        <div class="update-progress-header">
            <span>Téléchargement en cours...</span>
            <span id="progressPercent">0%</span>
        </div>
        <div class="update-progress-bar">
            <div id="progressBar" class="update-progress-fill"></div>
        </div>
        <div id="progressDetails" class="update-progress-details"></div>
    `;

    document.body.appendChild(progressContainer);
}

// Mettre à jour l'affichage de la progression
function updateProgressDisplay(progress) {
    const progressBar = document.getElementById('progressBar');
    const progressPercent = document.getElementById('progressPercent');
    const progressDetails = document.getElementById('progressDetails');

    if (progressBar && progressPercent) {
        const percent = Math.round(progress.overallProgress);
        progressBar.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
    }

    if (progressDetails && progress.file) {
        progressDetails.textContent = `Fichier ${progress.currentFile}/${progress.totalFiles} : ${progress.file}`;
    }
}

// Masquer la barre de progression
function hideUpdateProgress() {
    const progressContainer = document.getElementById('updateProgress');
    if (progressContainer) {
        progressContainer.remove();
    }
}

// Proposer de redémarrer
function showRestartPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'update-notification';
    prompt.innerHTML = `
        <div class="update-header">
            <span class="update-icon">✅</span>
            <span class="update-title">Mise à jour installée</span>
        </div>
        <div class="update-content">
            <p>La mise à jour a été installée avec succès.</p>
            <p>Redémarrez l'application pour appliquer les changements.</p>
        </div>
        <div class="update-actions">
            <button class="btn-secondary" onclick="this.parentElement.parentElement.remove()">Plus tard</button>
            <button class="btn-primary" onclick="restartApp()">Redémarrer</button>
        </div>
    `;

    document.body.appendChild(prompt);
}

// Redémarrer l'application
window.restartApp = async function() {
    await ipcRenderer.invoke('restart-app');
};

// Formater les octets
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Afficher la version de l'addon
async function loadAddonVersion() {
    try {
        const result = await ipcRenderer.invoke('get-addon-version');
        if (result.success) {
            document.getElementById('addonVersion').textContent = `v${result.version}`;
            console.log('Version addon:', result.version);
        }
    } catch (error) {
        console.error('Erreur chargement version:', error);
        document.getElementById('addonVersion').textContent = 'v1.0.0';
    }
}

// Charger la version au démarrage
loadAddonVersion();

// Fonction pour ouvrir des liens externes
window.openExternal = async (url) => {
    await ipcRenderer.invoke('open-url', url);
    addLog(`🔗 Ouverture de ${url}`, 'info');
};

// Gérer les erreurs non capturées
window.addEventListener('error', (event) => {
    addLog(`❌ Erreur: ${event.message}`, 'error');
});

window.addEventListener('unhandledrejection', (event) => {
    addLog(`❌ Promesse rejetée: ${event.reason}`, 'error');
});
// ============================================
// GESTION DE LA CLÉ API MCP
// ============================================

const mcpUrlInput = document.getElementById('mcpUrl');
const mcpApiKeyInput = document.getElementById('mcpApiKey');
const toggleApiKeyBtn = document.getElementById('toggleApiKeyBtn');
const testApiKeyBtn = document.getElementById('testApiKeyBtn');
const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
const clearApiKeyBtn = document.getElementById('clearApiKeyBtn');
const mcpConfigStatus = document.getElementById('mcpConfigStatus');
const apiKeyTestResult = document.getElementById('apiKeyTestResult');

let isApiKeyValid = false;
let currentApiKey = null;

// Charger la configuration MCP au démarrage
async function loadMCPConfig() {
    try {
        const url = await ipcRenderer.invoke('store-get', 'mcp-url');
        const apiKey = await ipcRenderer.invoke('store-get', 'mcp-api-key');

        if (url) {
            mcpUrlInput.value = url;
        } else {
            mcpUrlInput.value = 'https://mcp.festival-letino-app.com/mcp-remote/mcp';
        }

        if (apiKey) {
            mcpApiKeyInput.value = apiKey;
            currentApiKey = apiKey;
            showConfigStatus('valid', '✅ Clé API enregistrée');
            isApiKeyValid = true;
            saveApiKeyBtn.disabled = true;
        } else {
            showConfigStatus('info', 'ℹ️ Aucune clé API configurée. Veuillez en ajouter une.');
        }
    } catch (error) {
        console.error('Erreur chargement config MCP:', error);
        addLog('❌ Erreur chargement config MCP', 'error');
    }
}

// Afficher le statut de la config
function showConfigStatus(type, message) {
    mcpConfigStatus.style.display = 'block';
    mcpConfigStatus.className = '';
    mcpConfigStatus.style.padding = '12px';
    mcpConfigStatus.style.borderRadius = '6px';
    
    if (type === 'valid') {
        mcpConfigStatus.className = 'status-valid';
    } else if (type === 'invalid') {
        mcpConfigStatus.className = 'status-invalid';
    } else if (type === 'testing') {
        mcpConfigStatus.className = 'status-testing';
    } else {
        mcpConfigStatus.style.background = 'rgba(0, 212, 255, 0.1)';
        mcpConfigStatus.style.borderLeft = '3px solid #00d4ff';
        mcpConfigStatus.style.color = '#00d4ff';
    }
    
    mcpConfigStatus.innerHTML = `<p style="margin: 0;">${message}</p>`;
}

// Afficher le résultat du test
function showTestResult(type, message) {
    apiKeyTestResult.style.display = 'block';
    apiKeyTestResult.className = '';
    
    if (type === 'success') {
        apiKeyTestResult.className = 'status-valid';
    } else if (type === 'error') {
        apiKeyTestResult.className = 'status-invalid';
    }
    
    apiKeyTestResult.style.padding = '12px';
    apiKeyTestResult.style.borderRadius = '6px';
    apiKeyTestResult.innerHTML = `<p style="margin: 0;">${message}</p>`;
}

// Toggle affichage clé API
toggleApiKeyBtn.addEventListener('click', () => {
    if (mcpApiKeyInput.type === 'password') {
        mcpApiKeyInput.type = 'text';
        toggleApiKeyBtn.textContent = '🙈';
        toggleApiKeyBtn.title = 'Masquer';
    } else {
        mcpApiKeyInput.type = 'password';
        toggleApiKeyBtn.textContent = '👁️';
        toggleApiKeyBtn.title = 'Afficher';
    }
});

// Détecter les modifications de la clé
mcpApiKeyInput.addEventListener('input', () => {
    const newValue = mcpApiKeyInput.value.trim();
    
    if (newValue !== currentApiKey) {
        saveApiKeyBtn.disabled = false;
        isApiKeyValid = false;
        apiKeyTestResult.style.display = 'none';
        
        if (newValue && !newValue.startsWith('lca_')) {
            showTestResult('error', '⚠️ La clé doit commencer par "lca_"');
        } else {
            apiKeyTestResult.style.display = 'none';
        }
    } else {
        saveApiKeyBtn.disabled = true;
    }
});

// Tester la clé API
testApiKeyBtn.addEventListener('click', async () => {
    const apiKey = mcpApiKeyInput.value.trim();

    if (!apiKey) {
        showTestResult('error', '❌ Veuillez entrer une clé API');
        return;
    }

    if (!apiKey.startsWith('lca_')) {
        showTestResult('error', '❌ Format invalide. La clé doit commencer par "lca_"');
        return;
    }

    testApiKeyBtn.disabled = true;
    testApiKeyBtn.innerHTML = '<span>⏳</span><span>Test en cours...</span>';
    showConfigStatus('testing', '🧪 Test de la clé API en cours...');
    addLog('🧪 Test de la clé API MCP...', 'info');

    try {
        const response = await fetch(mcpUrlInput.value, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            })
        });

        const text = await response.text();
        let data;

        try {
            data = text ? JSON.parse(text) : {};
        } catch (parseError) {
            throw new Error('Réponse invalide du serveur MCP');
        }

        if (response.ok && data.result && data.result.tools) {
            isApiKeyValid = true;
            const toolCount = data.result.tools.length;
            showConfigStatus('valid', `✅ Clé valide ! ${toolCount} outils disponibles`);
            showTestResult('success', `✅ Connexion réussie ! ${toolCount} outils MCP détectés`);
            saveApiKeyBtn.disabled = false;
            addLog(`✅ Clé API valide (${toolCount} outils)`, 'success');
        } else {
            isApiKeyValid = false;
            showConfigStatus('invalid', '❌ Réponse invalide du serveur MCP');
            showTestResult('error', '❌ Réponse invalide du serveur MCP');
            addLog('❌ Test de clé échoué : réponse invalide', 'error');
        }
    } catch (error) {
        isApiKeyValid = false;
        const errorMsg = error.message || 'Erreur de connexion';
        showConfigStatus('invalid', `❌ ${errorMsg}`);
        showTestResult('error', `❌ ${errorMsg}`);
        addLog(`❌ Test de clé échoué : ${errorMsg}`, 'error');
    } finally {
        testApiKeyBtn.disabled = false;
        testApiKeyBtn.innerHTML = '<span>🧪</span><span>Tester la clé</span>';
    }
});

// Enregistrer la clé API
saveApiKeyBtn.addEventListener('click', async () => {
    if (!isApiKeyValid) {
        showTestResult('error', '❌ Veuillez d\'abord tester la clé avant de l\'enregistrer');
        return;
    }

    try {
        const apiKey = mcpApiKeyInput.value.trim();
        const url = mcpUrlInput.value.trim();

        await ipcRenderer.invoke('store-set', 'mcp-api-key', apiKey);
        await ipcRenderer.invoke('store-set', 'mcp-url', url);

        currentApiKey = apiKey;
        showConfigStatus('valid', '✅ Configuration enregistrée avec succès');
        showTestResult('success', '✅ Clé API enregistrée. Redémarrez les serveurs pour appliquer les changements.');
        saveApiKeyBtn.disabled = true;
        
        addLog('✅ Configuration MCP mise à jour', 'success');
        addLog('⚠️ Redémarrez les serveurs pour appliquer les changements', 'info');
    } catch (error) {
        showTestResult('error', `❌ Erreur lors de l'enregistrement: ${error.message}`);
        addLog(`❌ Erreur enregistrement clé : ${error.message}`, 'error');
    }
});

// Effacer la clé API
clearApiKeyBtn.addEventListener('click', async () => {
    const confirm = window.confirm('Êtes-vous sûr de vouloir effacer la clé API ?');
    
    if (confirm) {
        try {
            await ipcRenderer.invoke('store-delete', 'mcp-api-key');
            mcpApiKeyInput.value = '';
            currentApiKey = null;
            isApiKeyValid = false;
            saveApiKeyBtn.disabled = true;
            apiKeyTestResult.style.display = 'none';
            showConfigStatus('info', 'ℹ️ Clé API effacée. Configurez une nouvelle clé.');
            addLog('🗑️ Clé API effacée', 'info');
        } catch (error) {
            showTestResult('error', `❌ Erreur: ${error.message}`);
            addLog(`❌ Erreur effacement clé : ${error.message}`, 'error');
        }
    }
});

// Charger la config MCP au démarrage (après l'init existante)
loadMCPConfig();

// ============================================
// INSTALLATION AUTOMATIQUE
// ============================================

const autoInstallManifestBtn = document.getElementById('autoInstallManifestBtn');
const autoInstallCertificatesBtn = document.getElementById('autoInstallCertificatesBtn');
const autoInstallClaudeConfigBtn = document.getElementById('autoInstallClaudeConfigBtn');
const manifestInstallResult = document.getElementById('manifestInstallResult');
const certificatesInstallResult = document.getElementById('certificatesInstallResult');
const claudeConfigInstallResult = document.getElementById('claudeConfigInstallResult');

// Fonction pour afficher un résultat d'installation
function showInstallResult(element, type, message) {
  element.style.display = 'block';
  element.className = '';
  
  if (type === 'success') {
    element.className = 'status-valid';
  } else if (type === 'error') {
    element.className = 'status-invalid';
  } else {
    element.className = 'status-testing';
  }
  
  element.style.padding = '12px';
  element.style.borderRadius = '6px';
  element.innerHTML = `<p style="margin: 0;">${message}</p>`;
}

// Installer le manifest Word
autoInstallManifestBtn.addEventListener('click', async () => {
  autoInstallManifestBtn.disabled = true;
  autoInstallManifestBtn.innerHTML = '<span>⏳</span><span>Installation...</span>';
  
  addLog('📦 Installation du manifest Word...', 'info');
  showInstallResult(manifestInstallResult, 'info', '⏳ Installation en cours...');
  
  try {
    const result = await ipcRenderer.invoke('auto-install-manifest');

    if (result.success) {
      const detailsHtml = result.details
        ? `<br><small style="font-size: 11px; opacity: 0.8;">${result.details}</small>`
        : '';

      let instructionsHtml = '';
      if (result.instructions && result.instructions.length > 0) {
        instructionsHtml = '<br><div style="text-align: left; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">' +
          '<strong>📖 Comment utiliser :</strong><br>' +
          result.instructions.map(i => `<small>• ${i}</small>`).join('<br>') +
          '</div>';
      }

      showInstallResult(manifestInstallResult, 'success', `✅ ${result.message}${detailsHtml}<br><small style="font-size: 12px;">Chemin: ${result.path}</small>${instructionsHtml}`);
      addLog('✅ Catalogue de compléments configuré avec succès', 'success');
      if (result.details) {
        addLog(`📋 ${result.details}`, 'info');
      }
      addLog(`📂 Chemin: ${result.path}`, 'info');
      addLog('', 'info');
      addLog('📖 ÉTAPES SUIVANTES:', 'warning');
      if (result.instructions) {
        result.instructions.forEach(instruction => {
          addLog(`  ${instruction}`, 'info');
        });
      }
    } else {
      showInstallResult(manifestInstallResult, 'error', `❌ Erreur: ${result.error}`);
      addLog(`❌ Erreur installation manifest: ${result.error}`, 'error');
    }
  } catch (error) {
    showInstallResult(manifestInstallResult, 'error', `❌ Erreur: ${error.message}`);
    addLog(`❌ Erreur: ${error.message}`, 'error');
  } finally {
    autoInstallManifestBtn.disabled = false;
    autoInstallManifestBtn.innerHTML = '<span>📦</span><span>Installer le manifest Word</span>';
  }
});

// Installer/Approuver les certificats SSL (Certificat CA Root)
autoInstallCertificatesBtn.addEventListener('click', async () => {
  autoInstallCertificatesBtn.disabled = true;
  autoInstallCertificatesBtn.innerHTML = '<span>⏳</span><span>Installation...</span>';

  addLog('🔐 Installation du certificat CA...', 'info');
  showInstallResult(certificatesInstallResult, 'info', '⏳ Installation du CA...');

  try {
    const result = await ipcRenderer.invoke('install-ssl-certificates');

    if (result.success) {
      // L'assistant Windows a été ouvert
      let instructionsHtml = '';

      if (result.instructions && result.instructions.length > 0) {
        instructionsHtml += '<br><div style="text-align: left; margin-top: 8px; padding: 8px; background: rgba(76,175,80,0.15); border-radius: 4px; border-left: 3px solid #4CAF50;">' +
          '<strong style="color: #4CAF50;">📖 Suivez l\'assistant Windows qui vient de s\'ouvrir:</strong><br><br>' +
          result.instructions.map(i => {
            if (i.includes('👉') || i.includes('📝')) {
              return `<strong style="color: #4CAF50;">${i}</strong>`;
            } else if (i.trim() === '') {
              return '<br>';
            } else {
              return `<small style="line-height: 1.8;">${i}</small>`;
            }
          }).join('<br>') +
          '</div>';
      }

      showInstallResult(certificatesInstallResult, 'success', `✅ ${result.message}${instructionsHtml}`);
      addLog('✅ Assistant d\'installation du certificat ouvert', 'success');
      addLog('', 'info');
      addLog('📖 SUIVEZ L\'ASSISTANT WINDOWS:', 'info');

      if (result.instructions) {
        result.instructions.forEach(instruction => {
          if (instruction.trim() !== '') {
            addLog(`  ${instruction}`, 'info');
          }
        });
      }
    } else if (result.needsManualInstall) {
      // Installation manuelle requise
      let warningHtml = `⚠️ ${result.message}`;

      // Bouton cliquable pour ouvrir le certificat DIRECTEMENT
        if (result.certPath) {
        warningHtml += '<br><div style="text-align: left; margin-top: 8px; padding: 8px; background: rgba(255,152,0,0.2); border-radius: 4px; border-left: 3px solid #FF9800;">' +
            '<strong>📁 Certificat à installer:</strong><br>' +
            `<button onclick="window.ipcRenderer.invoke('open-certificate', '${result.certPath}')" style="margin-top: 8px; padding: 6px 12px; background: #FF9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">` +
            '🔐 Ouvrir le certificat (installation manuelle)' +
            '</button>' +
            '</div>';
        }

      // Afficher les instructions manuelles
      if (result.manualInstructions && result.manualInstructions.length > 0) {
        warningHtml += '<br><div style="text-align: left; margin-top: 8px; padding: 8px; background: rgba(255,255,0,0.15); border-radius: 4px; max-height: 300px; overflow-y: auto;">' +
          result.manualInstructions.map(i => {
            if (i.startsWith('📋') || i.includes('INSTALLATION')) {
              return `<strong style="color: #FF9800;">${i}</strong>`;
            } else if (i.trim() === '') {
              return '<br>';
            } else {
              return `<small style="line-height: 1.6;">${i}</small>`;
            }
          }).join('<br>') +
          '</div>';
      }

      showInstallResult(certificatesInstallResult, 'warning', warningHtml);
      addLog(`⚠️ ${result.message}`, 'warning');

      if (result.manualInstructions) {
        addLog('', 'info');
        addLog('📖 INSTALLATION MANUELLE REQUISE:', 'warning');
        result.manualInstructions.forEach(instruction => {
          addLog(`  ${instruction}`, 'info');
        });
      }
    } else {
      // Erreur complète
      let errorHtml = `❌ ${result.error || 'Erreur inconnue'}`;

      if (result.details) {
        errorHtml += '<br><div style="text-align: left; margin-top: 8px; padding: 8px; background: rgba(244,67,54,0.1); border-radius: 4px; max-height: 150px; overflow-y: auto;">' +
          `<small style="font-family: monospace; font-size: 10px;">${result.details}</small>` +
          '</div>';
      }

      showInstallResult(certificatesInstallResult, 'error', errorHtml);
      addLog(`❌ ${result.error || 'Erreur inconnue'}`, 'error');
    }
  } catch (error) {
    showInstallResult(certificatesInstallResult, 'error', `❌ Erreur: ${error.message}`);
    addLog(`❌ Erreur: ${error.message}`, 'error');
  } finally {
    autoInstallCertificatesBtn.disabled = false;
    autoInstallCertificatesBtn.innerHTML = '<span>🔐</span><span>Approuver les certificats SSL</span>';
  }
});

// Installer la config Claude Desktop
autoInstallClaudeConfigBtn.addEventListener('click', async () => {
  autoInstallClaudeConfigBtn.disabled = true;
  autoInstallClaudeConfigBtn.innerHTML = '<span>⏳</span><span>Installation...</span>';
  
  addLog('🤖 Installation de la config Claude Desktop...', 'info');
  showInstallResult(claudeConfigInstallResult, 'info', '⏳ Installation en cours...');
  
  try {
    const result = await ipcRenderer.invoke('auto-install-claude-config');
    
    if (result.success) {
      showInstallResult(
        claudeConfigInstallResult, 
        'success', 
        `✅ ${result.message}<br><small style="font-size: 12px;">Config: ${result.path}<br>Serveur: ${result.serverPath}</small>`
      );
      addLog('✅ Configuration Claude Desktop mise à jour', 'success');
      addLog(`📂 Fichier de config: ${result.path}`, 'info');
      addLog('⚠️ Redémarrez Claude Desktop pour voir le serveur MCP', 'info');
    } else {
      showInstallResult(claudeConfigInstallResult, 'error', `❌ Erreur: ${result.error}`);
      addLog(`❌ Erreur installation config Claude: ${result.error}`, 'error');
    }
  } catch (error) {
    showInstallResult(claudeConfigInstallResult, 'error', `❌ Erreur: ${error.message}`);
    addLog(`❌ Erreur: ${error.message}`, 'error');
  } finally {
    autoInstallClaudeConfigBtn.disabled = false;
    autoInstallClaudeConfigBtn.innerHTML = '<span>🤖</span><span>Installer la config Claude Desktop</span>';
  }
});

// Afficher les chemins d'installation au survol
autoInstallManifestBtn.addEventListener('mouseenter', async () => {
  const paths = await ipcRenderer.invoke('get-install-paths');
  autoInstallManifestBtn.title = `Installe dans: ${paths.wordWefPath}`;
});

autoInstallClaudeConfigBtn.addEventListener('mouseenter', async () => {
  const paths = await ipcRenderer.invoke('get-install-paths');
  autoInstallClaudeConfigBtn.title = `Installe dans: ${paths.claudeConfigPath}`;
});

// Ajouter un bouton pour vérifier manuellement les MAJ
const checkUpdateBtn = document.createElement('button');
checkUpdateBtn.textContent = '🔍 Vérifier les mises à jour';
checkUpdateBtn.className = 'btn-secondary';
checkUpdateBtn.onclick = checkForUpdates;
// Ajouter ce bouton à l'interface selon votre layout

// ============================================
// OUVRIR LE DOSSIER OUTPUT/RESSOURCES
// ============================================

const openOutputFolderBtn = document.getElementById('openOutputFolderBtn');

if (openOutputFolderBtn) {
  openOutputFolderBtn.addEventListener('click', async () => {
    try {
      addLog('📂 Ouverture du dossier output/ressources...', 'info');

      const result = await ipcRenderer.invoke('open-output-folder');

      if (result.success) {
        addLog(`✅ Dossier ouvert: ${result.path}`, 'success');
      } else {
        addLog(`❌ Erreur: ${result.error}`, 'error');
      }
    } catch (error) {
      addLog(`❌ Erreur: ${error.message}`, 'error');
      console.error('Erreur ouverture dossier:', error);
    }
  });
}

// Gestion de la configuration du dossier de sortie
const outputPathDisplay = document.getElementById('outputPathDisplay');
const selectOutputFolderBtn = document.getElementById('selectOutputFolderBtn');

// Charger et afficher le chemin de sortie actuel
async function loadOutputPath() {
  try {
    const result = await ipcRenderer.invoke('get-output-path');
    if (result.success) {
      outputPathDisplay.value = result.path;
      console.log('📂 Chemin de sortie chargé:', result.path);
    } else {
      outputPathDisplay.value = 'Erreur de chargement';
      console.error('❌ Erreur chargement chemin:', result.error);
    }
  } catch (error) {
    outputPathDisplay.value = 'Erreur de chargement';
    console.error('❌ Erreur chargement chemin de sortie:', error);
  }
}

// Sélectionner un nouveau dossier de sortie
if (selectOutputFolderBtn) {
  selectOutputFolderBtn.addEventListener('click', async () => {
    try {
      addLog('🔍 Sélection du dossier de sortie...', 'info');

      const result = await ipcRenderer.invoke('select-output-folder');

      if (result.success) {
        outputPathDisplay.value = result.path;
        addLog(`✅ Dossier de sortie défini: ${result.path}`, 'success');

        // Demander à l'utilisateur de redémarrer les serveurs
        addLog('⚠️ Veuillez redémarrer les serveurs pour appliquer les changements', 'warning');
      } else if (result.canceled) {
        addLog('ℹ️ Sélection annulée', 'info');
      } else {
        addLog(`❌ Erreur: ${result.error}`, 'error');
      }
    } catch (error) {
      addLog(`❌ Erreur: ${error.message}`, 'error');
      console.error('Erreur sélection dossier:', error);
    }
  });
}

// Charger le chemin de sortie au démarrage
loadOutputPath();

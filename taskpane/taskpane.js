import { initDependencies, openClaudeCLI, showCliTerminal, hideCliTerminal, cleanupCliTerminal, handlePtyMessage } from './modules/cli-terminal.js';
import { initPythonBridge, executePythonScript, executePythonScriptBatch, cancelPythonScript, handlePythonMessage } from './modules/python-bridge.js';
import {
  initDocToolsDependencies,
  readDoc,
  editDoc,
  markDocRead,
  validatePlaceholderContent,
  getAllPlaceholdersInDocument
} from './modules/doc-tools.js';
import * as AnonymizationModule from './modules/anonymization.js';
import { initOllamaAnalyzer, analyzeWithOllama, ollamaAnalyzeDocuments } from './modules/ollama-analyzer.js';
import { EDIT_DOC_TOOL, READ_DOC_TOOL, toEmbeddedTool } from './modules/word-tool-schemas.js';

// Debug: verify imports loaded
console.log('[DEBUG] doc-tools imports:', {
    readDoc: typeof readDoc,
    editDoc: typeof editDoc,
    markDocRead: typeof markDocRead
});

// Les implémentations des autres outils restent en place, mais le modèle du
// volet ne reçoit que cette surface minimale. Les schémas compacts évitent de
// renvoyer plusieurs milliers de tokens d'instructions à chaque tour.
const ENABLED_LOCAL_TOOL_NAMES = new Set(['read_doc', 'edit_doc']);
const ACTIVE_LOCAL_TOOL_SCHEMAS = new Map([
    [READ_DOC_TOOL.name, toEmbeddedTool(READ_DOC_TOOL)],
    [EDIT_DOC_TOOL.name, toEmbeddedTool(EDIT_DOC_TOOL)]
]);

// WebSocket pour communication avec le serveur
let ws = null;
let paneId = createPaneId();

function createPaneId() {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    const cryptoApi = window.crypto;
    const bytes = new Uint8Array(4);
    if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
        cryptoApi.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function documentRoutingHeaders() {
    const docUrl = Office.context.document.url || '';
    return {
        ...(docUrl ? { 'X-PieceMaker-Document': encodeURIComponent(docUrl) } : {}),
        'X-PieceMaker-Pane': paneId
    };
}

// Variable pour contrôler l'arrêt du LLM
let isProcessing = false;
let shouldStop = false;

// ============================================
// SYSTÈME D'ONGLETS DE CHAT
// ============================================
let chatTabs = [];
let activeTabId = null;
let nextTabId = 1;
let dossierTabId = 0; // ID fixe pour l'onglet Dossier (ne peut pas être fermé)
let dossierName = 'Dossier'; // Nom du dossier, sera mis à jour lors du chargement

// Structure d'un onglet:
// {
//   id: number,
//   type: 'dossier' | 'chat', // Type d'onglet
//   llmProvider: string,
//   llmModel: string,
//   conversationHistory: array,
//   chatContent: string (HTML du chat sauvegardé)
// }

// Fonctions pour contrôler le bouton send/stop
function setSendButtonToStop() {
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop-mode');
    sendBtn.onclick = stopProcessing;
    isProcessing = true;
    shouldStop = false;
}

function setSendButtonToSend() {
    const sendBtn = document.getElementById('sendBtn');
    sendBtn.textContent = '↑';
    sendBtn.classList.remove('stop-mode');
    sendBtn.onclick = sendMessage;
    isProcessing = false;
}

function stopProcessing() {
    shouldStop = true;
    addMessage('system', '⏹️ Arrêt en cours...');
}

// Fonction pour mettre à jour l'affichage de la progression d'anonymisation
function updateAnonymizationProgress(progress) {
    const statusElement = document.getElementById('anonymizationStatus');
    if (!statusElement) return;

    const { step, current, total, message } = progress;

    // Déterminer l'icône selon l'étape
    let icon = '⏳';
    if (step === 'complete') icon = '✅';
    else if (step === 'extraction') icon = '📄';
    else if (step === 'mapping') icon = '🔍';
    else if (step === 'application') icon = '🔒';

    // Calculer le pourcentage
    const percentage = total > 0 ? Math.round((current / total) * 100) : 0;

    // Afficher le message
    statusElement.innerHTML = `
        <div style="padding: 8px; background: #f0f0f0; border-radius: 4px; margin: 4px 0;">
            ${icon} <strong>${message}</strong>
            ${total > 1 ? `<br><small>${current}/${total} (${percentage}%)</small>` : ''}
        </div>
    `;

    // Supprimer le message après 3 secondes si c'est terminé
    if (step === 'complete') {
        setTimeout(() => {
            if (statusElement) {
                statusElement.innerHTML = '';
            }
        }, 3000);
    }
}

// Helper function to escape regex special characters
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function connectWebSocket() {
    try {
        ws = new WebSocket('wss://localhost:43098');

        ws.onopen = () => {
            console.log('✅ WebSocket connecté au serveur');
            try {
                const docUrl = Office.context.document.url || null;
                ws.send(JSON.stringify({ type: 'pane-hello', docUrl, paneId }));
            } catch (e) {
                console.warn('pane-hello non envoyé:', e);
            }
        };

        ws.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);
                console.log('📥 Message WebSocket reçu:', message);

                if (message.type === 'pane-bound' && message.paneId) {
                    paneId = message.paneId;
                    return;
                }

                if (message.type === 're-identify') {
                    try {
                        const docUrl = Office.context.document.url || null;
                        ws.send(JSON.stringify({ type: 'pane-hello', docUrl, paneId, reidentify: true }));
                    } catch (e) {
                        console.warn('re-identify échoué:', e);
                    }
                    return;
                }

                // Gérer la progression d'anonymisation
                if (message.type === 'anonymization-progress') {
                    updateAnonymizationProgress(message.progress);
                }

                // Gérer la progression OLLAMA
                if (message.type === 'ollama-progress') {
                    addMessageToDossierTab('system', message.message);
                }

                // Gérer les messages Python Bridge
                if (message.type && message.type.startsWith('python-')) {                         
                    handlePythonMessage(message);
                    return;                      
                    } 

                // Gérer les messages PTY (terminal CLI)
                if (message.type && message.type.startsWith('pty-')) {
                    handlePtyMessage(message);
                    return;
                }

                // Si c'est une requête d'outil depuis Claude Desktop
                if (message.requestId && message.action) {
                    const result = await handleToolRequest(message.action, message.params);

                    // Renvoyer le résultat au serveur
                    ws.send(JSON.stringify({
                        requestId: message.requestId,
                        result: result
                    }));
                }
            } catch (error) {
                console.error('Erreur traitement message WebSocket:', error);
            }
        };

        ws.onerror = (error) => {
            console.error('❌ Erreur WebSocket:', error);
        };

        ws.onclose = () => {
            console.log('❌ WebSocket déconnecté, reconnexion dans 5s...');
            setTimeout(connectWebSocket, 5000);
        };
    } catch (error) {
        console.error('Erreur création WebSocket:', error);
        setTimeout(connectWebSocket, 5000);
    }
}

// Gestionnaire pour exécuter les outils Word depuis Claude Desktop
async function handleToolRequest(action, params) {
    try {
        switch (action) {
            case 'read_doc':
                // A single snapshot can feed one edit_doc call, including edits[].
                markDocRead();
                return await readDoc(params);
            case 'edit_doc':
                return await editDoc(params);
            case 'read_case':
                return await localTools.read_case(params);
            case 'get_resource':
                return await localTools.get_resource(params);
            case 'draft':
                return await localTools.draft(params);
            case 'template_library':
                return await localTools.template_library(params);
            case 'stamping':
                return await localTools.stamping(params);
            case 'Call_Ollama':
                return await localTools.Call_Ollama(params);
            default:
                return { error: `Action inconnue: ${action}` };
        }
    } catch (error) {
        console.error(`Erreur exécution ${action}:`, error);
        return { error: error.message };
    }
}
function minimizeInterface() {
    document.body.classList.add('minimized');
}
function restoreInterface() {
    document.body.classList.remove('minimized');
}

// ============================================
// FONCTIONS DE GESTION DES ONGLETS
// ============================================

function getLLMDisplayName() {
    const provider = config.llmProvider;

    if (provider === 'ollama') {
        return config.modelName || 'Ollama';
    } else if (provider === 'claude') {
        return config.claudeModel?.split('-')[1]?.toUpperCase() || 'Claude';
    } else if (provider === 'openai') {
        const model = config.openaiModel || 'GPT-4';
        if (model.includes('gpt-4')) return 'GPT-4';
        if (model.includes('gpt-3.5')) return 'GPT-3.5';
        return 'OpenAI';
    } else if (provider === 'mistral') {
        const model = config.mistralModel || 'Mistral';
        if (model.includes('large')) return 'Mistral Large';
        if (model.includes('medium')) return 'Mistral Medium';
        return 'Mistral';
    }

    return provider?.charAt(0).toUpperCase() + provider?.slice(1) || 'LLM';
}

function createNewChatTab() {
    const tabId = nextTabId++;
    const llmName = getLLMDisplayName();

    // Sauvegarder le contenu du chat actuel si un onglet est actif
    if (activeTabId !== null) {
        saveCurrentTabContent();
    }

    const newTab = {
        id: tabId,
        type: 'chat',
        llmProvider: config.llmProvider,
        llmModel: getLLMModel(),
        conversationHistory: [],
        chatContent: ''
    };

    chatTabs.push(newTab);
    renderChatTabs();
    switchToTab(tabId);

    // Réinitialiser le contexte
    config.conversationHistory = [];
    document.getElementById('chatContainer').innerHTML = '';
}

function getLLMModel() {
    const provider = config.llmProvider;
    if (provider === 'ollama') return config.modelName;
    if (provider === 'claude') return config.claudeModel;
    if (provider === 'openai') return config.openaiModel;
    if (provider === 'mistral') return config.mistralModel;
    return '';
}

function saveCurrentTabContent() {
    const currentTab = chatTabs.find(t => t.id === activeTabId);
    if (currentTab) {
        currentTab.chatContent = document.getElementById('chatContainer').innerHTML;
        currentTab.conversationHistory = [...config.conversationHistory];
    }
}

function switchToTab(tabId) {
    // Sauvegarder le contenu actuel
    if (activeTabId !== null && activeTabId !== tabId) {
        saveCurrentTabContent();
        // Si on quitte un onglet CLI, restaurer l'inputArea
        const prevTab = chatTabs.find(t => t.id === activeTabId);
        if (prevTab && prevTab.type === 'claude-cli') {
            hideCliTerminal();
        }
    }

    activeTabId = tabId;
    const tab = chatTabs.find(t => t.id === tabId);

    if (tab) {
        // Si c'est un onglet CLI, afficher le terminal et sortir
        if (tab.type === 'claude-cli') {
            showCliTerminal();
            renderChatTabs();
            return;
        }

        // Restaurer le contexte
        config.conversationHistory = [...tab.conversationHistory];
        document.getElementById('chatContainer').innerHTML = tab.chatContent;

        // Désactiver/activer l'input selon le type d'onglet
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');

        if (tab.type === 'dossier') {
            // Désactiver l'input sur l'onglet Dossier (lecture seule)
            messageInput.disabled = true;
            messageInput.placeholder = "Onglet d'information - Lecture seule";
            sendBtn.disabled = true;
        } else {
            // Réactiver l'input sur les onglets chat
            messageInput.disabled = false;
            messageInput.placeholder = "Posez votre question...";
            sendBtn.disabled = false;
        }

        // Scroll en bas
        const container = document.getElementById('chatContainer');
        container.scrollTop = container.scrollHeight;
    }

    renderChatTabs();
}

function closeChatTab(tabId) {
    const tabIndex = chatTabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const tab = chatTabs[tabIndex];

    // Ne jamais permettre de fermer l'onglet Dossier
    if (tab.type === 'dossier') {
        return;
    }

    // Si c'est un onglet CLI, nettoyer le terminal avant de retirer l'onglet
    if (tab.type === 'claude-cli') {
        cleanupCliTerminal();
    }

    // Retirer l'onglet chat (on peut fermer tous les onglets chat, il restera toujours Dossier)
    chatTabs.splice(tabIndex, 1);

    // Si l'onglet fermé était actif, activer l'onglet Dossier ou un autre onglet
    if (activeTabId === tabId) {
        // Trouver l'onglet à activer (priorité : onglet chat précédent, sinon Dossier)
        let newActiveTab = chatTabs.find(t => t.type === 'chat');
        if (!newActiveTab) {
            newActiveTab = chatTabs.find(t => t.type === 'dossier');
        }
        if (newActiveTab) {
            switchToTab(newActiveTab.id);
        }
    } else {
        renderChatTabs();
    }
}

function renderChatTabs() {
    const tabsList = document.getElementById('chatTabsList');
    const newChatBtn = document.getElementById('newChatTabBtn');
    tabsList.innerHTML = '';

    chatTabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = 'chat-tab' + (tab.id === activeTabId ? ' active' : '');

        const label = document.createElement('span');
        label.className = 'chat-tab-label';
        label.textContent = getLLMDisplayNameForTab(tab);

        tabEl.appendChild(label);

        // Ajouter le bouton de fermeture seulement pour les onglets chat et CLI (pas Dossier)
        if (tab.type === 'chat' || tab.type === 'claude-cli') {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'chat-tab-close';
            closeBtn.textContent = '×';
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                closeChatTab(tab.id);
            };
            tabEl.appendChild(closeBtn);
        }

        tabEl.onclick = () => switchToTab(tab.id);

        tabsList.appendChild(tabEl);
    });

    // Re-append the new chat button at the end
    if (newChatBtn) {
        tabsList.appendChild(newChatBtn);
    }
}

function getLLMDisplayNameForTab(tab) {
    // Si c'est l'onglet Dossier, retourner le nom du dossier
    if (tab.type === 'dossier') {
        return dossierName;
    }

    // Si c'est l'onglet Claude CLI
    if (tab.type === 'claude-cli') {
        return '❋ Claude CLI';
    }

    const provider = tab.llmProvider;

    if (provider === 'ollama') {
        return tab.llmModel || 'Ollama';
    } else if (provider === 'claude') {
        return tab.llmModel?.split('-')[1]?.toUpperCase() || 'Claude';
    } else if (provider === 'openai') {
        const model = tab.llmModel || 'GPT-4';
        if (model.includes('gpt-4')) return 'GPT-4';
        if (model.includes('gpt-3.5')) return 'GPT-3.5';
        return 'OpenAI';
    } else if (provider === 'mistral') {
        const model = tab.llmModel || 'Mistral';
        if (model.includes('large')) return 'Mistral Large';
        if (model.includes('medium')) return 'Mistral Medium';
        return 'Mistral';
    }

    return provider?.charAt(0).toUpperCase() + provider?.slice(1) || 'LLM';
}

function updateDossierName(name) {
    if (name) {
        dossierName = name;
        renderChatTabs(); // Rafraîchir l'affichage des onglets
    }
}

function addMessageToDossierTab(type, content) {
    const dossierTab = chatTabs.find(t => t.type === 'dossier');
    if (!dossierTab) return;

    // Si on est déjà sur l'onglet Dossier, ajouter directement
    if (activeTabId === dossierTabId) {
        addMessage(type, content);
        dossierTab.chatContent = document.getElementById('chatContainer').innerHTML;
        return;
    }

    // Sinon, créer un container temporaire pour générer le HTML du message
    const tempContainer = document.createElement('div');
    tempContainer.innerHTML = dossierTab.chatContent;

    // Ajouter temporairement au DOM (caché) pour que addMessage fonctionne
    const originalContainer = document.getElementById('chatContainer');
    tempContainer.style.display = 'none';
    tempContainer.id = 'chatContainer_temp';
    document.body.appendChild(tempContainer);

    // Temporairement remplacer le container dans le DOM
    const originalId = originalContainer.id;
    originalContainer.id = 'chatContainer_backup';
    tempContainer.id = 'chatContainer';

    // Ajouter le message
    addMessage(type, content);

    // Sauvegarder le contenu mis à jour
    dossierTab.chatContent = tempContainer.innerHTML;

    // Restaurer le DOM
    originalContainer.id = originalId;
    tempContainer.remove();
}

function initializeChatTabs() {
    // Créer uniquement l'onglet Dossier (ne peut pas être fermé)
    const dossierTab = {
        id: dossierTabId,
        type: 'dossier',
        conversationHistory: [],
        chatContent: ''
    };

    chatTabs.push(dossierTab);
    activeTabId = dossierTabId; // Activer l'onglet Dossier par défaut
    renderChatTabs();

    // Event listener pour le bouton nouveau chat
    document.getElementById('newChatTabBtn').onclick = createNewChatTab;
}

async function loadMcpConfig() {
    try {
        const mcpConfig = await fetch('https://localhost:43098/api/mcp-config').then(r => r.json());
        config.mcpUrl = mcpConfig.url;
        config.mcpApiKey = mcpConfig.apiKey;
        console.log('Config MCP chargée:', config.mcpUrl);
    } catch (error) {
        console.error('Erreur chargement config MCP:', error);
    }
}
Office.onReady(async (info) => {
    if (info.host === Office.HostType.Word) {
        await loadMcpConfig();

        // Initialize chat tabs first
        initializeChatTabs();

        // Initialize dependencies BEFORE setting up UI handlers
        // This prevents race conditions where buttons are clicked before deps are ready
        initDependencies({
            get ws() { return ws; },
            chatTabs,
            switchToTab,
            getActiveTabId: () => activeTabId,
            saveCurrentTabContent,
            allocateTabId: () => nextTabId++,
            renderChatTabs,
            getDocumentId: () => anonymization.documentId || null
        });
        initializeSettingsListeners();
        // Dans votre taskpane script

        document.getElementById('restoreBtn').addEventListener('click', restoreInterface);
        // Démarrage réduit : le volet s'ouvre en barre compacte « PieceMaker »
        document.body.classList.add('minimized');
        document.getElementById('sendBtn').onclick = sendMessage;
        document.getElementById('messageInput').onkeydown = handleKeyPress; // Détecter la sélection au focus

        document.getElementById('closeModal').onclick = closeSettings;
        document.getElementById('saveSettings').onclick = saveSettings;
        document.getElementById('llmProvider').onchange = updateProviderFields;
        document.getElementById('addFilesBtn').addEventListener('click', () => {
            selectFiles();
        });
        document.getElementById('convertScanBtn').addEventListener('click', openConvertScanModal);
        initConvertScanListeners();
        document.getElementById('clearMappingBtn').onclick = clearFiles;
        document.getElementById('closeMappingModal').onclick = () => {
            document.getElementById('mappingModal').style.display = 'none';
        };
        document.getElementById('validateMapping').onclick = validateMapping;
        document.getElementById('cancelMapping').onclick = () => {
            document.getElementById('mappingModal').style.display = 'none';
            anonymization.pendingMapping = null;
        };
        // Dans Office.onReady, après les autres event listeners
        document.getElementById('closeFilesModal').onclick = closeFilesModal;
        document.getElementById('addFilesBtn').onclick = addFilesFromModal;
        document.getElementById('refreshModels').onclick = loadOllamaModels;

        // Event listeners pour la validation des modèles
        document.getElementById('validateClaudeModel').onclick = () => validateModel('claude');
        document.getElementById('validateOpenAIModel').onclick = () => validateModel('openai');
        document.getElementById('validateMistralModel').onclick = () => validateModel('mistral');

        // Initialize anonymization module event listeners
        AnonymizationModule.initAnonymizationListeners({
            validateMapping,
            saveDossierInfo: saveDossierInfoAndContinue,
            handleTamponImageUpload,
            saveTampon,
            clearTampon
        });

        // Boutons debug optionnels
        const debugBtn = document.getElementById('debugBtn');
        const clearDebugBtn = document.getElementById('clearDebug');
        if (debugBtn && typeof toggleDebug === 'function') {
            debugBtn.onclick = toggleDebug;
        }
        if (clearDebugBtn && typeof clearDebugMessages === 'function') {
            clearDebugBtn.onclick = clearDebugMessages;
        }

        loadSettings();
        updateSelection();
        document.getElementById('messageInput').onclick = () => {
            updateSelection();
            console.log("clic");
        };
        await initializeMCP();
        connectWebSocket();

        // Initialiser le module python-bridge
        initPythonBridge({ get ws() { return ws; } });

        // Initialiser le module doc-tools avec les dépendances nécessaires
        initDocToolsDependencies({
            // anonymizeText: fonction pour anonymiser/désanonymiser le texte
            anonymizeText: async (text, mode) => {
                // mode: 'anonymize' ou 'deanonymize'
                if (!anonymization.mapping || Object.keys(anonymization.mapping).length === 0) {
                    console.log('[doc-tools] No anonymization mapping, returning original text');
                    return text;
                }

                let result = text;

                if (mode === 'anonymize') {
                    // Remplacer les textes originaux par leurs versions anonymisées
                    for (const [original, anonymized] of Object.entries(anonymization.mapping)) {
                        const regex = new RegExp(escapeRegex(original), 'g');
                        result = result.replace(regex, anonymized);
                    }
                } else if (mode === 'deanonymize') {
                    // Remplacer les textes anonymisés par leurs versions originales
                    for (const [original, anonymized] of Object.entries(anonymization.mapping)) {
                        const regex = new RegExp(escapeRegex(anonymized), 'g');
                        result = result.replace(regex, original);
                    }
                }

                return result;
            },

            // draftConclusionsState: état du workflow de rédaction
            get draftConclusionsState() {
                return draftConclusionsState;
            }
        });

        // Initialiser le module ollama-analyzer avec les dépendances
        initOllamaAnalyzer({
            addMessageToDossierTab,
            updateAnonymizationProgress,
            mergeMappingWithDossierInfo: AnonymizationModule.mergeMappingWithDossierInfo,
            showMappingValidation: AnonymizationModule.showMappingValidation
        });

        await loadAnonymizationFiles();
        loadTamponFromStorage();
        config.conversationHistory = [];
    }
});
function initializeSettingsListeners() {
    const settingsBtn = document.getElementById('settingsBtn');
    const menuDropdown = document.getElementById('menuDropdown');
    
    if (!settingsBtn || !menuDropdown) {
        console.error('Menu burger non trouvé dans le DOM');
        return;
    }

    // Toggle menu burger
    settingsBtn.onclick = function(e) {
        e.stopPropagation();
        const isHidden = menuDropdown.style.display === 'none';
        if (isHidden) {
            const rect = settingsBtn.getBoundingClientRect();
            menuDropdown.style.top = (rect.bottom + 4) + 'px';
            menuDropdown.style.left = rect.left + 'px';
            menuDropdown.style.display = 'block';
        } else {
            menuDropdown.style.display = 'none';
        }
    };

    // Fermer le menu si clic ailleurs
    document.addEventListener('click', () => {
        menuDropdown.style.display = 'none';
    });

    // Actions du menu
document.querySelectorAll('.menu-item').forEach(item => {
    item.onclick = function() {
        const action = this.dataset.action;
        menuDropdown.style.display = 'none';

        if (action === 'settings') {
            document.getElementById('modal').classList.add('show');
        } else if (action === 'files') {
            openFilesModal(); // ✅ Ouvrir le modal des fichiers
        } else if (action === 'mapping') {
            reopenMappingModal(); // ✅ Ouvrir le modal de mapping
        } else if (action === 'ollama-analyze') {
            analyzeWithOllama(); // ✅ Lancer l'analyse OLLAMA
        } else if (action === 'tampon') {
            openTamponModal(); // ✅ Ouvrir le modal de configuration du tampon
        } else if (action === 'claude-cli') {
            openClaudeCLI(); // ✅ Ouvrir l'onglet Claude CLI
        } else if (action === 'minimize') {
            minimizeInterface(); // ✅ Réduire l'interface
        }
    };
});
}
// Configuration globale
const config = {
    llmProvider: 'claude',
    apiKey: '',
    ollamaUrl: 'http://localhost:11434',
    modelName: '',
    claudeModel: 'claude-haiku-4-5-20251001',
    openaiModel: 'gpt-4-turbo-preview',
    mistralModel: 'mistral-large-latest',
    autoApprove: false,
    mcpUrl: '',
    mcpApiKey: '',
    mcpConnected: false,
    mcpTools: [],
    conversationHistory: []
};

// MOVED TO MODULE: anonymization object is now imported from ./modules/anonymization.js
// Use AnonymizationModule.anonymization to access the state
const anonymization = AnonymizationModule.anonymization;

// État du workflow draft
const draftConclusionsState = {
    templateInjected: false,
    templateName: null,
    placeholdersProvided: {}
};
// Fonction pour obtenir le documentId
async function getDocumentId() {
    let docId;
    try {
        docId = await Word.run(async (context) => {
            const docProperties = context.document.properties;
            docProperties.load('customProperties');
            await context.sync();
            // Essayer de récupérer l'ID existant
            let storedDocId = null;
            try {
                const customProps = docProperties.customProperties;
                customProps.load('items');
                await context.sync();

                for (const prop of customProps.items) {
                    prop.load('key,value');
                }
                await context.sync();

                const idProp = customProps.items.find(p => p.key === 'PieceMakerDocId');
                if (idProp) {
                    storedDocId = idProp.value;
                }
            } catch (e) {
                console.log('[draft] Pas de custom property existante');
            }

            // Si pas d'ID, en créer un
            if (!storedDocId) {
                storedDocId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                docProperties.customProperties.add('PieceMakerDocId', storedDocId);
                await context.sync();
            }

            return storedDocId;
        });
    } catch (error) {
        console.error('[draft] Erreur récupération documentId:', error);
        // Fallback: utiliser un ID basé sur le temps
        docId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    const folder = await getCurrentDocFolder();
    if (!folder) throw new Error('Enregistrez d’abord le document Word dans un dossier juridique PieceMaker.');
    const response = await fetch('https://localhost:43098/api/workspace/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: docId, folder })
    });
    if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || 'Le document Word est hors de la racine PieceMaker.');
    }
    return docId;
}

// Fonction pour sauvegarder l'état du draft
async function saveDraftState() {
    try {
        const docId = await getDocumentId();

        const response = await fetch(`https://localhost:43098/api/draft-state/${docId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(draftConclusionsState)
        });

        if (!response.ok) {
            console.error('[draft] Erreur sauvegarde état:', await response.text());
        } else {
            console.log('[draft] ✅ État sauvegardé pour docId:', docId);
        }
    } catch (error) {
        console.error('[draft] Erreur sauvegarde état:', error);
    }
}

// Fonction pour charger l'état du draft
async function loadDraftState() {
    try {
        const docId = await getDocumentId();

        const response = await fetch(`https://localhost:43098/api/draft-state/${docId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.ok) {
            const savedState = await response.json();

            // Restaurer l'état
            Object.assign(draftConclusionsState, savedState);
            console.log('[draft] ✅ État restauré:', draftConclusionsState);
        } else {
            console.log('[draft] Aucun état sauvegardé trouvé');
        }
    } catch (error) {
        console.log('[draft] Aucun état sauvegardé (première utilisation)');
    }
}

// Fonction pour supprimer l'état du draft (quand le draft est complet)
async function deleteDraftState() {
    try {
        const docId = await getDocumentId();

        await fetch(`https://localhost:43098/api/draft-state/${docId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('[draft] 🗑️ État supprimé (draft complet)');
    } catch (error) {
        console.log('[draft] Erreur suppression état:', error);
    }
}

// Stockage de la sélection active
let currentSelection = {
    text: '',
    lineCount: 0,
    range: null // Stocker la référence à la plage Word
};
// Outils MCP locaux
const localTools = {
  // OUTIL : Lecture du document Word
  read_doc: async (params) => {
    const {
      list_headings,
      heading,
      indexes,
      include_track_changes,
      revision_view,
      revisions,
      from_index,
      from_offset,
      max_chars
    } = params;

    console.log('[read_doc] 📖 Lecture du document Word');

    if (!anonymization.documentId) {
      return { error: 'Aucun document chargé' };
    }

    // Construction du message d'approbation
    let approvalMessage = '';
    let approvalDetails = '';

    if (revisions) {
      approvalMessage = 'Le modèle souhaite lire les révisions du document';
      approvalDetails = 'Lecture des auteurs, dates, types et textes des modifications suivies';
    } else if (list_headings) {
      approvalMessage = 'Le modèle souhaite lire la structure du document (titres)';
      approvalDetails = 'Lecture de la liste des titres avec leurs index';
    } else if (heading) {
      approvalMessage = `Le modèle souhaite lire la section : "${heading}"`;
      approvalDetails = 'Lecture du titre et de son contenu';
    } else if (indexes && indexes.length > 0) {
      approvalMessage = `Le modèle souhaite lire ${indexes.length} paragraphe(s) spécifique(s)`;
      approvalDetails = `Index: ${indexes.join(', ')}`;
    } else {
      approvalMessage = 'Le modèle souhaite lire le document complet';
      approvalDetails = 'Lecture de tous les paragraphes avec formatage Markdown';
    }

    if (!config.autoApprove) {
      const approved = await requestApproval(approvalMessage, approvalDetails);
      if (!approved) {
        return { error: 'Accès refusé par l\'utilisateur' };
      }
    }

    try {
      const response = await fetch('https://localhost:43098/api/word/read-doc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...documentRoutingHeaders()
        },
        body: JSON.stringify({
          list_headings: list_headings || false,
          heading: heading || undefined,
          indexes: indexes || undefined,
          include_track_changes: include_track_changes || false,
          revision_view,
          revisions,
          from_index,
          from_offset,
          max_chars
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la lecture du document');
      }

      const data = await response.json();

      // Anonymiser les résultats avant de les envoyer au modèle AI
      console.log('[read_doc] 🔒 Anonymisation du contenu...');
      const dataString = typeof data === 'string' ? data : JSON.stringify(data);
      const anonymizedString = await anonymizeText(dataString, 'anonymize');

      return anonymizedString;

    } catch (error) {
      console.error('[read_doc] Erreur:', error);
      return { error: error.message };
    }
  },
  // OUTIL : Édition du document Word
  edit_doc: async (params) => {
    const { operation, target_index, text, indexes_to_delete, edits, track_changes, review } = params;

    console.log('[edit_doc] ✏️ Édition du document Word');

    if (!anonymization.documentId) {
      return { error: 'Aucun document chargé' };
    }

    // Construction du message d'approbation
    let approvalMessage = '';
    let approvalDetails = '';

    if (review) {
      approvalMessage = `Le modèle souhaite gérer les révisions : ${review.action}`;
      approvalDetails = review.indexes?.length
        ? `Révisions : ${review.indexes.join(', ')}`
        : 'Action sur le suivi ou l’affichage des modifications';
    } else if (Array.isArray(edits)) {
      approvalMessage = `Le modèle souhaite appliquer ${edits.length} modification(s) groupée(s)`;
      approvalDetails = 'Tous les index proviennent de la même lecture du document';
    } else if (operation === 'insert_before') {
      approvalMessage = `Le modèle souhaite insérer du contenu avant l'index ${target_index}`;
      approvalDetails = text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '';
    } else if (operation === 'insert_after') {
      approvalMessage = `Le modèle souhaite insérer du contenu après l'index ${target_index}`;
      approvalDetails = text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '';
    } else if (operation === 'delete') {
      approvalMessage = `Le modèle souhaite supprimer ${indexes_to_delete?.length || 0} paragraphe(s)`;
      approvalDetails = `Index à supprimer: ${indexes_to_delete?.join(', ') || 'aucun'}`;
    } else {
      approvalMessage = `Le modèle souhaite effectuer une opération d'édition : ${operation}`;
      approvalDetails = '';
    }

    if (!config.autoApprove) {
      const approved = await requestApproval(approvalMessage, approvalDetails);
      if (!approved) {
        return { error: 'Accès refusé par l\'utilisateur' };
      }
    }

    try {
      // Désanonymiser le texte avant de l'envoyer au serveur Word
      let processedText = text;
      if (text) {
        console.log('[edit_doc] 🔓 Désanonymisation du contenu...');
        processedText = await anonymizeText(text, 'deanonymize');
      }
      let processedEdits = edits;
      if (Array.isArray(edits)) {
        processedEdits = await Promise.all(edits.map(async (edit) => ({
          ...edit,
          text: edit.text ? await anonymizeText(edit.text, 'deanonymize') : edit.text
        })));
      }

      const response = await fetch('https://localhost:43098/api/word/edit-doc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...documentRoutingHeaders()
        },
        body: JSON.stringify({
          operation,
          target_index,
          text: processedText,
          indexes_to_delete,
          edits: processedEdits,
          track_changes,
          review
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de l\'édition du document');
      }

      const data = await response.json();

      // 🔍 Détecter si un placeholder a été ciblé dans l'opération
      const placeholderMatch = JSON.stringify(params).match(/\{\{([A-Z_0-9]+)\}\}/i);

      if (placeholderMatch && draftConclusionsState.templateInjected) {
        const placeholderUsed = placeholderMatch[0]; // Ex: {{FAITS}}
        const cleanPlaceholder = placeholderMatch[1]; // Ex: FAITS
        console.log('[edit_doc] 📝 Placeholder détecté:', placeholderUsed);

        try {
          // Marquer le placeholder comme rempli (comme dans fill_placeholder)
          draftConclusionsState.placeholdersProvided[cleanPlaceholder] = true;
          await saveDraftState();
          console.log('[edit_doc] ✅ Placeholder marqué comme rempli:', placeholderUsed);

          // Récupérer tous les placeholders du document
          const documentPlaceholders = await getAllPlaceholdersInDocument();

          // Trier les placeholders et obtenir le prochain
          const sortedPlaceholders = await localTools.sortPlaceholders([...documentPlaceholders]);
          const filledPlaceholders = Object.keys(draftConclusionsState.placeholdersProvided).map(p => `{{${p}}}`);
          const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, filledPlaceholders);

          const result = typeof data === 'string' ? { success: true, message: data } : data;

          if (nextPlaceholderInfo) {
            result.next_placeholder = nextPlaceholderInfo.placeholder;
            if (nextPlaceholderInfo.guideline) {
              result.next_placeholder_guideline = nextPlaceholderInfo.guideline;
            }
          }

          console.log('[edit_doc] 📋 Résultat avec next_placeholder:', result);
          return result;
        } catch (error) {
          console.error('[edit_doc] ⚠️ Erreur lors de la récupération du next_placeholder:', error);
          // Retourner quand même le résultat de l'édition
          return typeof data === 'string' ? data : JSON.stringify(data);
        }
      }

      return typeof data === 'string' ? data : JSON.stringify(data);

    } catch (error) {
      console.error('[edit_doc] Erreur:', error);
      return { error: error.message };
    }
  },
  // OUTIL PRINCIPAL : Lecture de fichiers
read_case: async (params) => {
    const { 
      query, 
      show_structure, 
      date_debut, 
      date_fin,
      search_mode,      // Nouveau : 'ET', 'OU', 'EXACTE'
      read_full,        // Nouveau : true pour lecture complète
      edit              // Nouveau : objet {id, date_document?, type_document?, analyse?}
    } = params;

    console.log('[read_case] 🔍 Recherche dans le dossier juridique');

    if (!anonymization.documentId) {
      return { error: 'Aucun document chargé' };
    }

    // Construction du message d'approbation selon le mode
    let approvalMessage = '';
    let approvalDetails = '';

    if (edit) {
      approvalMessage = `Le modèle souhaite modifier la pièce ${edit.id}`;
      const fields = Object.keys(edit).filter(k => k !== 'id').join(', ');
      approvalDetails = `Modification des champs : ${fields}`;
    } else if (read_full) {
      const pieceIds = query.split(',').map(id => id.trim()).filter(id => id.length > 0);
      if (pieceIds.length > 1) {
        approvalMessage = `Le modèle souhaite lire le contenu intégral de ${pieceIds.length} pièces : ${query}`;
        approvalDetails = `Lecture complète de plusieurs pièces incluant texte_integral et métadonnées`;
      } else {
        approvalMessage = `Le modèle souhaite lire le contenu intégral de la pièce ${query}`;
        approvalDetails = `Lecture complète incluant texte_integral et métadonnées`;
      }
    } else if (show_structure) {
      approvalMessage = `Le modèle souhaite afficher la structure complète du dossier`;
      approvalDetails = `Liste de toutes les pièces avec dates et types`;
    } else {
      const dateInfo = date_debut || date_fin 
        ? ` (dates: ${date_debut || '...'} → ${date_fin || '...'})` 
        : '';
      const modeInfo = search_mode ? ` [mode: ${search_mode}]` : '';
      approvalMessage = `Le modèle souhaite rechercher : "${query || 'tous documents'}"${dateInfo}${modeInfo}`;
      approvalDetails = `Recherche par mots-clés et/ou dates dans le dossier juridique`;
    }

    if (!config.autoApprove) {
      const approved = await requestApproval(approvalMessage, approvalDetails);
      if (!approved) {
        return { error: 'Accès refusé par l\'utilisateur' };
      }
    }

    try {
      const response = await fetch(`https://localhost:43098/api/anonymize/search/${anonymization.documentId}`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify({ 
          query, 
          show_structure: show_structure || (!query && !date_debut && !date_fin && !edit && !read_full),
          date_debut,
          date_fin,
          search_mode: search_mode || 'OU',
          read_full: read_full || false,
          edit: edit || null
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la recherche');
      }

      const data = await response.json();

      // Anonymiser les résultats avant de les envoyer au modèle AI
      console.log('[read_case] 🔒 Anonymisation des résultats...');
      const dataString = JSON.stringify(data);
      const anonymizedString = await anonymizeText(dataString, 'anonymize');
      const anonymizedData = JSON.parse(anonymizedString);

      // Gestion spécifique du retour edit avec suggestions
      if (anonymizedData.suggestions && anonymizedData.suggestions.length > 0) {
        console.log('[read_case] ⚠️ Suggestions de correction détectées');
        return {
          ...anonymizedData,
          message: `${anonymizedData.suggestions.length} problème(s) détecté(s). Corrections proposées ci-dessous.`
        };
      }

      return anonymizedData;

    } catch (error) {
      console.error('[read_case] Erreur:', error);
      return { error: error.message };
    }
},
get_resource: async (params) => {
    const { filename, action, content, new_filename } = params;

    console.log('[get_resource] 📚 Gestion des ressources');

    // ACTION 1 : Liste des ressources (par défaut)
    if (!filename || action === 'list') {
        console.log('[get_resource] 📋 Liste des ressources');

        if (!config.autoApprove) {
            const approved = await requestApproval(
                'Le modèle souhaite lister les ressources disponibles',
                'Accès en lecture seule au dossier output/ressources'
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch('https://localhost:43098/api/resources');
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    // ACTION 2 : Lecture d'une ressource
    if (action === 'read' || (!action && filename)) {
        console.log(`[get_resource] 📖 Lecture: ${filename}`);

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Le modèle souhaite lire la ressource: ${filename}`,
                'Lecture du contenu (fichiers texte uniquement)'
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(filename)}`);
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    // ACTION 3 : Copie d'une ressource
    if (action === 'copy' && new_filename) {
        console.log(`[get_resource] 📋 Copie: ${filename} → ${new_filename}`);

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Le modèle souhaite copier: ${filename}`,
                `Nouveau fichier: ${new_filename}`
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch('https://localhost:43098/api/resources/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename, new_filename })
            });
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    // ACTION 4 : Écriture/modification d'une ressource
    if (action === 'write' && content) {
        console.log(`[get_resource] ✍️ Écriture: ${filename}`);

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Le modèle souhaite créer/modifier: ${filename}`,
                `Taille: ${content.length} caractères (fichiers texte uniquement)`
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(filename)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    // ACTION 4 : Renommer une ressource
    if (action === 'rename' && new_filename) {
        console.log(`[get_resource] 🔄 Renommage: ${filename} → ${new_filename}`);

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Le modèle souhaite renommer: ${filename}`,
                `Nouveau nom: ${new_filename}`
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(filename)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_filename })
            });
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    // ACTION 5 : Supprimer une ressource
    if (action === 'delete') {
        console.log(`[get_resource] 🗑️ Suppression: ${filename}`);

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `⚠️ Le modèle souhaite SUPPRIMER: ${filename}`,
                'Cette action est irréversible'
            );
            if (!approved) return { error: 'Accès refusé' };
        }

        try {
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error((await response.json()).error);
            return await response.json();
        } catch (error) {
            return { error: error.message };
        }
    }

    return { error: 'Action invalide. Actions supportées: list, read, copy, write, rename, delete' };
},

// Fonction helper pour normaliser un placeholder (retirer accolades, footnotes ET métadonnées)
// Ex: "{{PRETENTION[^1]}}" => "PRETENTION"
// Ex: "{{PRETENTION[Prétention 1 PRINCIPALE - texte]}}" => "PRETENTION"
normalizePlaceholderName: (placeholder) => {
    // Retirer les accolades
    let normalized = placeholder.replace(/[{}]/g, '');
    // Retirer TOUS les crochets avec leur contenu (footnotes ET métadonnées)
    // Cela inclut les appels de notes [^1] et les métadonnées historiques.
    normalized = normalized.replace(/\[[^\]]*\]/g, '').trim();
    return normalized;
},

// Fonction helper pour trier les placeholders par step et obtenir le prochain à traiter
sortPlaceholders: async (placeholders) => {
    // Charger les guidelines pour obtenir les steps
    try {
        // Déterminer le fichier JSON à charger selon le template injecté
        let guidelinesFileName = 'placeholders_guidelines.json';
        if (draftConclusionsState.templateInjected && draftConclusionsState.templateName) {
            guidelinesFileName = draftConclusionsState.templateName.replace('.docx', '.json');
        }

        const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(guidelinesFileName)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            console.error('[sortPlaceholders] Impossible de charger les guidelines');
            return placeholders; // Retourner non trié si échec
        }

        const result = await response.json();
        const guidelinesData = result.content ? JSON.parse(result.content) : result;

        // Trier les placeholders par step
        return placeholders.sort((a, b) => {
            const cleanA = localTools.normalizePlaceholderName(a);
            const cleanB = localTools.normalizePlaceholderName(b);

            const stepA = guidelinesData.placeholders?.[cleanA]?.step || 9999;
            const stepB = guidelinesData.placeholders?.[cleanB]?.step || 9999;

            return stepA - stepB;
        });
    } catch (error) {
        console.error('[sortPlaceholders] ❌ Erreur:', error);
        return placeholders; // Retourner non trié si erreur
    }
},

getNextPlaceholder: async (sortedPlaceholders, filledPlaceholders) => {
    // Trouver le premier placeholder non rempli
    // Comparer les placeholders AVEC leurs footnotes (sans accolades uniquement)
    const filledSet = new Set(filledPlaceholders.map(p => p.replace(/[{}]/g, '')));

    const nextPlaceholder = sortedPlaceholders.find(p => {
        const clean = p.replace(/[{}]/g, '');
        return !filledSet.has(clean);
    });

    if (!nextPlaceholder) return null;

    // Charger la guideline pour ce placeholder
    try {
        // Déterminer le fichier JSON à charger selon le template injecté
        let guidelinesFileName = 'placeholders_guidelines.json';
        if (draftConclusionsState.templateInjected && draftConclusionsState.templateName) {
            guidelinesFileName = draftConclusionsState.templateName.replace('.docx', '.json');
        }

        const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(guidelinesFileName)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            return { placeholder: nextPlaceholder, guideline: null, step: null };
        }

        const result = await response.json();
        const guidelinesData = result.content ? JSON.parse(result.content) : result;

        // Normaliser pour chercher dans le JSON (sans footnote)
        const normalizedPlaceholder = localTools.normalizePlaceholderName(nextPlaceholder);

        if (guidelinesData.placeholders && guidelinesData.placeholders[normalizedPlaceholder]) {
            const placeholderData = guidelinesData.placeholders[normalizedPlaceholder];
            return {
                placeholder: nextPlaceholder, // IMPORTANT: retourner le placeholder COMPLET avec footnote
                guideline: placeholderData.guideline,
                step: placeholderData.step
            };
        }

        return { placeholder: nextPlaceholder, guideline: null, step: null };
    } catch (error) {
        console.error('[draft] ❌ Erreur chargement guideline:', error);
        return { placeholder: nextPlaceholder, guideline: null, step: null };
    }
},

draft: async (params) => {
    const { action, template_name, placeholder, content } = params;

    console.log('[draft] 📝 Action:', action);

    // Charger l'état sauvegardé au début
    await loadDraftState();

    // ÉTAPE 1 : Vérification du template
    if (action === 'check_template') {
        if (draftConclusionsState.templateInjected) {
            // Extraire dynamiquement les placeholders du document Word (body uniquement)
            let documentPlaceholders = [];
            try {
                await Word.run(async (context) => {
                    // Récupérer uniquement le texte du body
                    const body = context.document.body;
                    body.load('text');
                    await context.sync();

                    // Regex pour trouver tous les {{PLACEHOLDER}} dans le document
                    const placeholderRegex = /\{\{([^}]+)\}\}/g;
                    const matches = [...body.text.matchAll(placeholderRegex)];

                    // Extraire les placeholders uniques dans l'ordre d'apparition
                    const seen = new Set();
                    documentPlaceholders = matches
                        .map(match => `{{${match[1]}}}`)
                        .filter(p => {
                            if (seen.has(p)) return false;
                            seen.add(p);
                            return true;
                        });

                    console.log('[draft] 📋 check_template - Placeholders trouvés:', documentPlaceholders);
                });
            } catch (error) {
                console.error('[draft] ❌ Erreur extraction placeholders:', error);
            }

            // Trier les placeholders et obtenir le prochain
            const sortedPlaceholders = await localTools.sortPlaceholders([...documentPlaceholders]);
            const filledPlaceholders = Object.keys(draftConclusionsState.placeholdersProvided).map(p => `{{${p}}}`);
            const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, filledPlaceholders);

            const checkResult = {
                available_placeholders: sortedPlaceholders
            };

            if (nextPlaceholderInfo) {
                checkResult.next_placeholder = nextPlaceholderInfo.placeholder;
                if (nextPlaceholderInfo.guideline) {
                    checkResult.next_placeholder_guideline = nextPlaceholderInfo.guideline;
                }
            }

            return checkResult;
        } else {
            // Aucun template injecté, lister automatiquement les templates disponibles
            try {
                const response = await fetch('https://localhost:43098/api/resources');
                if (!response.ok) throw new Error((await response.json()).error);
                const resourcesData = await response.json();

                console.log('[draft] 📊 Structure de resourcesData:', JSON.stringify(resourcesData, null, 2));

                // Filtrer uniquement les fichiers contenant "Template" ou "Modèle" dans le titre
                const filesList = resourcesData.resources || resourcesData.files || [];
                const templates = filesList.filter(file =>
                    file.filename && (
                        file.filename.toLowerCase().includes('template') ||
                        file.filename.toLowerCase().includes('modèle')
                    )
                );

                console.log('[draft] 📋 Templates filtrés:', templates);

                return {
                    template_injected: false,
                    message: 'Aucun template n\'a été injecté',
                    available_templates: templates.map(t => t.filename),
                    next_step: 'Utilisez action="inject_template" avec l\'un des templates ci-dessus (nom exact du fichier)'
                };
            } catch (error) {
                console.error('[draft] ❌ Erreur récupération des templates:', error);
                return {
                    template_injected: false,
                    message: 'Aucun template n\'a été injecté',
                    error: `Impossible de récupérer la liste des templates: ${error.message}`,
                    next_step: 'Utilisez get_resource({ action: "list" }) pour voir les templates disponibles, puis action="inject_template" avec le nom exact du fichier'
                };
            }
        }
    }

if (action === 'inject_template') {
    if (!template_name) {
        // Lister automatiquement les templates disponibles
        try {
            const response = await fetch('https://localhost:43098/api/resources');
            if (!response.ok) throw new Error((await response.json()).error);
            const resourcesData = await response.json();

            // Filtrer uniquement les fichiers contenant "Template" ou "Modèle" dans le titre
            const filesList = resourcesData.resources || resourcesData.files || [];
            const templates = filesList.filter(file =>
                file.filename && (
                    file.filename.toLowerCase().includes('template') ||
                    file.filename.toLowerCase().includes('modèle')
                )
            );

            return {
                error: 'Veuillez spécifier le template_name (nom exact du fichier)',
                available_templates: templates.map(t => t.filename),
                instruction: 'Utilisez l\'un des templates ci-dessus comme template_name'
            };
        } catch (fetchError) {
            console.error('[draft] ❌ Erreur récupération des templates:', fetchError);
            return {
                error: 'Veuillez spécifier le template_name (nom exact du fichier)',
                fetch_error: `Impossible de récupérer la liste: ${fetchError.message}`,
                instruction: 'Utilisez get_resource({ action: "list" }) pour voir les templates disponibles'
            };
        }
    }

    // Demander validation utilisateur IMPÉRATIVE
    if (!config.autoApprove) {
        const approved = await requestApproval(
            `L'IA souhaite injecter le template : ${template_name}`,
            `Template OOXML qui sera injecté dans le document Word actuel. ⚠️ Cette action remplacera le contenu ET les styles du document.`
        );
        if (!approved) {
            return { error: 'Injection du template refusée par l\'utilisateur' };
        }
    }

    try {
        // Récupérer le template en base64 (fichier .docx complet)
        const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(template_name)}?format=base64`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            return {
                error: `Template "${template_name}" introuvable dans les ressources`,
                instruction: 'Vérifiez le nom du fichier avec get_resource({ action: "list" })'
            };
        }

        const result = await response.json();

        if (!result.content) {
            return { error: 'Template base64 vide ou invalide' };
        }

        // ═══════════════════════════════════════════════════════════════
        // EXTRACTION ET APPLICATION COMPLÈTE DES STYLES DU TEMPLATE
        // ═══════════════════════════════════════════════════════════════
        await Word.run(async (context) => {
            // ───────────────────────────────────────────────────────────
            // ÉTAPE 1: EXTRACTION COMPLÈTE DES STYLES DU TEMPLATE
            // ───────────────────────────────────────────────────────────
            console.log('[draft] 📥 Récupération des styles du template...');

            const templateStyles = context.application.retrieveStylesFromBase64(result.content);
            await context.sync();

            // Parser le JSON retourné - peut être un objet ou un tableau
            let stylesData;
            try {
                const parsedData = JSON.parse(templateStyles.value);
                // Si c'est un objet avec une propriété styles ou items, l'extraire
                if (parsedData && typeof parsedData === 'object') {
                    if (Array.isArray(parsedData)) {
                        stylesData = parsedData;
                    } else if (parsedData.styles && Array.isArray(parsedData.styles)) {
                        stylesData = parsedData.styles;
                    } else if (parsedData.items && Array.isArray(parsedData.items)) {
                        stylesData = parsedData.items;
                    } else {
                        // Convertir l'objet en tableau si nécessaire
                        stylesData = Object.values(parsedData);
                    }
                } else {
                    stylesData = [];
                }
            } catch (parseError) {
                console.warn('[draft] ⚠️ Erreur parsing styles:', parseError);
                stylesData = [];
            }

            console.log(`[draft] 📋 ${stylesData.length} styles trouvés dans le template`);

            // Enrichir les données avec toutes les propriétés disponibles
            const enrichedStylesData = Array.isArray(stylesData) ? stylesData.map(style => ({
                ...style,
                _raw: style // Conserver toutes les propriétés natives
            })) : [];

            // ───────────────────────────────────────────────────────────
            // ÉTAPE 2: NETTOYAGE DES STYLES CUSTOM (PAS LES BUILT-IN)
            // ───────────────────────────────────────────────────────────
            const currentStyles = context.document.getStyles();
            currentStyles.load('items/builtIn,items/nameLocal');
            await context.sync();

            console.log(`[draft] 🧹 Nettoyage de ${currentStyles.items.length} styles...`);

            for (const style of currentStyles.items) {
                try {
                    if (!style.builtIn) {
                        style.delete();
                    }
                } catch (styleError) {
                    console.warn(`[draft] ⚠️ Style non supprimable: ${style.nameLocal}`);
                }
            }
            await context.sync();
            console.log('[draft] ✅ Styles custom supprimés');

            // ───────────────────────────────────────────────────────────
            // ÉTAPE 3: INSERTION DU TEMPLATE
            // ───────────────────────────────────────────────────────────
            context.document.insertFileFromBase64(
                result.content,
                Word.InsertLocation.replace,
                {
                    importTheme: true,
                    importStyles: true,
                    importParagraphSpacing: true,
                    importPageColor: true,
                    importChangeTrackingMode: false,
                    importCustomProperties: true,
                    importCustomXmlParts: true,
                    importDifferentOddEvenPages: true
                }
            );
            await context.sync();
            console.log('[draft] ✅ Template injecté');

            // ───────────────────────────────────────────────────────────
            // ÉTAPE 4: RECHARGEMENT ET APPLICATION COMPLÈTE DES STYLES
            // ───────────────────────────────────────────────────────────
            const documentStyles = context.document.getStyles();
            documentStyles.load('items');
            await context.sync();

            console.log('[draft] 🎨 Application complète des styles du template...');

            let stylesUpdated = 0;
            let stylesSkipped = 0;

            for (const templateStyle of enrichedStylesData) {
                // Trouver le style correspondant dans le document
                const docStyle = documentStyles.items.find(
                    s => s.nameLocal === templateStyle.nameLocal || s.name === templateStyle.name
                );

                if (!docStyle) {
                    stylesSkipped++;
                    continue;
                }

                try {
                    // Charger toutes les propriétés du style
                    docStyle.load([
                        'font',
                        'paragraphFormat',
                        'shading',
                        'borders',
                        'listTemplate',
                        'tableStyle'
                    ].join(','));
                    await context.sync();

                    // ═════════════════════════════════════════════════
                    // 1. PROPRIÉTÉS DE POLICE (FONT)
                    // ═════════════════════════════════════════════════
                    if (templateStyle.font) {
                        const font = templateStyle.font;

                        // Police et taille
                        if (font.name) docStyle.font.name = font.name;
                        if (font.size !== undefined) docStyle.font.size = font.size;

                        // Couleur
                        if (font.color) docStyle.font.color = font.color;
                        if (font.highlightColor) docStyle.font.highlightColor = font.highlightColor;

                        // Styles de texte
                        if (font.bold !== undefined) docStyle.font.bold = font.bold;
                        if (font.italic !== undefined) docStyle.font.italic = font.italic;
                        if (font.underline !== undefined) docStyle.font.underline = font.underline;
                        if (font.strikeThrough !== undefined) docStyle.font.strikeThrough = font.strikeThrough;
                        if (font.doubleStrikeThrough !== undefined) docStyle.font.doubleStrikeThrough = font.doubleStrikeThrough;
                        if (font.subscript !== undefined) docStyle.font.subscript = font.subscript;
                        if (font.superscript !== undefined) docStyle.font.superscript = font.superscript;

                        // Casse et effets
                        if (font.smallCaps !== undefined) docStyle.font.smallCaps = font.smallCaps;
                        if (font.allCaps !== undefined) docStyle.font.allCaps = font.allCaps;
                        if (font.hidden !== undefined) docStyle.font.hidden = font.hidden;
                    }

                    // ═════════════════════════════════════════════════
                    // 2. FORMAT DE PARAGRAPHE (PARAGRAPH FORMAT)
                    // ═════════════════════════════════════════════════
                    if (templateStyle.paragraphFormat) {
                        const pf = templateStyle.paragraphFormat;

                        // Alignement
                        if (pf.alignment !== undefined) {
                            docStyle.paragraphFormat.alignment = pf.alignment;
                        }

                        // Indentations
                        if (pf.leftIndent !== undefined) {
                            docStyle.paragraphFormat.leftIndent = pf.leftIndent;
                        }
                        if (pf.rightIndent !== undefined) {
                            docStyle.paragraphFormat.rightIndent = pf.rightIndent;
                        }
                        if (pf.firstLineIndent !== undefined) {
                            docStyle.paragraphFormat.firstLineIndent = pf.firstLineIndent;
                        }

                        // Espacements
                        if (pf.spaceBefore !== undefined) {
                            docStyle.paragraphFormat.spaceBefore = pf.spaceBefore;
                        }
                        if (pf.spaceAfter !== undefined) {
                            docStyle.paragraphFormat.spaceAfter = pf.spaceAfter;
                        }
                        if (pf.lineSpacing !== undefined) {
                            docStyle.paragraphFormat.lineSpacing = pf.lineSpacing;
                        }
                        if (pf.lineUnitBefore !== undefined) {
                            docStyle.paragraphFormat.lineUnitBefore = pf.lineUnitBefore;
                        }
                        if (pf.lineUnitAfter !== undefined) {
                            docStyle.paragraphFormat.lineUnitAfter = pf.lineUnitAfter;
                        }

                        // Options de pagination
                        if (pf.outlineLevel !== undefined) {
                            docStyle.paragraphFormat.outlineLevel = pf.outlineLevel;
                        }
                        if (pf.keepTogether !== undefined) {
                            docStyle.paragraphFormat.keepTogether = pf.keepTogether;
                        }
                        if (pf.keepWithNext !== undefined) {
                            docStyle.paragraphFormat.keepWithNext = pf.keepWithNext;
                        }
                        if (pf.widowControl !== undefined) {
                            docStyle.paragraphFormat.widowControl = pf.widowControl;
                        }
                    }

                    // ═════════════════════════════════════════════════
                    // 3. OMBRAGE ET ARRIÈRE-PLAN (SHADING)
                    // ═════════════════════════════════════════════════
                    if (templateStyle.shading) {
                        if (templateStyle.shading.backgroundPatternColor) {
                            docStyle.shading.backgroundPatternColor = templateStyle.shading.backgroundPatternColor;
                        }
                    }

                    // ═════════════════════════════════════════════════
                    // 4. BORDURES ET NUMÉROTATION (INFO UNIQUEMENT)
                    // ═════════════════════════════════════════════════
                    if (templateStyle.borders) {
                        console.log(`[draft] ℹ️ Bordures détectées pour "${templateStyle.nameLocal}" (préservées par import)`);
                    }
                    if (templateStyle.listTemplate) {
                        console.log(`[draft] ℹ️ Numérotation détectée pour "${templateStyle.nameLocal}" (préservée par import)`);
                    }

                    await context.sync();
                    stylesUpdated++;

                } catch (styleError) {
                    console.warn(`[draft] ⚠️ Erreur sur le style "${templateStyle.nameLocal}": ${styleError.message}`);
                    stylesSkipped++;
                }
            }

            console.log(`[draft] ✅ ${stylesUpdated} styles mis à jour`);
            console.log(`[draft] ⏭️ ${stylesSkipped} styles ignorés`);
        });

        // Marquer que le template a été injecté et réinitialiser l'état
        draftConclusionsState.templateInjected = true;
        draftConclusionsState.templateName = template_name;
        draftConclusionsState.placeholdersProvided = {};  // Réinitialiser les placeholders remplis
        await saveDraftState();

        // Extraire dynamiquement les placeholders du document injecté (body + headers + footers)
        let documentPlaceholders = [];
        try {
            documentPlaceholders = await Word.run(async (context) => {
                // Récupérer uniquement le texte du body
                const body = context.document.body;
                body.load('text');
                await context.sync();

                // Regex pour trouver tous les {{PLACEHOLDER}} dans le document
                const placeholderRegex = /\{\{([^}]+)\}\}/g;
                const matches = [...body.text.matchAll(placeholderRegex)];

                // Extraire les placeholders uniques dans l'ordre d'apparition
                const seen = new Set();
                const foundPlaceholders = matches
                    .map(match => `{{${match[1]}}}`)
                    .filter(p => {
                        if (seen.has(p)) return false;
                        seen.add(p);
                        return true;
                    });

                console.log('[draft] 📋 inject_template - Placeholders trouvés:', foundPlaceholders);
                return foundPlaceholders;
            });
        } catch (error) {
            console.error('[draft] ❌ Erreur extraction placeholders:', error);
            documentPlaceholders = [];
        }

        // Trier les placeholders et obtenir le prochain
        const sortedPlaceholders = await localTools.sortPlaceholders([...documentPlaceholders]);
        const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, []);

        const injectResult = {
            success: true,
            message: `Template "${template_name}" injecté avec succès (styles remplacés)`,
            available_placeholders: sortedPlaceholders
        };

        if (nextPlaceholderInfo) {
            injectResult.next_placeholder = nextPlaceholderInfo.placeholder;
            if (nextPlaceholderInfo.guideline) {
                injectResult.next_placeholder_guideline = nextPlaceholderInfo.guideline;
            }
        }

        return injectResult;

    } catch (error) {
        console.error('[draft] ❌ Erreur injection template:', error);
        return { error: `Erreur lors de l'injection du template: ${error.message}` };
    }
}

    // ÉTAPE 3 : Demander les guidelines pour un placeholder
    if (action === 'get_placeholder_instructions') {
        if (!draftConclusionsState.templateInjected) {
            return {
                error: 'Aucun template n\'a été injecté. Veuillez d\'abord utiliser action="inject_template"'
            };
        }

        if (!placeholder) {
            // Extraire les placeholders du document pour les afficher
            let documentPlaceholders = [];
            try {
                await Word.run(async (context) => {
                    const body = context.document.body;
                    body.load('text');
                    await context.sync();

                    // Regex permissive pour tous les placeholders
                    const placeholderRegex = /\{\{([^}]+)\}\}/g;
                    const matches = [...body.text.matchAll(placeholderRegex)];
                    const seen = new Set();
                    documentPlaceholders = matches
                        .map(match => `{{${match[1]}}}`)
                        .filter(p => {
                            if (seen.has(p)) return false;
                            seen.add(p);
                            return true;
                        });
                });
            } catch (error) {
                console.error('[draft] ❌ Erreur extraction placeholders:', error);
            }

            // Trier les placeholders et obtenir le prochain
            const sortedPlaceholders = await localTools.sortPlaceholders([...documentPlaceholders]);
            const filledPlaceholders = Object.keys(draftConclusionsState.placeholdersProvided).map(p => `{{${p}}}`);
            const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, filledPlaceholders);

            const errorResult = {
                error: 'Veuillez spécifier le placeholder (ex: "{{FAITS}}")',
                available_placeholders: sortedPlaceholders
            };

            if (nextPlaceholderInfo) {
                errorResult.next_placeholder = nextPlaceholderInfo.placeholder;
                if (nextPlaceholderInfo.guideline) {
                    errorResult.next_placeholder_guideline = nextPlaceholderInfo.guideline;
                }
            }

            return errorResult;
        }

        // Charger les guidelines depuis le fichier JSON local
        try {
            const response = await fetch('https://localhost:43098/api/resources/placeholders_guidelines.json', {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                return {
                    error: 'Fichier de guidelines non trouvé. Assurez-vous que placeholders_guidelines.json existe dans le dossier output.',
                    instruction: 'Utilisez template_library pour créer ou consulter les guidelines'
                };
            }

            const responseData = await response.json();

            // Le serveur retourne { filename, format: 'text', content: "..." }
            // Il faut parser le content qui est une string JSON
            const guidelinesData = JSON.parse(responseData.content);

            // Normaliser UNIQUEMENT pour chercher la guideline (enlever accolades ET footnotes)
            const normalizedPlaceholder = localTools.normalizePlaceholderName(placeholder);

            // Vérifier si la guideline existe
            if (!guidelinesData.placeholders[normalizedPlaceholder]) {
                return {
                    error: `Aucune guideline trouvée pour le placeholder "${placeholder}"`,
                    instruction: 'Utilisez template_library({ action: "create" }) pour ajouter une guideline pour ce placeholder'
                };
            }

            const placeholderData = guidelinesData.placeholders[normalizedPlaceholder];

            return {
                placeholder: placeholder,
                guideline: placeholderData.guideline
            };

        } catch (error) {
            console.error('[draft] ❌ Erreur chargement guidelines:', error);
            return { error: `Erreur lors du chargement des guidelines: ${error.message}` };
        }
    }

    // ÉTAPE 4 : Remplir un placeholder
    if (action === 'fill_placeholder') {
        if (!draftConclusionsState.templateInjected) {
            return {
                error: 'Aucun template n\'a été injecté. Veuillez d\'abord utiliser action="inject_template"'
            };
        }

        if (!placeholder || !content) {
            return {
                error: 'Veuillez fournir à la fois "placeholder" (ex: "{{FAITS}}") et "content" (le texte de remplacement)'
            };
        }

        try {
            // Déanonymiser le contenu avant de l'injecter
            const deanonymizedContent = await anonymizeText(content, 'deanonymize');

            // Normaliser le placeholder pour la validation et le remplacement (sans métadonnées/footnotes)
            const normalizedPlaceholderName = localTools.normalizePlaceholderName(placeholder);

            // Valider le contenu selon les règles du placeholder
            const validation = await validatePlaceholderContent(normalizedPlaceholderName, deanonymizedContent);
            if (!validation.valid) {
                return {
                    error: `<error>Validation refusée pour ${placeholder}</error>`,
                    message: validation.message,
                    instruction: 'Corrigez le contenu selon les règles de validation indiquées'
                };
            }

            // Utiliser editDoc avec l'opération replace pour bénéficier de tout le support Markdown
            // (footnotes, headings, listes, formatage, etc.)
            // skip_footnote_validation: true car l'outil draft a ses propres règles
            const result = await editDoc({
                operation: 'replace',
                placeholder: normalizedPlaceholderName,
                text: deanonymizedContent,
                skip_footnote_validation: true
            });

            // Vérifier si l'opération a réussi
            if (result.error) {
                throw new Error(result.error);
            }

            // Marquer le placeholder comme rempli (retirer seulement les accolades, GARDER la footnote pour différencier)
            const cleanPlaceholder = placeholder.replace(/[{}]/g, '');
            draftConclusionsState.placeholdersProvided[cleanPlaceholder] = true;
            await saveDraftState();

            console.log('[draft] ✅ Placeholder rempli:', placeholder);

            // Extraire dynamiquement les placeholders restants du document (body uniquement)
            let remainingPlaceholders = [];
            try {
                remainingPlaceholders = await Word.run(async (context) => {
                    // Récupérer uniquement le texte du body
                    const body = context.document.body;
                    body.load('text');
                    await context.sync();

                    // Regex pour trouver tous les {{PLACEHOLDER}} dans le document
                    const placeholderRegex = /\{\{([^}]+)\}\}/g;
                    const matches = [...body.text.matchAll(placeholderRegex)];

                    // Extraire les placeholders uniques
                    const seen = new Set();
                    const foundPlaceholders = matches
                        .map(match => `{{${match[1]}}}`)
                        .filter(p => {
                            if (seen.has(p)) return false;
                            seen.add(p);
                            return true;
                        });

                    console.log('[draft] 📋 fill_placeholder - Placeholders restants trouvés:', foundPlaceholders);
                    return foundPlaceholders;
                });
            } catch (error) {
                console.error('[draft] ❌ Erreur extraction placeholders restants:', error);
            }

            // Trier les placeholders restants et obtenir le prochain
            console.log('[draft] 📋 fill_placeholder - Placeholders restants avant tri:', remainingPlaceholders);
            const sortedPlaceholders = await localTools.sortPlaceholders([...remainingPlaceholders]);
            console.log('[draft] 📋 fill_placeholder - Placeholders triés:', sortedPlaceholders);
            const filledPlaceholders = Object.keys(draftConclusionsState.placeholdersProvided).map(p => `{{${p}}}`);
            console.log('[draft] 📋 fill_placeholder - Placeholders remplis:', filledPlaceholders);
            const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, filledPlaceholders);
            console.log('[draft] 📋 fill_placeholder - Next placeholder info:', nextPlaceholderInfo);

            const fillResult = {
                success: true,
                message: `Placeholder "${placeholder}" rempli avec succès`,
                placeholder_filled: placeholder
            };

            if (nextPlaceholderInfo) {
                fillResult.next_placeholder = nextPlaceholderInfo.placeholder;
                if (nextPlaceholderInfo.guideline) {
                    fillResult.next_placeholder_guideline = nextPlaceholderInfo.guideline;
                }
            }

            console.log('[draft] 📋 fill_placeholder - Résultat final:', fillResult);
            return fillResult;

        } catch (error) {
            console.error('[draft] ❌ Erreur remplissage placeholder:', error);
            return { error: `Erreur lors du remplissage du placeholder: ${error.message}` };
        }
    }

    // ÉTAPE 5 : Vérifier la complétion
    if (action === 'check_completion') {
        // Extraire dynamiquement tous les placeholders du document (incluant ceux remplis et non remplis)
        let allPlaceholders = [];
        let remainingPlaceholders = [];

        try {
            await Word.run(async (context) => {
                // Récupérer TOUT le texte du document (body + headers + footers)
                const body = context.document.body;
                const sections = context.document.sections;
                sections.load('items');

                body.load('text');
                await context.sync();

                let allText = body.text;

                // Ajouter le texte des headers et footers de toutes les sections
                for (const section of sections.items) {
                    const headers = section.getHeader('primary');
                    const footers = section.getFooter('primary');
                    const headerFirst = section.getHeader('firstPage');
                    const footerFirst = section.getFooter('firstPage');
                    const headerEven = section.getHeader('evenPages');
                    const footerEven = section.getFooter('evenPages');

                    headers.load('text');
                    footers.load('text');
                    headerFirst.load('text');
                    footerFirst.load('text');
                    headerEven.load('text');
                    footerEven.load('text');

                    await context.sync();

                    // Concaténer tous les textes
                    if (headers.text) allText += '\n' + headers.text;
                    if (footers.text) allText += '\n' + footers.text;
                    if (headerFirst.text) allText += '\n' + headerFirst.text;
                    if (footerFirst.text) allText += '\n' + footerFirst.text;
                    if (headerEven.text) allText += '\n' + headerEven.text;
                    if (footerEven.text) allText += '\n' + footerEven.text;
                }

                // Regex plus permissive pour capturer tous les placeholders (majuscules, minuscules, chiffres, underscores, espaces, etc.)
                const placeholderRegex = /\{\{([^}]+)\}\}/g;
                const matches = [...allText.matchAll(placeholderRegex)];

                // Debug: afficher le texte et les matches
                console.log('[draft] 🔍 DEBUG check_completion:');
                console.log('[draft] 📄 Longueur du texte total (body+headers+footers):', allText.length);
                console.log('[draft] 🔎 Nombre de matches regex:', matches.length);
                console.log('[draft] 📋 Matches bruts:', matches.map(m => `{{${m[1]}}}`));
                console.log('[draft] 🔍 Recherche PLAISE:', allText.includes('{{PLAISE}}') ? 'TROUVÉ' : 'PAS TROUVÉ');
                console.log('[draft] 🔍 Recherche PLAISE (case insensitive):', allText.toLowerCase().includes('plaise') ? 'TROUVÉ' : 'PAS TROUVÉ');

                const seen = new Set();
                remainingPlaceholders = matches
                    .map(match => `{{${match[1]}}}`)
                    .filter(p => {
                        if (seen.has(p)) return false;
                        seen.add(p);
                        return true;
                    });

                console.log('[draft] ✅ Placeholders uniques trouvés:', remainingPlaceholders);
            });

            // Combiner les placeholders remplis et restants pour avoir le total
            const filledPlaceholders = Object.keys(draftConclusionsState.placeholdersProvided).map(p => `{{${p}}}`);

            // Calculer le total unique de placeholders (remplis + restants)
            const allPlaceholdersSet = new Set([...filledPlaceholders, ...remainingPlaceholders]);
            allPlaceholders = Array.from(allPlaceholdersSet);

            // Trier les placeholders restants et obtenir le prochain
            const sortedPlaceholders = await localTools.sortPlaceholders([...remainingPlaceholders]);
            const nextPlaceholderInfo = await localTools.getNextPlaceholder(sortedPlaceholders, filledPlaceholders);

            const completionResult = {
                template_injected: draftConclusionsState.templateInjected,
                template_name: draftConclusionsState.templateName,
                total_placeholders: allPlaceholders.length,
                filled_placeholders: filledPlaceholders,
                remaining_placeholders: sortedPlaceholders.length
            };

            if (nextPlaceholderInfo) {
                completionResult.next_placeholder = nextPlaceholderInfo.placeholder;
                if (nextPlaceholderInfo.guideline) {
                    completionResult.next_placeholder_guideline = nextPlaceholderInfo.guideline;
                }
            }

            // Si tous les placeholders sont remplis, supprimer l'état sauvegardé
            if (remainingPlaceholders.length === 0) {
                await deleteDraftState();
                // Réinitialiser l'état en mémoire
                draftConclusionsState.templateInjected = false;
                draftConclusionsState.templateName = null;
                draftConclusionsState.placeholdersProvided = {};
            }

            return completionResult;

        } catch (error) {
            console.error('[draft] ❌ Erreur vérification complétion:', error);
            return { error: `Erreur lors de la vérification: ${error.message}` };
        }
    }

    return {
        error: 'Action invalide. Actions supportées: check_template, inject_template, get_placeholder_instructions, fill_placeholder, check_completion'
    };
},
template_library: async (params) => {
    const { action, placeholder, guideline, new_placeholder, new_guideline, query, validation, new_validation, template_name, source_template } = params;

    console.log('[template_library] 📚 Action:', action);

    // Fonction helper pour déterminer le fichier JSON à utiliser (template spécifique ou global)
    const getGuidelinesFileName = () => {
        // Si un template a été injecté, chercher le JSON correspondant
        if (draftConclusionsState.templateInjected && draftConclusionsState.templateName) {
            // Ex: "01 - Template Assignation.docx" → "01 - Template Assignation.json"
            return draftConclusionsState.templateName.replace('.docx', '.json');
        }
        // Sinon, utiliser le fichier global par défaut
        return 'placeholders_guidelines.json';
    };

    // Fonction helper pour charger les guidelines depuis le fichier JSON (template spécifique uniquement)
    const loadGuidelines = async () => {
        try {
            const templateJsonFile = getGuidelinesFileName();

            // Charger le fichier JSON spécifique au template
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(templateJsonFile)}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                throw new Error(`Fichier de guidelines introuvable: ${templateJsonFile}. Veuillez créer ce fichier avec template_library.`);
            }

            const result = await response.json();
            const parsed = result.content ? JSON.parse(result.content) : result;
            console.log(`[template_library] ✅ Guidelines chargées depuis: ${templateJsonFile}`);
            return parsed;
        } catch (error) {
            console.error('[template_library] ❌ Error in loadGuidelines:', error);
            throw error;
        }
    };

    // Fonction helper pour sauvegarder les guidelines dans le fichier JSON (template spécifique ou global)
    const saveGuidelines = async (data) => {
        try {
            const templateJsonFile = getGuidelinesFileName();

            // Sauvegarder dans le fichier JSON correspondant au template
            const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(templateJsonFile)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: JSON.stringify(data, null, 2),
                    format: 'text'
                })
            });

            if (!response.ok) {
                throw new Error(`Erreur lors de la sauvegarde du fichier ${templateJsonFile}`);
            }

            console.log(`[template_library] ✅ Guidelines sauvegardées dans: ${templateJsonFile}`);
            return await response.json();
        } catch (error) {
            console.error('[template_library] ❌ Erreur sauvegarde guidelines:', error);
            throw new Error(`Impossible de sauvegarder les guidelines: ${error.message}`);
        }
    };

    // ACTION 1 : Lister tous les placeholders (sans guidelines)
    if (action === 'list_all') {
        try {
            const guidelinesData = await loadGuidelines();
            const placeholdersList = Object.entries(guidelinesData.placeholders).map(([key, data]) => ({
                name: `{{${key}}}`,
                step: data.step
            })).sort((a, b) => (a.step || 9999) - (b.step || 9999));

            return {
                success: true,
                total_placeholders: placeholdersList.length,
                placeholders: placeholdersList,
                note: 'Liste de tous les placeholders disponibles triés par step (utilisez action="get_guideline" pour voir les guidelines)'
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur list_all:', error);
            return { error: error.message };
        }
    }

    // ACTION 2 : Recherche large par query
    if (action === 'search') {
        if (!query) {
            return {
                error: 'Veuillez fournir un paramètre "query" pour la recherche',
                example: '{ action: "search", query: "assignation" }'
            };
        }

        try {
            const guidelinesData = await loadGuidelines();
            const searchTerm = query.toLowerCase();

            // Rechercher dans les noms de placeholders
            const matchingPlaceholders = Object.keys(guidelinesData.placeholders)
                .filter(p => p.toLowerCase().includes(searchTerm))
                .map(p => `{{${p}}}`);

            if (matchingPlaceholders.length === 0) {
                return {
                    success: true,
                    message: `Aucun placeholder trouvé contenant "${query}"`,
                    results: []
                };
            }

            return {
                success: true,
                query: query,
                results_count: matchingPlaceholders.length,
                results: matchingPlaceholders,
                note: 'Utilisez action="get_guideline" avec le nom exact pour voir les guidelines'
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur search:', error);
            return { error: error.message };
        }
    }

    // ACTION 3 : Récupérer la guideline d'un placeholder spécifique
    if (action === 'get_guideline') {
        if (!placeholder) {
            return {
                error: 'Veuillez fournir le paramètre "placeholder" (ex: "{{FAITS}}" ou "FAITS")',
                example: '{ action: "get_guideline", placeholder: "{{FAITS}}" }'
            };
        }

        try {
            const guidelinesData = await loadGuidelines();
            // Normaliser pour rechercher la guideline (enlever accolades ET footnotes)
            const normalizedPlaceholder = localTools.normalizePlaceholderName(placeholder);

            if (!guidelinesData.placeholders[normalizedPlaceholder]) {
                return {
                    error: `Placeholder "${placeholder}" non trouvé dans la bibliothèque`,
                    instruction: 'Utilisez action="list_all" pour voir tous les placeholders disponibles'
                };
            }

            const placeholderData = guidelinesData.placeholders[normalizedPlaceholder];
            return {
                success: true,
                placeholder: `{{${normalizedPlaceholder}}}`,
                guideline: placeholderData.guideline || [],
                step: placeholderData.step,
                validation: placeholderData.validation || { enabled: false, rules: [] },
                note: 'Utilisez action="edit" pour modifier cette guideline, step ou les règles de validation'
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur get_guideline:', error);
            return { error: error.message };
        }
    }

    // ACTION 4 : Créer un nouveau placeholder
    if (action === 'create') {
        if (!placeholder || !guideline) {
            return {
                error: 'Veuillez fournir "placeholder" et "guideline"',
                example: '{ action: "create", placeholder: "{{NOUVEAU_PLACEHOLDER}}", guideline: ["Instruction 1", "Instruction 2"] }'
            };
        }

        // Validation de la guideline
        if (!Array.isArray(guideline) || guideline.length === 0) {
            return {
                error: 'Le paramètre "guideline" doit être un tableau non vide de chaînes',
                example: '{ action: "create", placeholder: "{{NOUVEAU}}", guideline: ["Instruction 1", "Instruction 2"] }'
            };
        }

        try {
            const guidelinesData = await loadGuidelines();
            const cleanPlaceholder = placeholder.replace(/[{}]/g, '');

            // Vérifier si le placeholder existe déjà
            if (guidelinesData.placeholders[cleanPlaceholder]) {
                return {
                    error: `Le placeholder "${placeholder}" existe déjà`,
                    instruction: 'Utilisez action="edit" pour le modifier'
                };
            }

            // Ajouter le nouveau placeholder
            const newPlaceholderData = {
                name: cleanPlaceholder,
                guideline: guideline,
                validation: validation || { enabled: false, rules: [] }
            };

            // Ajouter step si fourni
            if (params.step !== undefined) {
                newPlaceholderData.step = params.step;
            }

            guidelinesData.placeholders[cleanPlaceholder] = newPlaceholderData;

            await saveGuidelines(guidelinesData);

            return {
                success: true,
                message: `Placeholder "${placeholder}" créé avec succès`,
                placeholder: `{{${cleanPlaceholder}}}`,
                guideline: guideline,
                step: newPlaceholderData.step,
                validation: validation || { enabled: false, rules: [] }
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur create:', error);
            return { error: error.message };
        }
    }

    // ACTION 5 : Éditer un placeholder existant
    if (action === 'edit') {
        if (!placeholder) {
            return {
                error: 'Veuillez fournir le paramètre "placeholder"',
                example: '{ action: "edit", placeholder: "{{FAITS}}", new_placeholder: "{{FAITS_MODIFIE}}", new_guideline: ["Nouvelle instruction"] }'
            };
        }

        if (!new_placeholder && !new_guideline && !new_validation && params.step === undefined) {
            return {
                error: 'Veuillez fournir au moins "new_placeholder", "new_guideline", "step" ou "new_validation" pour effectuer une modification',
                examples: {
                    guideline: '{ action: "edit", placeholder: "{{FAITS}}", new_guideline: ["Instruction modifiée"] }',
                    step: '{ action: "edit", placeholder: "{{FAITS}}", step: 5 }',
                    validation: '{ action: "edit", placeholder: "{{ANALYSE}}", new_validation: { enabled: true, rules: [{ type: "footnote", message: "Message d\'erreur" }] } }'
                }
            };
        }

        try {
            const guidelinesData = await loadGuidelines();
            const cleanPlaceholder = placeholder.replace(/[{}]/g, '');

            // Vérifier si le placeholder existe
            if (!guidelinesData.placeholders[cleanPlaceholder]) {
                return {
                    error: `Placeholder "${placeholder}" non trouvé`,
                    instruction: 'Utilisez action="create" pour créer un nouveau placeholder'
                };
            }

            const originalData = guidelinesData.placeholders[cleanPlaceholder];
            let finalPlaceholder = cleanPlaceholder;

            // Si on renomme le placeholder
            if (new_placeholder) {
                const cleanNewPlaceholder = new_placeholder.replace(/[{}]/g, '');

                // Vérifier que le nouveau nom n'existe pas déjà
                if (cleanNewPlaceholder !== cleanPlaceholder && guidelinesData.placeholders[cleanNewPlaceholder]) {
                    return {
                        error: `Le placeholder "${new_placeholder}" existe déjà`,
                        instruction: 'Choisissez un autre nom'
                    };
                }

                // Supprimer l'ancien et créer le nouveau
                delete guidelinesData.placeholders[cleanPlaceholder];
                finalPlaceholder = cleanNewPlaceholder;
            }

            // Mettre à jour la guideline, step et/ou la validation
            const updatedData = {
                name: finalPlaceholder,
                guideline: new_guideline || originalData.guideline || [],
                validation: new_validation !== undefined ? new_validation : (originalData.validation || { enabled: false, rules: [] })
            };

            // Mettre à jour le step si fourni, sinon garder l'original
            if (params.step !== undefined) {
                updatedData.step = params.step;
            } else if (originalData.step !== undefined) {
                updatedData.step = originalData.step;
            }

            guidelinesData.placeholders[finalPlaceholder] = updatedData;

            await saveGuidelines(guidelinesData);

            return {
                success: true,
                message: `Placeholder modifié avec succès`,
                original_placeholder: `{{${cleanPlaceholder}}}`,
                updated_placeholder: `{{${finalPlaceholder}}}`,
                updated_guideline: updatedData.guideline,
                updated_step: updatedData.step,
                updated_validation: updatedData.validation,
                changes: {
                    renamed: new_placeholder ? true : false,
                    guideline_updated: new_guideline ? true : false,
                    step_updated: params.new_step !== undefined ? true : false,
                    validation_updated: new_validation !== undefined ? true : false
                }
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur edit:', error);
            return { error: error.message };
        }
    }

    // ACTION 6 : Supprimer un placeholder
    if (action === 'delete') {
        if (!placeholder) {
            return {
                error: 'Veuillez fournir le paramètre "placeholder"',
                example: '{ action: "delete", placeholder: "{{FAITS}}" }'
            };
        }

        try {
            const guidelinesData = await loadGuidelines();
            const cleanPlaceholder = placeholder.replace(/[{}]/g, '');

            // Vérifier si le placeholder existe
            if (!guidelinesData.placeholders[cleanPlaceholder]) {
                return {
                    error: `Placeholder "${placeholder}" non trouvé`,
                    instruction: 'Utilisez action="list_all" pour voir tous les placeholders disponibles'
                };
            }

            // Sauvegarder les données du placeholder avant suppression (pour confirmation)
            const deletedData = guidelinesData.placeholders[cleanPlaceholder];

            // Supprimer le placeholder
            delete guidelinesData.placeholders[cleanPlaceholder];

            await saveGuidelines(guidelinesData);

            return {
                success: true,
                message: `Placeholder "{{${cleanPlaceholder}}}" supprimé avec succès`,
                deleted_placeholder: `{{${cleanPlaceholder}}}`,
                deleted_guidelines: deletedData.guidelines || deletedData.guideline || [],
                remaining_placeholders_count: Object.keys(guidelinesData.placeholders).length
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur delete:', error);
            return { error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // GESTION DES TEMPLATES
    // ═══════════════════════════════════════════════════════════════

    // ACTION 7 : Lister tous les templates disponibles
    if (action === 'list_templates') {
        try {
            const response = await fetch('https://localhost:43098/api/resources');
            if (!response.ok) throw new Error((await response.json()).error);
            const resourcesData = await response.json();

            // Filtrer uniquement les fichiers .docx contenant "Template" ou "Modèle"
            const filesList = resourcesData.resources || resourcesData.files || [];
            const templates = filesList.filter(file =>
                file.filename &&
                file.filename.endsWith('.docx') &&
                (file.filename.toLowerCase().includes('template') || file.filename.toLowerCase().includes('modèle'))
            );

            return {
                success: true,
                total_templates: templates.length,
                templates: templates.map(t => ({
                    name: t.filename,
                    has_guidelines: filesList.some(f => f.filename === t.filename.replace('.docx', '.json'))
                }))
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur list_templates:', error);
            return { error: error.message };
        }
    }

    // ACTION 8 : Créer un nouveau template à partir du document actif
    if (action === 'create_template') {
        if (!template_name) {
            return {
                error: 'Veuillez fournir le paramètre "template_name"',
                example: '{ action: "create_template", template_name: "03 - Nouveau Template.docx" }'
            };
        }

        if (!template_name.endsWith('.docx')) {
            return { error: 'Le nom du template doit se terminer par .docx' };
        }

        // Demander validation utilisateur
        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Créer un nouveau template : ${template_name}`,
                `Le document actuel sera analysé, converti en placeholders, et sauvegardé comme nouveau template avec ses guidelines.`
            );
            if (!approved) {
                return { error: 'Création du template refusée par l\'utilisateur' };
            }
        }

        try {
            // ÉTAPE 1 : Analyser le document actif et extraire le contenu
            let documentContent = '';
            let placeholders = [];

            await Word.run(async (context) => {
                const body = context.document.body;
                body.load('text');
                await context.sync();
                documentContent = body.text;
            });

            // ÉTAPE 2 : Détecter les sections/patterns existants et générer des placeholders
            // (Le LLM devra faire cette analyse - on retourne juste une structure de base)
            const guidelinesStructure = {
                placeholders: {},
                metadata: {
                    created_at: new Date().toISOString(),
                    source: 'document analysis'
                }
            };

            // ÉTAPE 3 : Sauvegarder le document actuel comme template
            // Obtenir le document en base64 (en DEHORS de Word.run)
            console.log('[create_template] 📥 Récupération du document...');
            const base64Content = await new Promise((resolve, reject) => {
                Office.context.document.getFileAsync(Office.FileType.Compressed, { sliceSize: 65536 }, (result) => {
                    if (result.status === Office.AsyncResultStatus.Succeeded) {
                        const file = result.value;
                        const slices = [];
                        let sliceCount = file.sliceCount;
                        let slicesReceived = 0;

                        console.log(`[create_template] 📊 Fichier: ${file.size} bytes, ${sliceCount} slices`);

                        const getSlice = (index) => {
                            file.getSliceAsync(index, (sliceResult) => {
                                if (sliceResult.status === Office.AsyncResultStatus.Succeeded) {
                                    // slice.data est un tableau de bytes (Uint8Array-like)
                                    slices[index] = sliceResult.value.data;
                                    slicesReceived++;

                                    if (slicesReceived === sliceCount) {
                                        file.closeAsync();
                                        console.log('[create_template] ✅ Tous les slices récupérés, conversion en base64...');

                                        try {
                                            // Concaténer tous les tableaux de bytes en un seul
                                            let allBytes = [];
                                            for (let i = 0; i < sliceCount; i++) {
                                                allBytes = allBytes.concat(Array.from(slices[i]));
                                            }

                                            // Convertir le tableau de bytes en string binaire
                                            let binaryString = '';
                                            const len = allBytes.length;
                                            for (let i = 0; i < len; i++) {
                                                binaryString += String.fromCharCode(allBytes[i]);
                                            }

                                            // Encoder en base64
                                            const base64 = btoa(binaryString);
                                            console.log('[create_template] ✅ Conversion base64 terminée:', base64.length, 'caractères');
                                            resolve(base64);
                                        } catch (conversionError) {
                                            console.error('[create_template] ❌ Erreur conversion base64:', conversionError);
                                            reject(new Error('Erreur lors de la conversion en base64: ' + conversionError.message));
                                        }
                                    } else {
                                        getSlice(index + 1);
                                    }
                                } else {
                                    file.closeAsync();
                                    reject(new Error('Erreur lors de la récupération d\'un slice'));
                                }
                            });
                        };
                        getSlice(0);
                    } else {
                        reject(new Error('Impossible d\'obtenir le fichier: ' + result.error.message));
                    }
                });
            });

            // Sauvegarder le template .docx
            console.log('[create_template] 💾 Sauvegarde du template:', template_name);
            console.log('[create_template] 📊 Taille base64:', base64Content ? base64Content.length : 'undefined');

            const saveTemplateResponse = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(template_name)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: base64Content,
                    format: 'base64'
                })
            });

            if (!saveTemplateResponse.ok) {
                const errorText = await saveTemplateResponse.text();
                console.error('[create_template] ❌ Erreur serveur:', errorText);
                throw new Error(`Erreur lors de la sauvegarde du template .docx: ${saveTemplateResponse.status} - ${errorText}`);
            }

            console.log('[create_template] ✅ Template .docx sauvegardé');

            // Sauvegarder le fichier JSON des guidelines (structure vide pour que le LLM le remplisse)
            const jsonFileName = template_name.replace('.docx', '.json');
            const saveJsonResponse = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(jsonFileName)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: JSON.stringify(guidelinesStructure, null, 2),
                    format: 'text'
                })
            });

            if (!saveJsonResponse.ok) {
                const errorText = await saveJsonResponse.text();
                console.error('[create_template] ❌ Erreur sauvegarde JSON:', errorText);
                throw new Error(`Erreur lors de la sauvegarde du fichier JSON: ${saveJsonResponse.status} - ${errorText}`);
            }

            console.log('[create_template] ✅ Fichier JSON sauvegardé');

            return {
                success: true,
                message: `Template "${template_name}" créé avec succès`,
                template_file: template_name,
                guidelines_file: jsonFileName,
                document_preview: documentContent.substring(0, 500),
                next_step: 'Utilisez template_library avec action="create" pour ajouter des placeholders et leurs guidelines au fichier ' + jsonFileName
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur create_template:', error);
            return { error: error.message };
        }
    }

    // ACTION 9 : Copier un template existant
    if (action === 'copy_template') {
        if (!source_template || !template_name) {
            return {
                error: 'Veuillez fournir "source_template" et "template_name"',
                example: '{ action: "copy_template", source_template: "01 - Template.docx", template_name: "03 - Nouveau.docx" }'
            };
        }

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `Copier le template : ${source_template}`,
                `Nouveau nom : ${template_name}`
            );
            if (!approved) {
                return { error: 'Copie du template refusée par l\'utilisateur' };
            }
        }

        try {
            // Copier le fichier .docx
            const copyDocxResponse = await fetch('https://localhost:43098/api/resources/copy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: source_template,
                    new_filename: template_name
                })
            });

            if (!copyDocxResponse.ok) {
                throw new Error('Erreur lors de la copie du template .docx');
            }

            // Copier le fichier JSON (s'il existe)
            const sourceJsonName = source_template.replace('.docx', '.json');
            const targetJsonName = template_name.replace('.docx', '.json');

            let jsonCopied = false;
            try {
                const copyJsonResponse = await fetch('https://localhost:43098/api/resources/copy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: sourceJsonName,
                        new_filename: targetJsonName
                    })
                });
                jsonCopied = copyJsonResponse.ok;
            } catch (jsonError) {
                console.warn('[template_library] ⚠️ Fichier JSON source introuvable, création d\'un nouveau');

                // Créer un nouveau fichier JSON vide
                await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(targetJsonName)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: JSON.stringify({ placeholders: {} }, null, 2),
                        format: 'text'
                    })
                });
                jsonCopied = false;
            }

            return {
                success: true,
                message: `Template copié avec succès`,
                source: source_template,
                destination: template_name,
                json_copied: jsonCopied,
                guidelines_file: targetJsonName
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur copy_template:', error);
            return { error: error.message };
        }
    }

    // ACTION 10 : Supprimer un template
    if (action === 'delete_template') {
        if (!template_name) {
            return {
                error: 'Veuillez fournir le paramètre "template_name"',
                example: '{ action: "delete_template", template_name: "03 - Template.docx" }'
            };
        }

        if (!config.autoApprove) {
            const approved = await requestApproval(
                `⚠️ SUPPRIMER le template : ${template_name}`,
                `Cette action supprimera le fichier .docx ET le fichier .json associé. IRRÉVERSIBLE.`
            );
            if (!approved) {
                return { error: 'Suppression du template refusée par l\'utilisateur' };
            }
        }

        try {
            // Supprimer le fichier .docx
            const deleteDocxResponse = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(template_name)}`, {
                method: 'DELETE'
            });

            if (!deleteDocxResponse.ok) {
                throw new Error('Erreur lors de la suppression du template .docx');
            }

            // Supprimer le fichier JSON (s'il existe)
            const jsonFileName = template_name.replace('.docx', '.json');
            let jsonDeleted = false;

            try {
                const deleteJsonResponse = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(jsonFileName)}`, {
                    method: 'DELETE'
                });
                jsonDeleted = deleteJsonResponse.ok;
            } catch (jsonError) {
                console.warn('[template_library] ⚠️ Fichier JSON introuvable');
            }

            return {
                success: true,
                message: `Template "${template_name}" supprimé avec succès`,
                deleted_files: [template_name, ...(jsonDeleted ? [jsonFileName] : [])]
            };
        } catch (error) {
            console.error('[template_library] ❌ Erreur delete_template:', error);
            return { error: error.message };
        }
    }

    return {
        error: 'Action invalide. Actions supportées: create_template, copy_template, delete_template, list_templates, list_all, search, get_guideline, create, edit, delete'
    };
},

// OUTIL : stamping les pièces pour bordereau
stamping: async (params) => {
    const { pieces } = params;

    console.log('[stamping] 🖼️ Tamponnage de pièces:', pieces);

    // Vérifier que des pièces ont été fournies
    if (!pieces || !Array.isArray(pieces) || pieces.length === 0) {
        return {
            error: 'Paramètre "pieces" requis : liste d\'IDs des pièces à stamping dans l\'ordre (ex: ["0001", "0003", "0002"])'
        };
    }

    // Vérifier qu'un document est chargé
    if (!anonymization.documentId) {
        return {
            error: 'Aucun document chargé. Veuillez d\'abord charger des fichiers avec le bouton 📎.'
        };
    }

    try {
        // Appeler l'API de tamponnage (le tampon est chargé côté serveur)
        const response = await fetch('https://localhost:43098/api/stamping', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                pieces: pieces,
                documentId: anonymization.documentId,
                // Les pièces sont écrites dans
                // <dossier du Word ouvert>/Pièces tamponnées
                folder: await getCurrentDocFolder()
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Erreur HTTP ${response.status}`);
        }

        const result = await response.json();

        // Formater le résultat pour le LLM (simplifié, sans chemins absolus)
        const successList = result.results.filter(r => r.success);
        const failureList = result.results.filter(r => !r.success);

        // Message simplifié
        let message = '';

        if (failureList.length === 0) {
            // Succès total
            message = `✅ ${result.summary.success} pièce(s) tamponnée(s) avec succès`;
        } else {
            // Succès partiel ou échec
            message = `⚠️ ${result.summary.success}/${result.summary.total} pièce(s) tamponnée(s)\n`;
            message += `❌ Échec pour les ID : ${failureList.map(r => r.id).join(', ')}`;
        }

        return {
            success: failureList.length === 0,
            message: message,
            failures: failureList.map(r => ({ id: r.id, piece_number: r.pieceNumber }))
        };

    } catch (error) {
        console.error('[stamping] ❌ Erreur:', error);
        return {
            error: `Erreur lors du tamponnage : ${error.message}`
        };
    }
},

Call_Ollama: async (params) => {
    console.log('[Call_Ollama] 🤖 Lancement de l\'analyse Ollama des documents');

    // Vérifier qu'un document est chargé
    if (!anonymization.documentId) {
        return {
            error: 'Aucun document chargé. Veuillez d\'abord charger des fichiers avec le bouton 📎.'
        };
    }

    // Vérifier qu'il y a des fichiers à analyser
    if (!anonymization.files || anonymization.files.length === 0) {
        return {
            error: 'Aucun fichier chargé dans le dossier juridique.'
        };
    }

    // Demander l'approbation utilisateur si nécessaire
    if (!config.autoApprove) {
        const approved = await requestApproval(
            `Le modèle souhaite lancer l'analyse Ollama`,
            `Analyse de ${anonymization.files.length} document(s) pour extraire type, date et analyse juridique`
        );
        if (!approved) {
            return { error: 'Analyse refusée par l\'utilisateur' };
        }
    }

    try {
        // Lancer l'analyse en arrière-plan sans attendre la fin
        ollamaAnalyzeDocuments().catch(error => {
            console.error('[Call_Ollama] ❌ Erreur analyse en arrière-plan:', error);
        });

        // Retourner immédiatement au LLM
        return {
            success: true,
            message: `✅ Analyse Ollama lancée en arrière-plan pour ${anonymization.files.length} document(s). L'analyse peut prendre plusieurs minutes selon la taille des documents. Les résultats seront automatiquement sauvegardés dans compilation_dossier.json.`
        };

    } catch (error) {
        console.error('[Call_Ollama] ❌ Erreur:', error);
        return {
            error: `Erreur lors du lancement de l'analyse Ollama : ${error.message}`
        };
    }
}
};

async function callMCPRemote(method, params) {
    const payload = {
        jsonrpc: '2.0',
        method: method,
        params: params,
        id: Date.now()
    };

    console.log(`🔌 [MCP] Appel ${method}`);

    try {
        // Essayer d'abord le proxy local
        try {
            const proxyResponse = await fetch('https://localhost:43098/api/mcp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (proxyResponse.ok) {
                const data = await proxyResponse.json();
                console.log(`✅ [MCP] Via proxy local`);
                return data.result;
            }
        } catch (proxyError) {
            console.warn('⚠️ [MCP] Proxy local inaccessible, appel direct...');
        }

        // Fallback: appel direct au serveur MCP distant
        if (!config.mcpApiKey) {
            throw new Error('Clé API MCP manquante');
        }

        const response = await fetch(config.mcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.mcpApiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Pas de détails');
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const data = await response.json();
        console.log(`✅ [MCP] Via appel direct`);

        if (data.error) {
            throw new Error(`Erreur MCP: ${data.error.message || JSON.stringify(data.error)}`);
        }

        return data.result;
    } catch (error) {
        console.error('❌ [MCP] Erreur:', error.message);
        throw error;
    }
}

// Initialisation MCP
async function initializeMCP() {
    console.log('🔌 [MCP] Tentative de connexion MCP Remote...');
    console.log('🔌 [MCP] URL configurée:', config.mcpUrl);
    console.log('🔌 [MCP] Clé API:', config.mcpApiKey ? `***${config.mcpApiKey.slice(-8)}` : 'NON CHARGÉE');

    try {
        const result = await callMCPRemote('tools/list', {});
        console.log('🔌 [MCP] Résultat reçu:', result);

        if (!result || !result.tools) {
            console.warn('⚠️ [MCP] Aucun outil trouvé dans la réponse');
            config.mcpConnected = false;
            config.mcpTools = [];
            updateMCPStatus(false);
            return;
        }

        // Parser les outils MCP si nécessaire (ils peuvent être des strings JSON)
        config.mcpTools = (result.tools || []).map(tool => {
            // Si l'outil est une string JSON, le parser
            if (typeof tool === 'string') {
                return JSON.parse(tool);
            }
            return tool;
        });

        config.mcpConnected = true;
        updateMCPStatus(true);
        console.log('✅ [MCP] MCP Remote connecté:', result);
        console.log(`✅ [MCP] ${config.mcpTools.length} outils MCP disponibles`);
        if (config.mcpTools.length > 0) {
            console.log('✅ [MCP] Premier outil MCP parsé:', config.mcpTools[0]);
            console.log('✅ [MCP] Tous les outils MCP:', config.mcpTools.map(t => t.name).join(', '));
        }
    } catch (error) {
        config.mcpConnected = false;
        config.mcpTools = [];
        updateMCPStatus(false);
        console.error('❌ [MCP] Connexion MCP Remote échouée:', error);
        console.error('❌ [MCP] Détails:', error.message, error.stack);
    }
}

// Mise à jour statut MCP
function updateMCPStatus(connected) {
    const statusEl = document.getElementById('mcpStatus');
    if (statusEl) {
        statusEl.className = `status-indicator ${connected ? 'connected' : 'disconnected'}`;
    }
}

// Exécution d'outil
async function executeTool(toolName, params) {
    console.log(`Exécution outil: ${toolName}`, params);

    // Outils locaux
    if (localTools[toolName]) {
        if (!ENABLED_LOCAL_TOOL_NAMES.has(toolName)) {
            return { error: `Outil désactivé pour le modèle : ${toolName}` };
        }
        console.log(`Outil local trouvé: ${toolName}`);
        return await localTools[toolName](params);
    }

    // Outils MCP Remote
    if (config.mcpConnected) {
        console.log(`Appel MCP Remote pour: ${toolName}`);
        try {
            const result = await callMCPRemote('tools/call', {
                name: toolName,
                arguments: params
            });

            console.log(`Résultat MCP pour ${toolName}:`, result);

            // Si c'est du code Python, demander approbation et exécuter
            if (result.python_code) {
                const approved = await requestApproval(
                    'Le modèle souhaite exécuter du code Python',
                    result.python_code
                );

                if (approved) {
                    // Exécuter via MCP Remote
                    return await callMCPRemote('tools/call', {
                        name: 'execute_python',
                        arguments: { code: result.python_code }
                    });
                }
                return { error: 'Exécution refusée' };
            }

            return result;
        } catch (error) {
            console.error(`Erreur MCP pour ${toolName}:`, error);
            return { error: error.message };
        }
    }

    console.error(`Outil non disponible: ${toolName}`);
    return { error: 'Outil non disponible' };
}

// Appel LLM
async function callLLM(messages) {
    const provider = config.llmProvider;

    // Les anciens outils restent documentés dans le code pour pouvoir être
    // réactivés, mais seuls les schémas canoniques Word sont envoyés au modèle.
    const disabledLocalToolSchemas = [
        {
            name: 'read_case',
            description: `Recherche et gestion des pièces du dossier juridique.
            1. Listing available files : { show_structure: true }
            2. Querying by keywords : { query: "retard permis", search_mode: "OU" / "ET" / "EXACTE" }
            "EXACTE" enables you to query an exact quote.
            3 Querying by date { date_debut: "2023-01-01", date_fin: "2023-12-31" }
            4 Reading file content : { query: "0001", read_full: true }
            5 Reading MULTIPLE files at once : { query: "0001, 0002, 0003", read_full: true }
            6 Edit metadata & analysis : { edit: { id: "0001", date_document: "2025-03-12", analyse: "..." } }

            ⚠️ RULE : You are a Legal Counsel
            Automatically edit if a metadata is wrong,
            Automatically write a missing analysis (Short but exhaustive description from a legal point of view)
            Suggest edition if an analysis is incomplete.`,
            
            input_schema: {
                type: 'object',
                properties: {
                query: {
                    type: 'string',
                    description: 'Keywords or file id'
                },
                show_structure: {
                    type: 'boolean',
                    description: 'If true, returns files list',
                    default: false
                },
                date_debut: {
                    type: 'string',
                    description: 'Date de début (format: YYYY-MM-DD, optionnel)'
                },
                date_fin: {
                    type: 'string',
                    description: 'Date de fin (format: YYYY-MM-DD, optionnel)'
                },
                search_mode: {
                    type: 'string',
                    enum: ['OU', 'ET', 'EXACTE'],
                    description: 'Search mode : OU, ET, EXACTE (expression exacte)',
                    default: 'OU'
                },
                read_full: {
                    type: 'boolean',
                    description: 'if true with query="id", returns file content',
                    default: false
                },
                edit: {
                    type: 'object',
                    description: 'Metadata edition : {id: "0001", date_document?: "...", type_document?: "...", analyse?: "..."}',
                    properties: {
                    id: {
                        type: 'string',
                        description: 'file id to edit'
                    },
                    date_document: {
                        type: 'string',
                        description: 'new date (YYYY-MM-DD, optional)'
                    },
                    type_document: {
                        type: 'string',
                        description: 'New title (ex: "Jugement", "Contrat", optionnel)'
                    },
                    analyse: {
                        type: 'string',
                        description: 'New analysis : résumé concis + points d\'attention)'
                    }
                    },
                    required: ['id']
                }
                }
            }
        },
        {
            name: "get_resource",
            description: "Get guides, legal researches, writing examples",
            input_schema: {
                type: "object",
                properties: {
                    filename: {
                        type: "string",
                        description: "Name of the file"
                    },
                    action: {
                        type: "string",
                        enum: ["list", "read", "copy", "write", "rename", "delete"],
                        description: "If no filename, 'list' will be automatically applied"
                    },
                    content: {
                        type: "string",
                        description: "Content to add"
                    },
                    new_filename: {
                        type: "string",
                        description: "New filename"
                    }
                },
                required: []
            }
        },
        {
            name: "draft",
            description: `Tool for legal drafting.
        1. { action: "check_template" } : check if a template has been injected in the docx.
           → If no template is injected, automatically returns the list of available templates from the resources folder
        2. { action: "inject_template", template_name: "template_assignation.docx" }
           → If template_name is not provided, automatically returns the list of available templates
           ⚠️ USER AUTHORIZATION NECESSARY (doc will be emptied)
        3. { action: "get_placeholder_instructions", placeholder: "{{FAITS}}" } (optional - provides formatting guidelines)
        4. { action: "fill_placeholder", placeholder: "{{FAITS}}", content: "..." }
        5. { action: "check_completion" } : Check for remaining placeholders.

        Note: You can fill placeholders directly without calling get_placeholder_instructions first.`,

            input_schema: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["check_template", "inject_template", "get_placeholder_instructions", "fill_placeholder", "check_completion"],
                        description: "Action à effectuer dans le workflow"
                    },
                    template_name: {
                        type: "string",
                        description: "Nom EXACT du fichier template à injecter (ex: 'template_assignation.docx', 'template_conclusions.docx'). Utiliser get_resource pour lister les templates disponibles. (obligatoire pour action='inject_template')"
                    },
                    placeholder: {
                        type: "string",
                        description: "Nom du placeholder (ex: '{{FAITS}}') pour get_placeholder_instructions ou fill_placeholder"
                    },
                    content: {
                        type: "string",
                        description: "Contenu pour remplir un placeholder (obligatoire pour action='fill_placeholder')"
                    }
                },
                required: ["action"]
            }
        },
        {
            name: "template_library",
            description: "Placeholders & related guidelines. Actions: list_all, search, get_guideline, create, edit, delete.",
            input_schema: {
                type: "object",
                properties: {
                    action: {
                        type: "string",
                        enum: ["list_all", "search", "get_guideline", "create", "edit", "delete"],
                        description: "sub-tools"
                    },
                    query: {
                        type: "string",
                        description: "Terme de recherche (obligatoire pour action='search'). Recherche insensible à la casse dans les noms de placeholders"
                    },
                    placeholder: {
                        type: "string",
                        description: "Nom du placeholder (ex: '{{FAITS}}' ou 'FAITS'). Obligatoire pour actions 'get_guideline', 'create', 'edit', 'delete'"
                    },
                    guideline: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Tableau de chaînes contenant les instructions (obligatoire pour action='create')"
                    },
                    new_placeholder: {
                        type: "string",
                        description: "New placeholder name (create or edit)"
                    },
                    new_guideline: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Nouvelle guideline (optionnel pour action='edit'). Tableau de chaînes pour remplacer la guideline existante"
                    },
                    step: {
                        type: "number",
                        description: "Numéro d'ordre du placeholder (pour action='create' et 'edit'). Les placeholders sont triés par step croissant."
                    }
                },
                required: ["action"]
            }
        },
        {
            name: "stamping",
            description: `Outil pour créer un bordereau de pièces tamponnées.

Lorsque l'IA réalise un bordereau de pièces dans un document, elle peut utiliser cet outil.
Cet outil impose de cibler dans l'ordre les pièces présentes dans le fichier compilation_dossier, en ciblant leur ID uniquement.

L'outil retrouve automatiquement ces pièces via leur chemin sauvegardé, réalise une copie des fichiers,
les convertit en PDF si nécessaire, ajoute un tampon en haut à droite avec le numéro de pièce (1, 2, 3...),
et renomme chaque fichier "Pièce n°1", "Pièce n°2", etc., dans l'ordre exact donné.

Les fichiers tamponnés sont enregistrés dans le sous-dossier "Pièces tamponnées" du dossier de travail
(le dossier du document Word ouvert), jamais à la racine.

⚠️ PRÉREQUIS :
- Un tampon doit être configuré via le menu "🖼️ Configurer le tampon"
- Les fichiers source doivent être chargés et avoir un filePath valide

Exemple d'utilisation :
{ "pieces": ["0001", "0003", "0002"] }
→ Crée : "Pièce n°1" (ID 0001), "Pièce n°2" (ID 0003), "Pièce n°3" (ID 0002)`,

            input_schema: {
                type: "object",
                properties: {
                    pieces: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Liste des IDs des pièces à stamping, dans l'ordre souhaité (ex: ['0001', '0003', '0002']). L'ordre détermine la numérotation (Pièce n°1, Pièce n°2, etc.)"
                    }
                },
                required: ["pieces"]
            }
        },
        {
            name: "Call_Ollama",
            description: `Lance l'analyse Ollama des documents du dossier EN ARRIÈRE-PLAN.

⚠️ RÈGLE IMPORTANTE :
Cet outil doit être utilisé automatiquement lorsque read_case retourne des résultats
sans analyse (champ "analyse" manquant ou vide).

L'analyse Ollama extrait automatiquement :
- Le type de document (Jugement, Contrat, Courrier, etc.)
- La date du document (format YYYY-MM-DD)
- Une analyse juridique concise du contenu

⏱️ TEMPS D'EXÉCUTION :
L'analyse est ASYNCHRONE et peut prendre plusieurs minutes selon le nombre et la taille des documents.
L'outil retourne immédiatement un message de confirmation sans attendre la fin de l'analyse.
Les résultats sont automatiquement sauvegardés dans compilation_dossier.json au fur et à mesure.

⚠️ WORKFLOW RECOMMANDÉ :
1. Utiliser read_case avec { show_structure: true }
2. Si des pièces n'ont pas d'analyse → Call_Ollama automatiquement
3. Informer l'utilisateur que l'analyse est en cours
4. NE PAS relancer read_case immédiatement (l'analyse n'est pas terminée)
5. L'utilisateur peut utiliser read_case plus tard pour consulter les analyses

Usage : { }
Aucun paramètre requis, l'outil analyse tous les documents chargés.`,

            input_schema: {
                type: "object",
                properties: {},
                required: []
            }
        }

    ];

    const tools = [...ACTIVE_LOCAL_TOOL_SCHEMAS.values()];

    // 📊 Debug: afficher les outils disponibles
    console.log(`📊 Outils disponibles pour ${provider}:`);
    console.log(`   - Outils actifs: ${tools.length} (${tools.map(t => t.name).join(', ')})`);
    console.log(`   - Schémas désactivés conservés: ${disabledLocalToolSchemas.length}`);
    console.log(`   - Total outils envoyés: ${tools.length}`);

        if (provider === 'claude') {
            return await callClaude(messages, tools);
        } else if (provider === 'openai') {
            return await callOpenAI(messages, tools);
        } else if (provider === 'mistral') {
            return await callMistral(messages, tools);
        } else if (provider === 'ollama') {
            return await callOllama(messages, tools);
        }
}

/**
 * Tente d'appeler le LLM avec fallback automatique en cas d'erreur de paramètres
 */
async function callLLMWithFallback(provider, basePayload, apiCall) {
    const fallbackLevels = [
        // Niveau 1 : Tous les paramètres
        ['temperature', 'top_p', 'top_k', 'max_tokens'],
        // Niveau 2 : Sans top_k (OpenAI, Mistral)
        ['temperature', 'top_p', 'max_tokens'],
        // Niveau 3 : Sans top_p
        ['temperature', 'max_tokens'],
        // Niveau 4 : Minimal
        ['max_tokens']
    ];

    let lastError = null;

    for (let level = 0; level < fallbackLevels.length; level++) {
        try {
            const allowedParams = fallbackLevels[level];
            const filteredPayload = { ...basePayload };

            // Filtrer les paramètres selon le niveau
            const paramsToRemove = ['temperature', 'top_p', 'top_k', 'max_tokens']
                .filter(p => !allowedParams.includes(p));

            paramsToRemove.forEach(param => {
                delete filteredPayload[param];
                if (param === 'top_p') delete filteredPayload.top_p;
                if (param === 'top_k') delete filteredPayload.top_k;
                if (param === 'max_tokens') delete filteredPayload.max_tokens;
            });

            // Appeler l'API avec les paramètres filtrés
            const result = await apiCall(filteredPayload);

            return result;

        } catch (error) {
            lastError = error;

            // Si c'est une erreur de paramètres (400, 422), continuer au niveau suivant
            const isParamError = error.message.includes('400') || 
                                error.message.includes('422') ||
                                error.message.includes('parameter') ||
                                error.message.includes('invalid') ||
                                error.message.includes('not supported');

            if (!isParamError || level === fallbackLevels.length - 1) {
                // Si ce n'est pas une erreur de paramètres, ou si on est au dernier niveau, throw
                throw error;
            }

            // Sinon, continuer au niveau suivant
            console.log(`Niveau ${level + 1} échoué, passage au niveau ${level + 2}...`);
        }
    }

    // Si on arrive ici, toutes les tentatives ont échoué
    throw lastError;
}
async function callClaude(messages, tools) {
    // Debug: afficher les messages envoyés
    console.log('📤 Messages envoyés à Claude:', JSON.stringify(messages, null, 2));

    const basePayload = {
        model: config.claudeModel || 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        temperature: 0.1,
        top_p: 0.9,
        top_k: topK || 40,
        system: config.systemPrompt,
        messages: messages.map(m => {
            if (typeof m.content === 'string') {
                return { role: m.role, content: m.content };
            }
            return m;
        }),
        tools: tools,
        stream: true  // ✅ Streaming activé
    };

    return await callLLMWithFallback('claude', basePayload, async (payload) => {
        const response = await fetch('https://localhost:43098/api/claude', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.apiKey
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Claude API error (${response.status}): ${errorData.error?.message || 'Unknown error'}`);
        }

        // ✅ Parser le streaming SSE
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const processedContent = [];
        let buffer = '';
        let currentThinkingDiv = null;
        let currentTextDiv = null;
        let stopReason = null;
        let currentBlockIndex = null;

        while (true) {
            // Vérifier si l'arrêt a été demandé
            if (shouldStop) {
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim() || !line.startsWith('data: ')) continue;

                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);

                    // Gérer les différents types d'événements
                    if (event.type === 'content_block_start') {
                        currentBlockIndex = event.index;

                        if (event.content_block.type === 'thinking') {
                            // Créer un nouveau bloc thinking dans le chat
                            const messageDiv = document.createElement('div');
                            messageDiv.className = 'message thinking';
                            messageDiv.innerHTML = `
                                <div class="message-content">
                                    <div class="thinking-header">💭 Réflexion de l'IA</div>
                                    <div class="thinking-content" id="streaming-thinking"></div>
                                </div>
                            `;
                            appendToChatContainer(messageDiv);
                            currentThinkingDiv = document.getElementById('streaming-thinking');
                        } else if (event.content_block.type === 'text') {
                            // ✅ Créer un nouveau bloc de texte dans le chat
                            const messageDiv = document.createElement('div');
                            messageDiv.className = 'message assistant';
                            messageDiv.innerHTML = `
                                <div class="message-content">
                                    <div id="streaming-text"></div>
                                </div>
                            `;
                            appendToChatContainer(messageDiv);
                            currentTextDiv = document.getElementById('streaming-text');
                        } else if (event.content_block.type === 'tool_use') {
                            // Afficher l'outil utilisé
                            const toolMessage = document.createElement('div');
                            toolMessage.className = 'message tool';
                            toolMessage.innerHTML = `
                                <div class="message-content">
                                    <strong>${event.content_block.name}</strong>
                                </div>
                            `;
                            appendToChatContainer(toolMessage);

                            // Ajouter le tool_use au contenu
                            processedContent.push({
                                type: 'tool_use',
                                id: event.content_block.id,
                                name: event.content_block.name,
                                input: {}
                            });
                        }
                    } else if (event.type === 'content_block_delta') {
                        if (event.delta.type === 'thinking_delta') {
                            // Ajouter progressivement le thinking
                            if (currentThinkingDiv) {
                                const text = event.delta.thinking || '';
                                currentThinkingDiv.textContent += text;
                                document.getElementById('chatContainer').scrollTop =
                                    document.getElementById('chatContainer').scrollHeight;
                            }
                        } else if (event.delta.type === 'text_delta') {
                            // ✅ Afficher le texte progressivement - markdown appliqué en temps réel
                            if (currentTextDiv) {
                                // Accumuler le texte brut
                                if (!currentTextDiv.dataset.rawText) {
                                    currentTextDiv.dataset.rawText = '';
                                }
                                currentTextDiv.dataset.rawText += event.delta.text || '';

                                // Appliquer parseMarkdownStreaming pour un rendu progressif sûr
                                currentTextDiv.innerHTML = parseMarkdownStreaming(currentTextDiv.dataset.rawText);

                                document.getElementById('chatContainer').scrollTop =
                                    document.getElementById('chatContainer').scrollHeight;
                            }
                            
                            // Accumuler aussi dans processedContent pour l'historique
                            const textBlock = processedContent.find(b => b.type === 'text');
                            if (textBlock) {
                                textBlock.text += event.delta.text || '';
                            } else {
                                processedContent.push({ type: 'text', text: event.delta.text || '' });
                            }
                        } else if (event.delta.type === 'input_json_delta') {
                            // Accumuler les paramètres du tool_use
                            const toolUseBlock = processedContent.find(
                                (b, i) => b.type === 'tool_use' && i === currentBlockIndex
                            );
                            if (toolUseBlock) {
                                if (!toolUseBlock.inputJson) {
                                    toolUseBlock.inputJson = '';
                                }
                                toolUseBlock.inputJson += event.delta.partial_json || '';
                            }
                        }
                    } else if (event.type === 'content_block_stop') {
                        if (currentThinkingDiv) {
                            // Finaliser le bloc thinking
                            const thinkingText = currentThinkingDiv.textContent;
                            processedContent.push({ type: 'thinking', thinking: thinkingText });
                            currentThinkingDiv.removeAttribute('id');
                            currentThinkingDiv = null;
                        }

                        // ✅ Finaliser le bloc de texte
                        if (currentTextDiv) {
                            // Utiliser le texte brut accumulé
                            const finalText = currentTextDiv.dataset.rawText || currentTextDiv.textContent;

                            // Désanonymiser et parser le markdown
                            const deanonymizedText = await anonymizeText(finalText, 'deanonymize');
                            currentTextDiv.innerHTML = parseMarkdown(deanonymizedText);

                            delete currentTextDiv.dataset.rawText;
                            currentTextDiv.removeAttribute('id');
                            currentTextDiv = null;
                        }

                        // Finaliser le tool_use si présent
                        if (currentBlockIndex !== null) {
                            const toolUseBlock = processedContent[currentBlockIndex];
                            if (toolUseBlock && toolUseBlock.type === 'tool_use' && 'inputJson' in toolUseBlock) {
                                try {
                                    toolUseBlock.input = toolUseBlock.inputJson ? JSON.parse(toolUseBlock.inputJson) : {};
                                } catch (e) {
                                    console.error('Erreur parsing inputJson:', e);
                                    toolUseBlock.input = {};
                                }
                                delete toolUseBlock.inputJson;
                            }
                        }

                        currentBlockIndex = null;
                    } else if (event.type === 'message_delta') {
                        stopReason = event.delta.stop_reason;
                    }
                } catch (e) {
                    console.error('Erreur parsing SSE:', e, line);
                }
            }
        }
        // ✅ DÉTECTION ET AFFICHAGE TASKLIST
        if (processedContent.some(b => b.type === 'text')) {
            const textBlock = processedContent.find(b => b.type === 'text');
            const jsonMatch = textBlock.text.match(/```json\s*([\s\S]*?)\s*```/i);
            
            if (jsonMatch && jsonMatch[1].includes('"task_analysis"')) {
                try {
                    let jsonText = jsonMatch[1].trim();
                    
                    // Nettoyer les sauts de ligne dans les strings
                    jsonText = jsonText.replace(/"([^"]*(?:\\"[^"]*)*)"/g, (match, content) => {
                        return '"' + content.replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ').trim() + '"';
                    });
                    
                    const parsed = JSON.parse(jsonText);
                    
                    if (parsed.task_analysis && parsed.tasks) {
                        // Intro avant le JSON
                        const introText = textBlock.text.substring(0, jsonMatch.index).trim();
                        if (introText) {
                            addMessage('assistant', introText);
                        }

                        // Afficher la tasklist
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message thinking';
                        messageDiv.innerHTML = `
                            <div class="message-content">
                                <div class="thinking-header">📋 Plan d'action</div>
                                <div class="thinking-content">
                                    <p><strong>Analyse :</strong> ${parsed.task_analysis}</p>
                                    <p><strong>Durée :</strong> ${parsed.estimated_duration || 'N/A'}</p>
                                    <h4>Étapes :</h4>
                                    <ul class="task-list">
                                        ${parsed.tasks.map((t, index) => `
                                            <li class="task-item">
                                                <label>
                                                    <input type="checkbox" id="task-${index}">
                                                    <span class="task-title">${t.title}</span>
                                                </label>
                                                <div class="task-description">${t.description}</div>
                                                ${t.tool_required ? `<div class="task-tool">🔧 ${t.tool_required}</div>` : ''}
                                            </li>
                                        `).join('')}
                                    </ul>
                                </div>
                            </div>
                        `;
                        appendToChatContainer(messageDiv);
                        
                        // Retirer le JSON du texte pour éviter double affichage
                        textBlock.text = textBlock.text.replace(/```json[\s\S]*?```/i, '').trim();
                    }
                } catch (e) {
                    console.error('❌ Erreur parsing tasklist:', e);
                }
            }
        }

        // Si l'arrêt a été demandé, retourner avec une raison spéciale
        if (shouldStop) {
            return {
                content: processedContent,
                stop_reason: 'user_cancelled'
            };
        }

        return {
            content: processedContent,
            stop_reason: stopReason || 'end_turn'
        };
    });
}

async function callOpenAI(messages, tools) {
    const openaiTools = tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema
        }
    }));

    const messagesWithSystem = [
        { role: 'system', content: config.systemPrompt },
        ...messages
    ];

    const basePayload = {
        model: config.openaiModel || 'gpt-4-turbo-preview',
        max_tokens: 4096,
        temperature: 0.1,
        top_p: 0.9,
        // top_k n'existe pas pour OpenAI, mais on le laisse pour que le fallback le retire
        messages: messagesWithSystem.map(m => {
            if (m.role === 'user' && Array.isArray(m.content)) {
                return {
                    role: 'user',
                    content: m.content.map(c => {
                        if (c.type === 'tool_result') {
                            return {
                                role: 'tool',
                                tool_call_id: c.tool_use_id,
                                content: c.content
                            };
                        }
                        return c;
                    }).filter(c => c.role !== 'tool')
                };
            }
            return {
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
            };
        }),
        tools: openaiTools.length > 0 ? openaiTools : undefined
    };

    const result = await callLLMWithFallback('openai', basePayload, async (payload) => {
        const response = await fetch('https://localhost:43098/api/openai', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`OpenAI API error (${response.status}): ${errorData.error?.message || 'Unknown error'}`);
        }

        const data = await response.json();
        const message = data.choices[0].message;

        const content = extractThinkingFromText(message.content || '');

        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                const args = toolCall.function.arguments;
                const input = typeof args === 'string' ? JSON.parse(args) : args;

                content.push({
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: input
                });
            }
        }

        return {
            content: content,
            stop_reason: data.choices[0].finish_reason
        };
    });

    return result;
}
async function callMistral(messages, tools) {
    const DEBUG = config.debug || false;
    
    if (DEBUG) {
        console.log('🎬 DÉBUT callMistral');
        console.log('📋 Messages:', messages.length);
        console.log('🔧 Tools:', tools.length);
    }
    
    const mistralTools = tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));

    const messagesWithSystem = [
        { role: 'system', content: config.systemPrompt },
        ...messages
    ];

    const basePayload = {
        model: config.mistralModel || 'mistral-large-latest',
        max_tokens: 4096,
        temperature: 0.1,
        top_p: 0.9,
        messages: messagesWithSystem.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        })),
        tools: mistralTools.length > 0 ? mistralTools : undefined,
        stream: true
    };
    
    if (DEBUG) console.log('📦 Payload:', basePayload.model, basePayload.stream);

    const result = await callLLMWithFallback('mistral', basePayload, async (payload) => {
        if (DEBUG) console.log('🌐 Envoi requête Mistral API...');
        
        const response = await fetch('https://localhost:43098/api/mistral', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(payload)
        });

        if (DEBUG) console.log('📡 Réponse:', response.status, response.headers.get('content-type'));

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Mistral API error (${response.status}): ${errorData.error?.message || 'Unknown error'}`);
        }

        // ✅ VARIABLES OPTIMISÉES
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const chatContainer = document.getElementById('chatContainer'); // Cache DOM

        let buffer = '';
        let accumulatedText = '';
        let currentTextDiv = null;
        let stopReason = null;
        const toolCalls = [];
        let isTasklistDetected = false;
        let hasThinkingTags = false;
        let rafId = null;
        let scrollTimeout = null;

        if (DEBUG) console.log('🔄 Début lecture stream SSE...');

        // ✅ FONCTIONS OPTIMISÉES
        
        // Scroll throttled
        function smoothScroll() {
            if (scrollTimeout) return;
            scrollTimeout = setTimeout(() => {
                chatContainer.scrollTop = chatContainer.scrollHeight;
                scrollTimeout = null;
            }, 100);
        }

        // Update UI avec requestAnimationFrame
        function updateTextDisplay(text) {
            if (rafId) cancelAnimationFrame(rafId);

            rafId = requestAnimationFrame(() => {
                if (currentTextDiv) {
                    // Stocker le texte brut et appliquer le markdown streaming
                    currentTextDiv.dataset.rawText = text;
                    currentTextDiv.innerHTML = parseMarkdownStreaming(text);
                    smoothScroll();
                }
                rafId = null;
            });
        }

        // Extraction thinking optimisée
        function extractThinkingContent(text) {
            const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
            let thinkingContent = '';
            let match;

            while ((match = thinkRegex.exec(text)) !== null) {
                thinkingContent += match[1];
            }

            const cleanedText = text.replace(thinkRegex, '').trim();

            return {
                thinking: thinkingContent.trim(),
                text: cleanedText,
                hasThinking: thinkingContent.trim().length > 0
            };
        }

        // Parser SSE
        function parseSSEEvent(eventText) {
            const lines = eventText.split('\n');
            const event = {};
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    event.data = line.slice(6);
                } else if (line.startsWith('event: ')) {
                    event.event = line.slice(7);
                } else if (line.startsWith('id: ')) {
                    event.id = line.slice(4);
                }
            }
            
            return event;
        }

        // ✅ BOUCLE PRINCIPALE OPTIMISÉE
        while (true) {
            // Vérifier si l'arrêt a été demandé
            if (shouldStop) {
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();

            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            for (const eventText of events) {
                if (!eventText.trim()) continue;

                const event = parseSSEEvent(eventText);
                
                if (!event.data || event.data === '[DONE]') {
                    if (DEBUG && event.data === '[DONE]') console.log('🏁 [DONE] reçu');
                    continue;
                }

                // ✅ PARSER JSON ROBUSTE
                let chunk;
                try {
                    chunk = JSON.parse(event.data);
                    if (!chunk?.choices?.[0]?.delta) continue;
                } catch (e) {
                    if (DEBUG) console.error('❌ Erreur parsing:', e.message);
                    continue;
                }

                const delta = chunk.choices[0].delta;

                // ✅ TEXTE
                if (delta.content !== undefined) {
                    let textChunk = '';
                    
                    if (typeof delta.content === 'string') {
                        textChunk = delta.content;
                    } else if (Array.isArray(delta.content)) {
                        textChunk = delta.content
                            .filter(c => c.type === 'text')
                            .map(c => c.text)
                            .join('');
                    }

                    if (textChunk) {
                        accumulatedText += textChunk;

                        // ✅ DÉTECTION RAPIDE TASKLIST
                        if (!isTasklistDetected) {
                            const firstChars = accumulatedText.substring(0, 100).toLowerCase();
                            if (firstChars.includes('```json') || 
                                (firstChars.includes('```') && firstChars.includes('json'))) {
                                isTasklistDetected = true;
                                if (DEBUG) console.log('🎯 TASKLIST DÉTECTÉE !');
                            }
                        }

                        if (isTasklistDetected) {
                            if (DEBUG) console.log('⏸️ Mode tasklist: pas d\'affichage');
                            continue;
                        }

                        // ✅ EXTRACTION CONDITIONNELLE (optimisation regex)
                        let extracted;
                        if (!hasThinkingTags) {
                            hasThinkingTags = accumulatedText.includes('<think>');
                        }
                        
                        if (hasThinkingTags) {
                            extracted = extractThinkingContent(accumulatedText);
                        } else {
                            extracted = { 
                                thinking: '', 
                                text: accumulatedText, 
                                hasThinking: false 
                            };
                        }

                        // ✅ CRÉER le div s'il n'existe pas
                        if (!currentTextDiv && extracted.text) {
                            if (DEBUG) console.log('🆕 Création div texte');
                            const messageDiv = document.createElement('div');
                            messageDiv.className = 'message assistant';
                            messageDiv.innerHTML = '<div class="message-content"><div id="streaming-mistral-text"></div></div>';
                            appendToChatContainer(messageDiv);
                            currentTextDiv = document.getElementById('streaming-mistral-text');
                        }

                        // ✅ UPDATE UI (batched avec RAF)
                        if (currentTextDiv && extracted.text) {
                            updateTextDisplay(extracted.text);
                            if (DEBUG) console.log('✅ Texte affiché');
                        }
                    }
                }

                // ✅ TOOL CALLS
                if (delta.tool_calls) {
                    if (DEBUG) console.log('🔧 Tool calls:', delta.tool_calls.length);
                    
                    for (const toolCall of delta.tool_calls) {
                        const idx = toolCall.index;
                        
                        if (idx !== undefined) {
                            if (!toolCalls[idx]) {
                                if (DEBUG) console.log(`🆕 Tool [${idx}]:`, toolCall.function?.name);

                                // Afficher l'outil utilisé
                                const toolMessage = document.createElement('div');
                                toolMessage.className = 'message tool';
                                toolMessage.innerHTML = `
                                    <div class="message-content">
                                        <strong>${toolCall.function?.name || 'unknown'}</strong>
                                    </div>
                                `;
                                appendToChatContainer(toolMessage);

                                toolCalls[idx] = {
                                    id: toolCall.id,
                                    type: 'function',
                                    function: {
                                        name: toolCall.function?.name || '',
                                        arguments: ''
                                    }
                                };
                            }
                            
                            if (toolCall.function?.arguments) {
                                toolCalls[idx].function.arguments += toolCall.function.arguments;
                                if (DEBUG) console.log(`📝 Args [${idx}]: ${toolCalls[idx].function.arguments.length} chars`);
                            }
                        }
                    }
                }

                // ✅ FINISH REASON
                if (chunk.choices?.[0]?.finish_reason) {
                    stopReason = chunk.choices[0].finish_reason;
                    if (DEBUG) console.log('🏁 Finish:', stopReason);
                }
            }
        }

        // ✅ NETTOYAGE RAF/TIMEOUT
        if (rafId) cancelAnimationFrame(rafId);
        if (scrollTimeout) clearTimeout(scrollTimeout);

        if (DEBUG) {
            console.log('🎬 FINALISATION');
            console.log('📊 État:', {
                accumulatedText: accumulatedText.length,
                isTasklist: isTasklistDetected,
                toolCalls: toolCalls.length,
                stopReason
            });
        }

        // ✅ FINALISATION TASKLIST
        if (isTasklistDetected && accumulatedText.includes('```json')) {
            if (DEBUG) console.log('📋 Traitement tasklist...');
            
            const jsonMatch = accumulatedText.match(/```json\s*([\s\S]*?)\s*```/i);
            
            if (jsonMatch) {
                try {
                    let jsonText = jsonMatch[1].trim();
                    
                    // Nettoyer les sauts de ligne dans les strings
                    jsonText = jsonText.replace(/"([^"]*(?:\\"[^"]*)*)"/g, (match, content) => {
                        return '"' + content.replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ').trim() + '"';
                    });
                    
                    const parsed = JSON.parse(jsonText);
                    if (DEBUG) console.log('✅ Tasklist parsée:', parsed.tasks?.length, 'tâches');
                    
                    if (parsed.task_analysis && parsed.tasks) {
                        // Intro
                        const introText = accumulatedText.substring(0, jsonMatch.index).trim();
                        if (introText) {
                            addMessage('assistant', introText);
                            if (DEBUG) console.log('✅ Intro affichée');
                        }

                        // Tasklist
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message thinking';
                        messageDiv.innerHTML = `
                            <div class="message-content">
                                <div class="thinking-header">📋 Plan d'action</div>
                                <div class="thinking-content">
                                    <p><strong>Analyse :</strong> ${parsed.task_analysis}</p>
                                    <p><strong>Durée :</strong> ${parsed.estimated_duration || 'N/A'}</p>
                                    <h4>Étapes :</h4>
                                    <ul class="task-list">
                            ${parsed.tasks.map((t, index) => `
                                        <li class="task-item">
                                            <label>
                                                <input type="checkbox" id="task-${index}">
                                                <span class="task-title">${t.title}</span>
                                            </label>
                                            <div class="task-description">${t.description}</div>
                            ${t.tool_required ? `<div class="task-tool">🔧 ${t.tool_required}</div>` : ''}
                                        </li>
                                    `).join('')}
                                    </ul>
                                </div>
                            </div>
                        `;
                        appendToChatContainer(messageDiv);
                        if (DEBUG) console.log('✅ Tasklist affichée');
                    }
                } catch (e) {
                    console.error('❌ Erreur tasklist:', e);
                }
            }
        }

        if (DEBUG) console.log('🎬 FINALISATION TEXTE');

        // ✅ EXTRACTION FINALE
        let extracted;
        if (hasThinkingTags) {
            extracted = extractThinkingContent(accumulatedText);
        } else {
            extracted = { 
                thinking: '', 
                text: accumulatedText.trim(), 
                hasThinking: false 
            };
        }
        // FINALISATION TEXTE
if (extracted.text && currentTextDiv) {
    if (DEBUG) console.log('📝 Finalisation texte...');
    
    // ✅ SI TASKLIST : supprimer le div créé par erreur
    if (isTasklistDetected) {
        if (DEBUG) console.log('🗑️ Suppression div (tasklist détectée)');
        currentTextDiv.closest('.message').remove();
    } else {
        // ✅ SINON : finaliser normalement
        // Utiliser le texte brut si disponible, sinon extracted.text
        const rawText = currentTextDiv.dataset.rawText || extracted.text;
        const deanonymizedText = await anonymizeText(rawText, 'deanonymize');
        currentTextDiv.innerHTML = parseMarkdown(deanonymizedText);
        delete currentTextDiv.dataset.rawText;
        currentTextDiv.removeAttribute('id');
        if (DEBUG) console.log('✅ Texte finalisé');
    }
}

        // ✅ CONSTRUCTION CONTENT
        const content = [];

        if (extracted.hasThinking) {
            content.push({
                type: 'thinking',
                thinking: extracted.thinking
            });
        }

        if (extracted.text) {
            content.push({
                type: 'text',
                text: extracted.text
            });
        }

        for (const toolCall of toolCalls) {
            if (toolCall?.function) {
                try {
                    content.push({
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: JSON.parse(toolCall.function.arguments)
                    });
                    if (DEBUG) console.log('✅ Tool use ajouté:', toolCall.function.name);
                } catch (e) {
                    console.error('❌ Tool args invalides:', e);
                }
            }
        }

        if (DEBUG) {
            console.log('🎯 Content final:', content.length, 'blocs');
            console.log('   - Thinking:', extracted.hasThinking ? 'OUI' : 'NON');
            console.log('   - Text:', extracted.text ? 'OUI' : 'NON');
            console.log('   - Tools:', toolCalls.length);
        }

        // Si l'arrêt a été demandé, retourner avec une raison spéciale
        if (shouldStop) {
            return {
                content: content,
                stop_reason: 'user_cancelled'
            };
        }

        return {
            content: content,
            stop_reason: stopReason || 'stop'
        };
    });

    if (DEBUG) console.log('🏁 FIN callMistral');
    return result;
}
async function callOllama(messages, tools) {
    const ollamaTools = tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
        }
    }));

    const messagesWithSystem = [
        { role: 'system', content: config.systemPrompt },
        ...messages
    ];

    const basePayload = {
        model: config.modelName || 'llama2',
        messages: messagesWithSystem.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        })),
        stream: false,
        options: {
            temperature: 0.1,
            top_p: 0.9,
            top_k: 40,
            num_predict: 4096
        },
        tools: ollamaTools.length > 0 ? ollamaTools : undefined
    };

    const result = await callLLMWithFallback('ollama', basePayload, async (payload) => {
        const response = await fetch('https://localhost:43098/api/ollama', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ollamaUrl: config.ollamaUrl,
                payload: payload
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Ollama error (${response.status}): ${errorData.error || 'Vérifiez que Ollama est lancé'}`);
        }

        const data = await response.json();
        const message = data.message;

        if (!message) {
            console.error('[callOllama] ❌ data.message est undefined. data brute:', JSON.stringify(data).substring(0, 500));
            throw new Error('Ollama a retourné une réponse sans champ "message"');
        }

        const content = extractThinkingFromText(message.content || '');

        if (message.tool_calls) {
            for (const toolCall of message.tool_calls) {
                const args = toolCall.function.arguments;
                const input = typeof args === 'string' ? JSON.parse(args) : args;

                content.push({
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function.name,
                    input: input
                });
            }
        }

        return {
            content: content,
            stop_reason: 'end_turn'
        };
    });

    return result;
}
// Détecter la sélection dans Word
async function updateSelection() {
    try {
        await Word.run(async (context) => {
            const selection = context.document.getSelection();
            selection.load('text');
            await context.sync();

            const selectedText = selection.text.trim();
            currentSelection.text = selectedText;
            currentSelection.lineCount = selectedText.length;

            console.log("lines",currentSelection.lineCount);
            updateSelectionIndicator();
        });
    } catch (error) {
        // Silencieux si erreur (peut arriver si pas de document ouvert)
        currentSelection.text = '';
        currentSelection.lineCount = 0;
        currentSelection.range = null;
    }
}

// Mettre à jour l'indicateur de sélection
function updateSelectionIndicator() {
    let indicator = document.getElementById('selectionIndicator');

    if (!indicator) {
        // Créer l'indicateur en bas du chatContainer, juste avant inputArea
        indicator = document.createElement('div');
        indicator.id = 'selectionIndicator';

        // ✅ Insérer dans le body, juste avant inputArea
        const inputArea = document.getElementById('inputArea');
        document.body.insertBefore(indicator, inputArea);
    }

    if (currentSelection.lineCount > 0) {
        const ligneText = currentSelection.lineCount === 1 ? 'Caractère sélectionné' : 'Caractères sélectionnés';
        indicator.textContent = `📝 ${currentSelection.lineCount} ${ligneText}`;
        indicator.style.display = 'block';
    } else {
        indicator.style.display = 'none';
    }
}

// Envoi de message
async function sendMessage() {
    // Si on est sur un onglet CLI, le terminal xterm gère directement l'input
    const currentTab = chatTabs.find(t => t.id === activeTabId);
    if (currentTab && currentTab.type === 'claude-cli') {
        showCliTerminal();
        return;
    }

    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!message) return;
    if (!config.apiKey && config.llmProvider !== 'ollama') {
        addMessage('error', 'Veuillez configurer votre clé API dans les paramètres.');
        return;
    }

    input.value = '';

    // Changer le bouton en mode stop
    setSendButtonToStop();

    // Construire le message avec la sélection si disponible
    let fullMessage = message;
    console.log('🔍 currentSelection:', currentSelection);
console.log('📝 currentSelection.text:', currentSelection.text);

    if (currentSelection.text) {
        const normalizedSelection = currentSelection.text.replace(/\r/g, '\n');
        fullMessage = `${message}\n\n[Quote from my text]:\n"""\n${normalizedSelection}\n"""`;

        // Réinitialiser la sélection après utilisation
        currentSelection.text = '';
        currentSelection.lineCount = 0;
        currentSelection.range = null;
        updateSelectionIndicator();
    }

    // Anonymiser le message si l'anonymisation est activée
    const anonymizedMessage = await anonymizeText(fullMessage, 'anonymize');

    // Afficher le message utilisateur (sans la sélection visible pour l'utilisateur)
    addMessage('user', message);
    console.log(anonymizedMessage);

    // Ajouter à l'historique
    config.conversationHistory.push({
        role: 'user',
        content: anonymizedMessage
    });

    showTyping();

    try {
        let continueLoop = true;
        let maxIterations = 10; // Limite de sécurité
        let iterations = 0;

        while (continueLoop && iterations < maxIterations && !shouldStop) {
    iterations++;

    // Vérifier si l'arrêt a été demandé
    if (shouldStop) {
        hideTyping();
        addMessage('system', '⏹️ Traitement arrêté par l\'utilisateur.');
        setSendButtonToSend();
        return;
    }

    const response = await callLLM(config.conversationHistory);

    // Vérifier si l'arrêt a été demandé pendant le streaming
    if (shouldStop) {
        hideTyping();
        setSendButtonToSend();
        return;
    }

    let hasToolUse = false;
    let textResponse = '';
    const toolResults = [];
    
    // Détecter tasklist JSON
    const jsonMatch = response.content.find(b => b.type === 'text')?.text?.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1].includes('"tasks"')) {
        try {
            const tasklist = JSON.parse(jsonMatch[1].trim());
            
            // Afficher intro si présente
            const introText = response.content.find(b => b.type === 'text')?.text?.split('```')[0].trim();
            if (introText) addMessage('assistant', introText);
            
            // Demander approbation
            const approval = await requestTasklistApproval(tasklist);
            
            if (approval.action === 'deny') {
                hideTyping();
                addMessage('system', '❌ Tasklist refusée. Conversation arrêtée.');
                setSendButtonToSend();
                return;
            }
            
            // Modifier le prompt pour exécution
            const originalPrompt = config.systemPrompt;
            config.systemPrompt = `${originalPrompt}\n\n✅ TASKLIST VALIDÉE. Exécute les étapes:\n${JSON.stringify(approval.tasklist.tasks, null, 2)}`;
            
            config.conversationHistory.push({
                role: 'assistant',
                content: response.content.filter(b => b.type !== 'thinking')
            });
            config.conversationHistory.push({
                role: 'user',
                content: 'Tasklist validée. Exécute maintenant.'
            });
            
            // Réinitialiser le prompt après
            setTimeout(() => { config.systemPrompt = originalPrompt; }, 100);
            
            continue;
        } catch (e) {}
    }
    
    // Traitement normal (thinking, texte, outils)
    for (const block of response.content) {
        if (block.type === 'thinking') {
            addMessage('thinking', block.thinking);
        } else if (block.type === 'text') {
            textResponse += block.text;
        } else if (block.type === 'tool_use') {
            hasToolUse = true;
            // Ne pas afficher les appels d'outils dans le chat
            // addMessage('tool', `**${block.name}**`);

            const result = await executeTool(block.name, block.input);

            // Normaliser le résultat pour qu'il soit compatible avec l'API Claude
            let normalizedContent;
            if (typeof result === 'string') {
                normalizedContent = result;
            } else if (Array.isArray(result.content)) {
                // Résultat MCP avec content blocks - normaliser les types
                normalizedContent = result.content.map(block => {
                    if (block.type === 'text' || block.type === 'image' || block.type === 'document') {
                        return block;
                    } else if (block.type === 'resource') {
                        // Convertir resource en text
                        return {
                            type: 'text',
                            text: block.resource?.text || JSON.stringify(block.resource, null, 2)
                        };
                    } else {
                        // Autres types non supportés - convertir en text
                        return {
                            type: 'text',
                            text: JSON.stringify(block, null, 2)
                        };
                    }
                });
            } else if (result.content) {
                normalizedContent = result.content;
            } else {
                normalizedContent = JSON.stringify(result, null, 2);
            }

            toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: normalizedContent
            });
        }
    }
    
    if (hasToolUse) {
        config.conversationHistory.push({
            role: 'assistant',
            content: response.content.filter(b => b.type !== 'thinking')
        });
        config.conversationHistory.push({
            role: 'user',
            content: toolResults
        });
    } else {
        if (textResponse.trim()) {
            addMessage('assistant', textResponse);
            config.conversationHistory.push({
                role: 'assistant',
                content: textResponse
            });
        }
        hideTyping();
        continueLoop = false;
    }
}

        if (iterations >= maxIterations) {
            hideTyping();
            addMessage('error', 'Nombre maximal d\'itérations atteint.');
        }

        // Restaurer le bouton en mode send
        setSendButtonToSend();
    } catch (error) {
        hideTyping();
        console.error('Erreur complète:', error);
        addMessage('error', `Erreur: ${error.message}`);

        // Restaurer le bouton en mode send
        setSendButtonToSend();
    }
}

// Parser le markdown pour le streaming (version simplifiée - traitement basique uniquement)
function parseMarkdownStreaming(text) {
    if (!text) return '';

    // Échapper le HTML
    const escapeHtml = (unsafe) => {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    };

    // Échapper tout le texte d'abord
    text = escapeHtml(text);

    // Appliquer les transformations markdown simples (sans code qui nécessite des placeholders)
    // Gras et italique combinés
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

    // Gras
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italique
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');

    // Texte barré
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Sauts de ligne
    text = text.replace(/\n\n/g, '</p><p>');
    text = text.replace(/\n/g, '<br>');

    // Envelopper dans des paragraphes
    if (!text.startsWith('<')) {
        text = '<p>' + text + '</p>';
    }

    return text;
}

// Parser le markdown en HTML
function parseMarkdown(text) {
    if (!text) return '';

    // Échapper le HTML pour éviter les injections
    const escapeHtml = (unsafe) => {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    };

    // Protéger les code blocks et inline code avant traitement
    const codeBlocks = [];
    const inlineCodes = [];
    const tables = [];

    // Extraire et protéger les tableaux AVANT les code blocks pour éviter les conflits
    text = text.replace(/(\|.+\|[\r\n]+\|[\s\-:|]+\|[\r\n]+(?:\|.+\|[\r\n]*)+)/gm, (match) => {
        const placeholder = `\x00TABLE_${tables.length}\x00`;
        const lines = match.trim().split(/[\r\n]+/);

        if (lines.length < 3) {
            tables.push(match);
            return placeholder;
        }

        const headerLine = lines[0];
        const bodyLines = lines.slice(2);

        // Parser l'en-tête
        const headers = headerLine.split('|')
            .map(h => h.trim())
            .filter(h => h.length > 0);

        // Parser les lignes du corps
        const rows = bodyLines.map(line => {
            return line.split('|')
                .map(cell => cell.trim())
                .filter(cell => cell.length > 0);
        });

        // Construire le HTML
        let tableHtml = '<table style="border-collapse: collapse; width: 100%; margin: 12px 0;">';

        // En-tête
        tableHtml += '<thead><tr>';
        headers.forEach(header => {
            tableHtml += `<th style="border: 1px solid #3e3e42; padding: 8px; background: #2d2d30; text-align: left;">${escapeHtml(header)}</th>`;
        });
        tableHtml += '</tr></thead>';

        // Corps
        tableHtml += '<tbody>';
        rows.forEach(row => {
            tableHtml += '<tr>';
            row.forEach(cell => {
                tableHtml += `<td style="border: 1px solid #3e3e42; padding: 8px;">${escapeHtml(cell)}</td>`;
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';

        tables.push(tableHtml);
        return placeholder;
    });

    // Extraire et protéger les code blocks (```...```)
    text = text.replace(/```(\w+)?[\r\n]([\s\S]*?)```/g, (match, lang, code) => {
        const placeholder = `\x00CODEBLOCK_${codeBlocks.length}\x00`;
        codeBlocks.push(`<pre><code class="language-${lang || ''}">${escapeHtml(code.trim())}</code></pre>`);
        return placeholder;
    });

    // Extraire et protéger les inline codes avec triple backticks (```...```)
    text = text.replace(/```([^`]+)```/g, (match, code) => {
        const placeholder = `\x00INLINECODE_${inlineCodes.length}\x00`;
        inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
        return placeholder;
    });

    // Extraire et protéger les inline codes (`...`)
    text = text.replace(/`([^`]+)`/g, (match, code) => {
        const placeholder = `\x00INLINECODE_${inlineCodes.length}\x00`;
        inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
        return placeholder;
    });

    // Échapper le HTML restant
    text = escapeHtml(text);

    // Lignes horizontales (--- ou ***) - AVANT les listes pour éviter les conflits
    text = text.replace(/^(\-{3,}|\*{3,}|_{3,})$/gm, '<hr>');

    // Titres (# jusqu'à ######) - traiter du plus spécifique au plus général
    text = text.replace(/^#{6}\s+(.+)$/gm, '<h6>$1</h6>');
    text = text.replace(/^#{5}\s+(.+)$/gm, '<h5>$1</h5>');
    text = text.replace(/^#{4}\s+(.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^#{3}\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^#{2}\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#{1}\s+(.+)$/gm, '<h1>$1</h1>');

    // Gras et italique combinés (***...***)
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');

    // Gras (**...** ou __...__)
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italique (*...* ou _..._)
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');

    // Texte barré (~~...~~)
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Liens [texte](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Citations (> texte) - gérer les citations multilignes
    text = text.replace(/^&gt;\s+(.+)$/gm, (match, content) => {
        return `<blockquote>${content}</blockquote>`;
    });
    // Fusionner les blockquotes consécutifs
    text = text.replace(/(<\/blockquote>[\r\n]*<blockquote>)/g, '<br>');

    // Listes non ordonnées (- ou * ou +) - marquer temporairement
    text = text.replace(/^[\-\*\+]\s+(.+)$/gm, '___UL_ITEM___$1___UL_ITEM_END___');

    // Listes ordonnées (1. 2. etc.) - marquer temporairement
    text = text.replace(/^\d+\.\s+(.+)$/gm, '___OL_ITEM___$1___OL_ITEM_END___');

    // Wrapper les listes non ordonnées
    text = text.replace(/(___UL_ITEM___[\s\S]+?___UL_ITEM_END___[\r\n]*)+/g, (match) => {
        const items = match.replace(/___UL_ITEM___/g, '<li>').replace(/___UL_ITEM_END___/g, '</li>');
        return '<ul>' + items + '</ul>';
    });

    // Wrapper les listes ordonnées
    text = text.replace(/(___OL_ITEM___[\s\S]+?___OL_ITEM_END___[\r\n]*)+/g, (match) => {
        const items = match.replace(/___OL_ITEM___/g, '<li>').replace(/___OL_ITEM_END___/g, '</li>');
        return '<ol>' + items + '</ol>';
    });

    // Restaurer les tableaux
    tables.forEach((table, index) => {
        text = text.replace(`\x00TABLE_${index}\x00`, table);
    });

    // Restaurer les code blocks
    codeBlocks.forEach((code, index) => {
        text = text.replace(`\x00CODEBLOCK_${index}\x00`, code);
    });

    // Restaurer les inline codes
    inlineCodes.forEach((code, index) => {
        text = text.replace(`\x00INLINECODE_${index}\x00`, code);
    });

    // Sauts de ligne (double retour = nouveau paragraphe, simple = <br>)
    text = text.replace(/\n\n/g, '</p><p>');
    text = text.replace(/\n/g, '<br>');

    // Envelopper dans des paragraphes si nécessaire
    if (!text.startsWith('<')) {
        text = '<p>' + text + '</p>';
    }

    return text;
}

// Fonction pour afficher les messages dans le chat
function addMessage(type, content, options = {}) {
    console.log("contenu initial message", content);
    const container = document.getElementById('chatContainer');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;

    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';

    // Si content est un string, traiter le markdown
    if (typeof content === 'string') {
        // Gérer le markdown complet (sauf pour thinking qui est déjà du texte brut)
        if (type !== 'thinking') {
            content = parseMarkdown(content);
            console.log("contenu post replace message", content);
        } else {
            // Pour thinking, on échappe juste le HTML
            content = content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            // Ajouter un préfixe pour indiquer que c'est une réflexion
            content = `<div class="thinking-header">💭 Réflexion de l'IA</div><div class="thinking-content">${content}</div>`;
            console.log("contenu post replace message", content);
        }
        contentDiv.innerHTML = content;
    }

    messageDiv.appendChild(contentDiv);

    // Ajouter des boutons si fournis
    if (options.buttons && Array.isArray(options.buttons)) {
        const buttonsContainer = document.createElement('div');
        buttonsContainer.className = 'message-buttons';
        buttonsContainer.style.cssText = 'display: flex; gap: 10px; margin-top: 12px;';

        options.buttons.forEach(btn => {
            const button = document.createElement('button');
            button.textContent = btn.text;
            button.style.cssText = 'padding: 10px 20px; background: linear-gradient(135deg, #00d4ff, #0099ff); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; transition: transform 0.2s;';
            button.onmouseover = () => button.style.transform = 'translateY(-2px)';
            button.onmouseout = () => button.style.transform = 'translateY(0)';
            button.onclick = () => {
                // Désactiver les boutons après click
                buttonsContainer.querySelectorAll('button').forEach(b => b.disabled = true);
                // Appeler la fonction correspondante
                if (btn.action === 'anonymizeWithOllama') {
                    analyzeWithOllama();
                }
            };
            buttonsContainer.appendChild(button);
        });

        messageDiv.appendChild(buttonsContainer);
    }

    appendToChatContainer(messageDiv);
}

// Demande d'approbation
function requestApproval(title, details) {
    return new Promise((resolve) => {
        const approvalDiv = document.createElement('div');
        approvalDiv.className = 'approval-request';
        approvalDiv.innerHTML = `
            <strong>${title}</strong>
            <pre>${details}</pre>
            <div class="approval-buttons">
                <button class="approve">✓ Autoriser</button>
                <button class="deny">✗ Refuser</button>
            </div>
        `;

        appendToChatContainer(approvalDiv);

        approvalDiv.querySelector('.approve').onclick = () => {
            approvalDiv.remove();
            resolve(true);
        };
        
        approvalDiv.querySelector('.deny').onclick = () => {
            approvalDiv.remove();
            resolve(false);
        };
    });
}
// Demande d'approbation de tasklist avec édition
function requestTasklistApproval(tasklist) {
    console.log("request task approval");
    return new Promise((resolve) => {
        const approvalDiv = document.createElement('div');
        approvalDiv.className = 'approval-request';
        approvalDiv.innerHTML = `
            <strong>📋 Plan d'action proposé</strong>
            <textarea id="tasklistEditor" style="width:100%;height:200px;font-size:12px;margin:8px 0">${JSON.stringify(tasklist, null, 2)}</textarea>
            <div class="approval-buttons">
                <button class="approve">✓ Valider</button>
                <button class="edit">✏️ Modifier et valider</button>
                <button class="deny">✗ Refuser</button>
            </div>
        `;

        appendToChatContainer(approvalDiv);

        approvalDiv.querySelector('.approve').onclick = () => {
            approvalDiv.remove();
            resolve({ action: 'approve', tasklist });
        };
        
        approvalDiv.querySelector('.edit').onclick = () => {
            try {
                const edited = JSON.parse(document.getElementById('tasklistEditor').value);
                approvalDiv.remove();
                resolve({ action: 'approve', tasklist: edited });
            } catch (e) {
                alert('JSON invalide');
            }
        };
        
        approvalDiv.querySelector('.deny').onclick = () => {
            approvalDiv.remove();
            resolve({ action: 'deny' });
        };
    });
}
// Fonction helper pour ajouter un élément au chat en respectant l'ordre
// L'indicateur de typing doit toujours rester en dernier
function appendToChatContainer(element) {
    const container = document.getElementById('chatContainer');
    const typingIndicator = document.getElementById('typingIndicator');

    if (typingIndicator) {
        // Insérer AVANT l'indicateur de typing
        container.insertBefore(element, typingIndicator);
    } else {
        // Pas d'indicateur, ajouter normalement
        container.appendChild(element);
    }

    // Ne PAS forcer le scroll si on est sur l'onglet CLI
    // (xterm gère son propre scroll et ne doit pas être perturbé)
    const currentTab = chatTabs.find(t => t.id === activeTabId);
    if (!currentTab || currentTab.type !== 'claude-cli2') {
        container.scrollTop = container.scrollHeight;
    }
}

function showTyping() {
    // Ne créer qu'un seul indicateur
    if (document.getElementById('typingIndicator')) {
        return; // Déjà affiché
    }

    const container = document.getElementById('chatContainer');
    const typingDiv = document.createElement('div');
    typingDiv.id = 'typingIndicator';
    typingDiv.className = 'message assistant';

    const indicatorDiv = document.createElement('div');
    indicatorDiv.className = 'message-content typing-indicator';
    indicatorDiv.innerHTML = '<span></span><span></span><span></span>';
    typingDiv.appendChild(indicatorDiv);

    container.appendChild(typingDiv);

    // Ne PAS forcer le scroll si on est sur l'onglet CLI
    const currentTab = chatTabs.find(t => t.id === activeTabId);
    if (!currentTab || currentTab.type !== 'claude-cli2') {
        container.scrollTop = container.scrollHeight;
    }
}

function hideTyping() {
    const typing = document.getElementById('typingIndicator');
    if (typing) typing.remove();
}

function closeSettings() {
    document.getElementById('modal').classList.remove('show');
}

function updateProviderFields() {
    const provider = document.getElementById('llmProvider').value;
    const ollamaGroup = document.getElementById('ollamaUrlGroup');
    const modelGroup = document.getElementById('modelNameGroup');
    const claudeGroup = document.getElementById('claudeModelGroup');
    const openaiGroup = document.getElementById('openaiModelGroup');
    const mistralGroup = document.getElementById('mistralModelGroup');

    // Masquer tous les groupes de modèles
    claudeGroup.style.display = 'none';
    openaiGroup.style.display = 'none';
    mistralGroup.style.display = 'none';
    ollamaGroup.style.display = 'none';
    modelGroup.style.display = 'none';

    // Afficher le groupe correspondant au provider sélectionné
    if (provider === 'claude') {
        claudeGroup.style.display = 'block';
    } else if (provider === 'openai') {
        openaiGroup.style.display = 'block';
    } else if (provider === 'mistral') {
        mistralGroup.style.display = 'block';
    } else if (provider === 'ollama') {
        ollamaGroup.style.display = 'block';
        modelGroup.style.display = 'block';
        // Charger automatiquement les modèles disponibles
        loadOllamaModels();
    }
}

// Charger les modèles Ollama disponibles
async function loadOllamaModels() {
    const modelSelect = document.getElementById('modelName');
    const ollamaUrl = document.getElementById('ollamaUrl').value;
    const refreshBtn = document.getElementById('refreshModels');

    // Désactiver le bouton pendant le chargement
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ Chargement...';
    }

    try {
        const response = await fetch(`https://localhost:43098/api/ollama/models?url=${encodeURIComponent(ollamaUrl)}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('Impossible de récupérer les modèles Ollama');
        }

        const data = await response.json();

        // Vider et remplir le sélecteur
        modelSelect.innerHTML = '<option value="">Sélectionner un modèle...</option>';

        if (data.models && data.models.length > 0) {
            data.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.name;
                option.textContent = `${model.name} (${(model.size / 1024 / 1024 / 1024).toFixed(1)} GB)`;
                modelSelect.appendChild(option);
            });

            // Sélectionner le modèle actuellement configuré s'il existe
            if (config.modelName && data.models.some(m => m.name === config.modelName)) {
                modelSelect.value = config.modelName;
            }

            console.log(`✅ ${data.models.length} modèle(s) Ollama trouvé(s)`);
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Aucun modèle installé';
            modelSelect.appendChild(option);
            console.log('⚠️ Aucun modèle Ollama trouvé');
        }
    } catch (error) {
        console.error('Erreur chargement modèles Ollama:', error);
        modelSelect.innerHTML = '<option value="">Erreur - Ollama non disponible</option>';
    } finally {
        // Réactiver le bouton
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 Rafraîchir';
        }
    }
}

// Valider un modèle en envoyant une requête de test
async function validateModel(provider) {
    const statusId = `${provider}ModelStatus`;
    const modelInputId = `${provider}Model`;
    const buttonId = `validate${provider === 'openai' ? 'OpenAI' : provider.charAt(0).toUpperCase() + provider.slice(1)}Model`;

    const statusElement = document.getElementById(statusId);
    const modelInput = document.getElementById(modelInputId);
    const button = document.getElementById(buttonId);
    const apiKey = document.getElementById('apiKey').value;

    const modelName = modelInput.value.trim();

    if (!modelName) {
        statusElement.style.color = '#f48771';
        statusElement.textContent = '⚠️ Veuillez saisir un nom de modèle';
        return;
    }

    if (!apiKey && provider !== 'ollama') {
        statusElement.style.color = '#f48771';
        statusElement.textContent = '⚠️ Veuillez saisir votre clé API d\'abord';
        return;
    }

    // Désactiver le bouton pendant la validation
    button.disabled = true;
    button.textContent = '⏳';
    statusElement.style.color = '#9cdcfe';
    statusElement.textContent = '🔄 Validation en cours...';

    try {
        let response;

        // Construire la requête selon le provider
        if (provider === 'claude') {
            response = await fetch('https://localhost:43098/api/claude', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey
                },
                body: JSON.stringify({
                    model: modelName,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Test' }]
                })
            });
        } else if (provider === 'openai') {
            response = await fetch('https://localhost:43098/api/openai', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Test' }]
                })
            });
        } else if (provider === 'mistral') {
            response = await fetch('https://localhost:43098/api/mistral', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelName,
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'Test' }]
                })
            });
        }

        if (response.ok) {
            statusElement.style.color = '#4ec9b0';
            statusElement.textContent = '✅ Modèle validé avec succès';
            console.log(`✅ Modèle ${provider} "${modelName}" validé`);
        } else {
            const errorData = await response.json().catch(() => ({}));
            statusElement.style.color = '#f48771';
            statusElement.textContent = `❌ Erreur: ${errorData.error || response.statusText}`;
            console.error(`❌ Validation ${provider} échouée:`, errorData);
        }
    } catch (error) {
        statusElement.style.color = '#f48771';
        statusElement.textContent = `❌ Erreur: ${error.message}`;
        console.error(`❌ Erreur validation ${provider}:`, error);
    } finally {
        button.disabled = false;
        button.textContent = '✓ Valider';
    }
}

function saveSettings() {
    config.llmProvider = document.getElementById('llmProvider').value;
    config.apiKey = document.getElementById('apiKey').value;
    config.ollamaUrl = document.getElementById('ollamaUrl').value;
    config.modelName = document.getElementById('modelName').value;
    config.claudeModel = document.getElementById('claudeModel').value;
    config.openaiModel = document.getElementById('openaiModel').value;
    config.mistralModel = document.getElementById('mistralModel').value;
    config.autoApprove = document.getElementById('autoApprove').checked;

    localStorage.setItem('mcpProxyConfig', JSON.stringify(config));

    // Mettre à jour l'onglet actif avec le nouveau LLM
    if (activeTabId !== null) {
        const activeTab = chatTabs.find(t => t.id === activeTabId);
        if (activeTab) {
            activeTab.llmProvider = config.llmProvider;
            activeTab.llmModel = getLLMModel();
            renderChatTabs();
        }
    }

    closeSettings();
    console.log('system', 'Paramètres enregistrés avec succès.');
}

function loadSettings() {
    const saved = localStorage.getItem('mcpProxyConfig');
    if (saved) {
        try {
            const loaded = JSON.parse(saved);
            Object.assign(config, loaded);

            document.getElementById('llmProvider').value = config.llmProvider;
            document.getElementById('apiKey').value = config.apiKey || '';
            document.getElementById('ollamaUrl').value = config.ollamaUrl;
            document.getElementById('modelName').value = config.modelName || '';
            document.getElementById('claudeModel').value = config.claudeModel || 'claude-haiku-4-5-20251001';
            document.getElementById('openaiModel').value = config.openaiModel || 'gpt-4-turbo-preview';
            document.getElementById('mistralModel').value = config.mistralModel || 'mistral-large-latest';
            document.getElementById('autoApprove').checked = config.autoApprove;

            updateProviderFields();
        } catch (error) {
            console.error('Erreur chargement paramètres:', error);
        }
    }
}

function handleKeyPress(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}
// Afficher la barre de progression
function showProgress(title, status = '') {
    const container = document.getElementById('chatContainer');
    const progressDiv = document.createElement('div');
    progressDiv.id = 'anonymizationProgress';
    progressDiv.className = 'progress-container';
    progressDiv.innerHTML = `
        <div class="progress-header">
            <span class="progress-title">${title}</span>
            <span class="progress-percentage">0%</span>
        </div>
        <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: 0%"></div>
        </div>
        <div class="progress-status">${status}</div>
    `;
    container.appendChild(progressDiv);

    // Ne PAS forcer le scroll si on est sur l'onglet CLI
    const currentTab = chatTabs.find(t => t.id === activeTabId);
    if (!currentTab || currentTab.type !== 'claude-cli') {
        container.scrollTop = container.scrollHeight;
    }

    return progressDiv;
}

// Mettre à jour la progression
function updateProgress(percentage, status = '') {
    const progressDiv = document.getElementById('anonymizationProgress');
    if (!progressDiv) return;

    const percentageEl = progressDiv.querySelector('.progress-percentage');
    const fillEl = progressDiv.querySelector('.progress-bar-fill');
    const statusEl = progressDiv.querySelector('.progress-status');

    if (percentageEl) percentageEl.textContent = `${Math.round(percentage)}%`;
    if (fillEl) fillEl.style.width = `${percentage}%`;
    if (statusEl && status) statusEl.textContent = status;
}

// Supprimer la barre de progression
function hideProgress() {
    const progressDiv = document.getElementById('anonymizationProgress');
    if (progressDiv) {
        setTimeout(() => progressDiv.remove(), 500);
    }
}

// Charger automatiquement les fichiers d'anonymisation au démarrage
async function loadAnonymizationFiles() {
    // Attendre que l'ID soit récupéré/créé
    const documentId = await getDocumentId();
    
    console.log('🔍 [LOAD_FILES] ═══════════════════════════════');
    console.log('📋 [LOAD_FILES] DocumentId récupéré:', documentId);
    
    if (!documentId) {
        console.error('❌ [LOAD_FILES] Impossible de récupérer l\'ID du document');
        return;
    }
    
    // Stocker l'ID globalement
    anonymization.documentId = documentId;
    console.log('✅ [LOAD_FILES] DocumentId stocké dans anonymization.documentId');
    
    console.log(`🔍 [LOAD_FILES] Recherche des fichiers pour: ${documentId}`);

    try {
        const url = `https://localhost:43098/api/anonymize/files/${documentId}`;
        console.log('📤 [LOAD_FILES] URL fetch:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        console.log('📡 [LOAD_FILES] Status HTTP:', response.status);
        console.log('📡 [LOAD_FILES] Headers:', Object.fromEntries(response.headers.entries()));

        // Si aucun fichier trouvé, ne rien faire
        if (!response.ok) {
            const errorText = await response.text();
            console.log(`ℹ️ [LOAD_FILES] Aucun fichier trouvé (${response.status})`);
            console.log('📄 [LOAD_FILES] Réponse:', errorText);
            return;
        }

        const responseText = await response.text();
        console.log('📥 [LOAD_FILES] Réponse brute (200 premiers car):', responseText.substring(0, 200));
        
        let result;
        try {
            result = JSON.parse(responseText);
            console.log('✅ [LOAD_FILES] JSON parsé avec succès');
        } catch (parseError) {
            console.error('💥 [LOAD_FILES] Erreur parsing JSON:', parseError);
            console.error('💥 [LOAD_FILES] Réponse complète:', responseText);
            return;
        }

        console.log('📦 [LOAD_FILES] Structure résultat:', {
            found: result.found,
            has_mapping: !!result.mapping,
            has_reverse_mapping: !!result.reverse_mapping,
            has_compilation: !!result.compilation_documents,
            compilation_count: result.compilation_documents?.length
        });

        if (result.found) {
            // Charger le mapping
            if (result.mapping && result.reverse_mapping) {
                console.log('🗂️ [LOAD_FILES] Analyse du mapping:');
                console.log('  → Type mapping:', typeof result.mapping);
                console.log('  → Clés mapping:', Object.keys(result.mapping));
                
                // Déterminer le format
                const firstKey = Object.keys(result.mapping)[0];
                const isHierarchical = ['personnes_physiques', 'societes', 'adresses', 'siren'].includes(firstKey);
                console.log('  → Format:', isHierarchical ? 'HIÉRARCHIQUE' : 'PLAT');
                
                if (isHierarchical) {
                    const counts = {
                        personnes_physiques: Object.keys(result.mapping.personnes_physiques || {}).length,
                        societes: Object.keys(result.mapping.societes || {}).length,
                        adresses: Object.keys(result.mapping.adresses || {}).length,
                        siren: Object.keys(result.mapping.siren || {}).length
                    };
                    console.log('  → Compteurs:', counts);
                    
                    const totalEntities = counts.personnes_physiques + counts.societes + counts.adresses + counts.siren;
                    console.log('  → Total entités:', totalEntities);
                } else {
                    console.log('  → Nombre d\'entrées (plat):', Object.keys(result.mapping).length);
                }
                
                console.log('🔄 [LOAD_FILES] Analyse reverse_mapping:');
                console.log('  → Type:', typeof result.reverse_mapping);
                console.log('  → Nombre d\'entrées:', Object.keys(result.reverse_mapping).length);
                console.log('  → Premières clés (3):', Object.keys(result.reverse_mapping).slice(0, 3));
                
                anonymization.mapping = result.mapping;
                anonymization.reverse_mapping = result.reverse_mapping;
                anonymization.enabled = true;
                
                console.log('✅ [LOAD_FILES] Mapping stocké:');
                console.log('  → anonymization.enabled:', anonymization.enabled);
                console.log('  → anonymization.mapping existe:', !!anonymization.mapping);
                console.log('  → anonymization.reverse_mapping existe:', !!anonymization.reverse_mapping);
                console.log('  → anonymization.documentId:', anonymization.documentId);

                updateFilesDisplay();
            } else {
                console.log('⚠️ [LOAD_FILES] Mapping incomplet dans la réponse');
            }

            // Charger les informations du dossier si disponibles
            if (result.informations_dossier) {
                anonymization.dossierInfo = result.informations_dossier;
                console.log('📋 [LOAD_FILES] Informations dossier chargées:', result.informations_dossier);
            }

            // Afficher la compilation si disponible
            if (result.compilation_documents && result.compilation_documents.length > 0) {
                console.log(`✅ [LOAD_FILES] Compilation chargée: ${result.compilation_documents.length} document(s)`);

                // Stocker le nom du fichier de compilation
                anonymization.compilationFile = `compilation_${documentId}.json`;
                anonymization.files = result.compilation_documents;

                console.log('📁 [LOAD_FILES] Premier document:', {
                    id: result.compilation_documents[0].id,
                    filename: result.compilation_documents[0].filename,
                    type: result.compilation_documents[0].type_document
                });

                // Construire le message avec les parties
                let dossierMessage = '';
                if (anonymization.dossierInfo) {
                    const { parties_clientes, parties_adverses } = anonymization.dossierInfo;

                    const clientNames = [];
                    const adverseNames = [];

                    if (parties_clientes && parties_clientes.length > 0) {
                        parties_clientes.forEach(p => {
                            if (p.type === 'personne_physique') {
                                clientNames.push(p.nom);
                            } else {
                                clientNames.push(p.societe_nom);
                            }
                        });
                    }

                    if (parties_adverses && parties_adverses.length > 0) {
                        parties_adverses.forEach(p => {
                            if (p.type === 'personne_physique') {
                                adverseNames.push(p.nom);
                            } else {
                                adverseNames.push(p.societe_nom);
                            }
                        });
                    }

                    // Construire le message sur une seule ligne avec le format: URGOT / CAITLYN ou URGOT & Paul MARTIN / CAITLYN
                    if (clientNames.length > 0 && adverseNames.length > 0) {
                        dossierMessage = `${clientNames.join(' & ')} / ${adverseNames.join(' & ')}`;
                    } else if (clientNames.length > 0) {
                        dossierMessage = clientNames.join(' & ');
                    } else if (adverseNames.length > 0) {
                        dossierMessage = adverseNames.join(' & ');
                    }
                }

                // Mettre à jour le nom du dossier dans l'onglet
                if (dossierMessage) {
                    updateDossierName(dossierMessage);
                    addMessageToDossierTab('system', `✅ Dossier chargé : **${dossierMessage}** (${result.compilation_documents.length} pièces)`);
                } else {
                    addMessageToDossierTab('system', `✅ Dossier chargé (${result.compilation_documents.length} pièces)`);
                }

                
                const container = document.getElementById('filesListContainer');
    
                if (!anonymization.files || anonymization.files.length === 0) {
                    container.innerHTML = '<div class="empty-files">Aucun fichier chargé</div>';
                    return;
                }
                
                container.innerHTML = anonymization.files.map((doc, index) => `
                    <div class="file-item">
                        <div class="file-info">
                            <div class="file-name">📄 ${doc.filename || 'Document ' + (index + 1)}</div>
                            <div class="file-meta">${doc.type_document || 'Type inconnu'} • ID: ${doc.id || index}</div>
                        </div>
                    </div>
                `).join('');
                
                // Afficher la zone de fichiers
                updateFilesDisplay();
            }
        }
        
        console.log('═══════════════════════════════════════════════\n');
        
    } catch (error) {
        console.error('💥 [LOAD_FILES] Erreur complète:', error);
        console.error('💥 [LOAD_FILES] Type:', error.constructor.name);
        console.error('💥 [LOAD_FILES] Message:', error.message);
        console.error('💥 [LOAD_FILES] Stack:', error.stack);
    }
}

// Sélectionner des fichiers - EXTRACTION UNIQUEMENT
async function selectFiles() {
    console.log('[selectFiles] Ouverture du modal informations dossier');

    // Ouvrir le modal pour collecter les informations du dossier
    openDossierInfoModal();
}

// Fonction pour procéder à la sélection des fichiers après avoir collecté les informations du dossier
async function proceedWithFileSelection() {
    console.log('[proceedWithFileSelection] Début de la fonction - EXTRACTION SEULE');

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.txt,.md,.json,.xml,.pdf,.docx,.doc';
    input.style.display = 'none';

    // Attacher au DOM
    document.body.appendChild(input);
    console.log('[proceedWithFileSelection] Input ajouté au DOM');

    input.addEventListener('change', async (e) => {
        console.log('[selectFiles] Événement change déclenché');
        const files = Array.from(e.target.files);
        console.log('[selectFiles] Nombre de fichiers:', files.length);

        // Retirer l'input du DOM
        if (input.parentNode) {
            input.parentNode.removeChild(input);
            console.log('[selectFiles] Input retiré du DOM');
        }

        if (files.length === 0) {
            console.log('[selectFiles] Aucun fichier sélectionné, abandon');
            return;
        }

        let progressDiv = null;

        try {
            console.log('✅ ÉTAPE 1: Fichiers sélectionnés:', files.length, files.map(f => f.name));
            addMessage('system', `📁 ${files.length} fichier(s) sélectionné(s). Extraction en cours...`);

            // Afficher la progression
            progressDiv = showProgress('Extraction des fichiers', 'Extraction du texte...');

            // Extraire le texte côté client avec extraction.js
            const extractedData = await TextExtractor.extractMultiple(
                files,
                (current, total, message) => {
                    const progress = (current / total) * 100;
                    updateProgress(progress, message);
                }
            );

            console.log('✅ ÉTAPE 2: Extraction terminée', {
                totalFiles: extractedData.length,
                successful: extractedData.filter(f => !f.error).length,
                failed: extractedData.filter(f => f.error).length
            });

            // Vérifier qu'au moins un fichier a été extrait avec succès
            const validFiles = extractedData.filter(f => !f.error && f.text);
            if (validFiles.length === 0) {
                const errors = extractedData.map(f => `${f.fileName}: ${f.error}`).join('\n');
                throw new Error(`Aucun fichier n'a pu être traité:\n${errors}`);
            }

            updateProgress(100, 'Extraction terminée !');

            // Masquer la progression
            setTimeout(() => {
                hideProgress();
            }, 500);

            const documentId = await getDocumentId();

            // Créer compilation_documents
            const compilation_documents = validFiles.map((f, idx) => ({
                id: String(idx + 1).padStart(4, '0'),
                date_document: "",
                type_document: "",
                filename: f.fileName,
                texte_integral: f.text,
                analyse: ""
            }));

            // Stocker en mémoire
            anonymization.files = compilation_documents;
            anonymization.documentId = documentId;

            console.log('✅ ÉTAPE 3: compilation_documents créé:', compilation_documents.length);

            // Préparer la structure complète avec les informations du dossier
            const compilationData = {
                informations_dossier: anonymization.dossierInfo || {},
                documents: compilation_documents
            };

            // Enregistrer d'abord le dossier juridique actif et y écrire les
            // Markdown. Aucun autre fichier ne doit être produit ailleurs.
            const mdResult = await writeExtractedMarkdown(validFiles);
            if (!mdResult.written?.length) {
                throw new Error(mdResult.error || 'Aucun Markdown n’a été écrit dans le dossier juridique actif.');
            }
            addMessage('system', `📝 ${mdResult.written.length} fichier(s) Markdown écrit(s) dans : ${mdResult.folder}`);

            // La compilation est maintenant routée vers ce même dossier grâce
            // à l'association documentId → dossier enregistrée ci-dessus.
            const response = await fetch('https://localhost:43098/api/save-compilation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ documentId, compilation_data: compilationData })
            });
            if (!response.ok) {
                const detail = await response.json().catch(() => ({}));
                throw new Error(detail.error || 'Erreur sauvegarde compilation');
            }

            console.log('✅ Compilation sauvegardée dans le dossier juridique actif');
            addMessage('system', `✅ ${validFiles.length} fichier(s) extrait(s) avec succès !`);

            // Afficher les boutons d'anonymisation dans le chat
            addMessage('system', '📊 Choisissez une méthode d\'anonymisation:', {
                buttons: [
                    { text: '🤖 Anonymize with Ollama', action: 'anonymizeWithOllama' }
                ]
            });

        } catch (error) {
            console.error('❌ ERREUR CRITIQUE dans selectFiles:', error);
            console.error('❌ Stack trace:', error.stack);
            addMessage('error', `Erreur: ${error.message}`);
            if (progressDiv) {
                hideProgress();
            }
        }
    });

    console.log('[selectFiles] Déclenchement click sur input file');
    input.click();
}

/**
 * Retourne le dossier du document Word actuellement ouvert (via Office).
 * Ex: "/Users/.../Amélie contrat/Doc1.docx" → "/Users/.../Amélie contrat"
 * Renvoie null si le document n'est pas encore enregistré sur le disque.
 */
function getCurrentDocFolder() {
    return new Promise((resolve) => {
        try {
            Office.context.document.getFilePropertiesAsync((result) => {
                if (result.status === Office.AsyncResultStatus.Succeeded &&
                    result.value && result.value.url) {
                    let url = result.value.url;
                    // Nettoyer un éventuel préfixe file:// et décoder les %20 / accents
                    url = url.replace(/^file:\/\//, '');
                    try { url = decodeURIComponent(url); } catch (e) { /* garder tel quel */ }
                    // Dossier = tout ce qui précède le dernier séparateur
                    const sep = url.lastIndexOf('/') >= 0 ? '/' : '\\';
                    const folder = url.substring(0, url.lastIndexOf(sep));
                    resolve(folder || null);
                } else {
                    resolve(null);
                }
            });
        } catch (e) {
            console.warn('[getCurrentDocFolder] Erreur:', e);
            resolve(null);
        }
    });
}

/**
 * Écrit un fichier Markdown par document extrait dans le dossier du Word ouvert.
 * Le taskpane ne peut pas écrire sur le disque : on délègue au serveur.
 * @param {Array} validFiles - [{fileName, text, ...}]
 * @returns {Promise<{folder, written, error?}>}
 */
async function writeExtractedMarkdown(validFiles) {
    const folder = await getCurrentDocFolder();
    if (!folder) {
        return { folder: null, written: [], error: 'Document Word non enregistré (dossier introuvable). Enregistrez le document puis relancez l\'extraction.' };
    }

    const files = validFiles.map(f => ({
        name: f.fileName,
        markdown: f.text || ''
    }));

    const response = await fetch('https://localhost:43098/api/extract/write-md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, files, documentId: anonymization.documentId })
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { folder, written: [], error: err.error || `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { folder: data.folder || folder, written: data.written || [] };
}
// ============================================
// ANONYMIZATION FUNCTIONS (MOVED TO MODULE)
// ============================================
// All anonymization functions are now in ./modules/anonymization.js
// Create local references for backward compatibility

const mergeMappingWithDossierInfo = AnonymizationModule.mergeMappingWithDossierInfo;
const showMappingValidation = AnonymizationModule.showMappingValidation;
const validateMapping = () => AnonymizationModule.validateMapping(addMessage, updateFilesDisplay);
const reopenMappingModal = () => AnonymizationModule.reopenMappingModal(getDocumentId, addMessage);
const convertFlatToHierarchical = AnonymizationModule.convertFlatToHierarchical;
const refreshMappingModal = AnonymizationModule.refreshMappingModal;
const addVariant = AnonymizationModule.addVariant;
const deleteVariant = AnonymizationModule.deleteVariant;
const deleteMappingItem = AnonymizationModule.deleteMappingItem;
const addMappingItem = AnonymizationModule.addMappingItem;
const getCategoryIcon = AnonymizationModule.getCategoryIcon;

// Dossier info functions
const openDossierInfoModal = AnonymizationModule.openDossierInfoModal;
const closeDossierInfoModal = AnonymizationModule.closeDossierInfoModal;
const addPartieCliente = AnonymizationModule.addPartieCliente;
const addPartieAdverse = AnonymizationModule.addPartieAdverse;
const deletePartieCliente = AnonymizationModule.deletePartieCliente;
const deletePartieAdverse = AnonymizationModule.deletePartieAdverse;
const updatePartieClienteFields = AnonymizationModule.updatePartieClienteFields;
const updatePartieAdverseFields = AnonymizationModule.updatePartieAdverseFields;
const collectDossierInfo = AnonymizationModule.collectDossierInfo;
const loadDossierInfo = AnonymizationModule.loadDossierInfo;
const saveDossierInfoAndContinue = () => AnonymizationModule.saveDossierInfoAndContinue(addMessage, proceedWithFileSelection);

// Tampon functions
const openTamponModal = AnonymizationModule.openTamponModal;
const closeTamponModal = AnonymizationModule.closeTamponModal;
const handleTamponImageUpload = (event) => AnonymizationModule.handleTamponImageUpload(event, addMessage);
const saveTampon = () => AnonymizationModule.saveTampon(addMessage);
const clearTampon = () => AnonymizationModule.clearTampon(addMessage);
const loadTamponFromStorage = AnonymizationModule.loadTamponFromStorage;
const updateFilesListDisplay = AnonymizationModule.updateFilesListDisplay;

// Afficher les fichiers chargés
function updateFilesDisplay() {
    const statusDiv = document.getElementById('anonymizationStatus');
    const mappingIndicator = document.getElementById('mappingIndicator');
    const clearBtn = document.getElementById('clearMappingBtn');
    
    if (anonymization.enabled || anonymization.files.length > 0) {
        // ✅ DÉTECTER si le mapping est PLAT ou HIÉRARCHIQUE
        const isFlat = anonymization.mapping && 
                       !anonymization.mapping.personnes_physiques && 
                       !anonymization.mapping.societes;
        let totalEntities = 0;
        if (isFlat) {
            // Mapping plat : compter directement les clés
            totalEntities = Object.keys(anonymization.reverse_mapping || {}).length;
        } else {
            // Mapping hiérarchique : compter par catégorie
            const counts = {
                personnes_physiques: Object.keys(anonymization.mapping.personnes_physiques || {}).length,
                societes: Object.keys(anonymization.mapping.societes || {}).length,
                adresses: Object.keys(anonymization.mapping.adresses || {}).length,
                siren: Object.keys(anonymization.mapping.siren || {}).length
            };
            totalEntities = counts.personnes_physiques + counts.societes + counts.adresses + counts.siren;
        }
        clearBtn.style.display = 'inline-block';
        statusDiv.textContent = `🔒 ${totalEntities} entités protégées`;
    } else {
        statusDiv.textContent = '';
        clearBtn.style.display = 'none';
    }
}
async function clearFiles() {
    if (!anonymization.documentId) return;

    try {
        // Supprimer tous les fichiers (mapping + compilation)
        await fetch(`https://localhost:43098/api/anonymize/files/${anonymization.documentId}`, {
            method: 'DELETE'
        });

        // NE PAS réinitialiser documentId - il doit toujours refléter le document Word actuel
        // anonymization.documentId reste inchangé
        anonymization.mapping = null;
        anonymization.reverse_mapping = null;
        anonymization.files = [];
        anonymization.compilationFile = null;
        anonymization.enabled = false;

        // Mettre à jour l'affichage
        updateFilesDisplay();

        addMessage('system', '🗑️ Fichiers et mapping d\'anonymisation effacés.');
    } catch (error) {
        console.error('Erreur lors de l\'effacement:', error);
        addMessage('error', 'Erreur lors de l\'effacement des fichiers.');
    }
}

// MOVED TO MODULE: ./modules/anonymization.js
// Use AnonymizationModule.anonymizeText() to call this function
const anonymizeText = AnonymizationModule.anonymizeText;
// Populer la liste des outils MCP
function populateMcpToolsList() {
    const container = document.getElementById('mcpToolsList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (config.mcpTools.length === 0) {
        container.innerHTML = '<p style="color: #858585;">Aucun outil MCP connecté</p>';
        return;
    }
    
    config.mcpTools.forEach(tool => {
        const label = document.createElement('label');
        label.className = 'tool-item';
        label.innerHTML = `
            <input type="checkbox" class="tool-checkbox" data-tool="${tool.name}" checked>
            <span class="tool-name">🔧 ${tool.name}</span>
            <span class="tool-desc">${tool.description || ''}</span>
        `;
        container.appendChild(label);
    });
}
/**
 * Extrait les blocs de réflexion du texte et retourne un tableau de content blocks
 * Détecte plusieurs formats :
 * - Balises XML : <thinking>...</thinking>
 * - Sections markdown : ## Réflexion / ## Thinking
 * - Patterns naturels : "Laissez-moi réfléchir...", "Je pense que...", etc.
 */
function extractThinkingFromText(text) {
    if (!text) {
        return [{ type: 'text', text: '' }];
    }

    const content = [];
    let remainingText = text;

    // 1. Détecter les balises XML <thinking>...</thinking>
    const xmlThinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/gi;
    let match;
    let lastIndex = 0;

    while ((match = xmlThinkingRegex.exec(text)) !== null) {
        // Ajouter le texte avant le bloc thinking
        if (match.index > lastIndex) {
            const beforeText = text.substring(lastIndex, match.index).trim();
            if (beforeText) {
                content.push({ type: 'text', text: beforeText });
            }
        }

        // Ajouter le bloc thinking
        const thinkingContent = match[1].trim();
        if (thinkingContent) {
            content.push({ type: 'thinking', thinking: thinkingContent });
        }

        lastIndex = match.index + match[0].length;
    }

    // Ajouter le texte restant après le dernier bloc thinking
    if (lastIndex < text.length) {
        remainingText = text.substring(lastIndex);
    } else if (content.length > 0) {
        return content; // On a trouvé des balises XML, retourner
    }

    // 2. Si pas de balises XML, détecter les sections markdown
    const markdownThinkingRegex = /^##\s*(Réflexion|Thinking|Analyse|Raisonnement)[\s:]*\n([\s\S]*?)(?=\n##|\n\n[A-Z]|$)/gmi;
    lastIndex = 0;
    let foundMarkdown = false;

    while ((match = markdownThinkingRegex.exec(remainingText)) !== null) {
        foundMarkdown = true;
        
        // Ajouter le texte avant la section
        if (match.index > lastIndex) {
            const beforeText = remainingText.substring(lastIndex, match.index).trim();
            if (beforeText) {
                content.push({ type: 'text', text: beforeText });
            }
        }

        // Ajouter le bloc thinking
        const thinkingContent = match[2].trim();
        if (thinkingContent) {
            content.push({ type: 'thinking', thinking: thinkingContent });
        }

        lastIndex = match.index + match[0].length;
    }

    if (foundMarkdown) {
        // Ajouter le texte restant
        if (lastIndex < remainingText.length) {
            const afterText = remainingText.substring(lastIndex).trim();
            if (afterText) {
                content.push({ type: 'text', text: afterText });
            }
        }
        return content;
    }

    // 3. Si pas de sections markdown, détecter les patterns naturels au début
    const naturalPatterns = [
        /^(Laissez-moi réfléchir[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si,
        /^(Je vais réfléchir[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si,
        /^(Analysons cela[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si,
        /^(Réfléchissons[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si,
        /^(Let me think[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si,
        /^(Thinking[\.:].*?)(?=\n\n[A-Z]|\n\n$)/si
    ];

    for (const pattern of naturalPatterns) {
        match = remainingText.match(pattern);
        if (match) {
            const thinkingContent = match[1].trim();
            const afterThinking = remainingText.substring(match[0].length).trim();

            if (thinkingContent) {
                content.push({ type: 'thinking', thinking: thinkingContent });
            }
            if (afterThinking) {
                content.push({ type: 'text', text: afterThinking });
            }
            return content;
        }
    }

    // 4. Aucun pattern détecté, retourner tout comme texte
    if (remainingText.trim()) {
        content.push({ type: 'text', text: remainingText.trim() });
    }

    return content.length > 0 ? content : [{ type: 'text', text: text }];
}
// Ouvrir le modal des fichiers
function openFilesModal() {
    updateFilesListDisplay();
    document.getElementById('filesModal').classList.add('show');
}

// Fermer le modal des fichiers
function closeFilesModal() {
    document.getElementById('filesModal').classList.remove('show');
}

// ============================================
// MODAL CONVERT & SCAN PIPELINE
// ============================================
let activeConvertScanJobId = null;

// ============================================
// MODAL CONVERT & SCAN PIPELINE
// ============================================

function openConvertScanModal() {
    const modal = document.getElementById('convertScanModal');
    modal.style.display = 'flex';

    if (!activeConvertScanJobId) {
        // Reset UI when no active job
        document.getElementById('convertScanOutput').style.display = 'none';
        document.getElementById('convertScanOutput').textContent = '';
        document.getElementById('convertScanFileStatus').textContent = '';
        document.getElementById('convertScanFileInput').value = '';
        document.getElementById('runConvertScanBtn').disabled = true;
        document.getElementById('cancelConvertScanBtn').textContent = 'Annuler';
        document.getElementById('convertScanProgressContainer').style.display = 'none';
        document.getElementById('convertScanProgressBar').style.width = '0%';
        document.getElementById('convertScanProgressText').textContent = '0/0 fichiers';
        document.getElementById('convertScanPhaseLabel').textContent = 'Initialisation…';
        document.getElementById('convertScanChunkContainer').style.display = 'none';
        document.getElementById('convertScanChunkBar').style.width = '0%';
        document.getElementById('convertScanChunkText').textContent = '0 / 0 segments';
    }
}

function closeConvertScanModal() {
    if (activeConvertScanJobId) {
        cancelPythonScript(activeConvertScanJobId);
        activeConvertScanJobId = null;
    }
    document.getElementById('convertScanModal').style.display = 'none';
}

function handleConvertScanFileSelect(e) {
    const files = Array.from(e.target.files);
    const status = document.getElementById('convertScanFileStatus');
    const runBtn = document.getElementById('runConvertScanBtn');

    if (files.length === 0) {
        status.textContent = '';
        runBtn.disabled = true;
        return;
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);

    if (files.length === 1) {
        status.textContent = `1 fichier : ${files[0].name} (${sizeMB} Mo)`;
    } else {
        const names = files.slice(0, 3).map(f => f.name).join(', ');
        const suffix = files.length > 3 ? `, +${files.length - 3} autres` : '';
        status.textContent = `${files.length} fichiers : ${names}${suffix} (${sizeMB} Mo)`;
    }

    runBtn.disabled = false;
}

function parseConvertScanProgress(data, outputEl, progressBar, phaseLabel, progressText, fileCount) {
    const chunkContainer = document.getElementById('convertScanChunkContainer');
    const chunkBar       = document.getElementById('convertScanChunkBar');
    const chunkLabel     = document.getElementById('convertScanChunkLabel');
    const chunkText      = document.getElementById('convertScanChunkText');

    const lines = data.split('\n');

    for (const line of lines) {
        // Phase 1 — file conversion progress (0 → 50% of main bar)
        const convertMatch = line.match(/^PROGRESS:CONVERT:(\d+):(\d+):(\d+)$/);
        if (convertMatch) {
            const [, pct, index, total] = convertMatch;
            progressBar.style.width = `${Math.floor(parseInt(pct) / 2)}%`;
            phaseLabel.textContent = 'Phase 1/2 : Conversion des documents…';
            progressText.textContent = `${index}/${total} fichiers convertis`;
            continue;
        }

        // Phase 2 — file-level scan progress (50 → 100% of main bar)
        const scanMatch = line.match(/^PROGRESS:SCAN:(\d+):(\d+):(\d+)$/);
        if (scanMatch) {
            const [, pct, index, total] = scanMatch;
            progressBar.style.width = `${50 + Math.floor(parseInt(pct) / 2)}%`;
            phaseLabel.textContent = 'Phase 2/2 : Scan des données sensibles…';
            progressText.textContent = `${index}/${total} fichiers scannés`;
            // Reset chunk bar for the new file about to be scanned
            if (chunkBar)  chunkBar.style.width = '0%';
            if (chunkText) chunkText.textContent = `0 / — segments (0%)`;
            continue;
        }

        // Phase 2 — NER chunk progress (dedicated tag, drives green bar directly)
        const chunksMatch = line.match(/^PROGRESS:CHUNKS:(\d+):(\d+):(\d+)$/);
        if (chunksMatch) {
            const [, pct, index, total] = chunksMatch;
            if (chunkContainer) {
                chunkContainer.style.display = 'block';
                chunkBar.style.width  = `${parseInt(pct)}%`;
                chunkLabel.textContent = 'Analyse NER :';
                chunkText.textContent  = `${index} / ${total} segments (${pct}%)`;
            }
            continue;
        }

        // All other output — display in terminal
        if (line.trim() && !line.startsWith('PROGRESS:')) {
            outputEl.textContent += line + '\n';
            outputEl.scrollTop = outputEl.scrollHeight;
        }
    }
}

/**
 * Load consolidated mapping after Convert & Scan pipeline completes
 * and show validation modal
 */
async function loadMappingForValidation() {
    try {
        // Read mapping file using EXISTING server endpoint
        const documentId = anonymization.documentId || await getDocumentId();
        const response = await fetch(`https://localhost:43098/api/anonymize/mapping/${documentId}`);

        if (!response.ok) {
            console.log('No mapping found, skipping validation');
            return;
        }

        const mappingData = await response.json();

        // Merge with dossierInfo if available
        let finalMapping = mappingData.mapping;
        let finalReverse = mappingData.reverse_mapping;

        if (anonymization.dossierInfo) {
            console.log('Merging mapping with dossierInfo...');
            const merged = mergeMappingWithDossierInfo(
                finalMapping,
                finalReverse,
                anonymization.dossierInfo
            );
            finalMapping = merged.mapping;
            finalReverse = merged.reverse_mapping;
        }

        // Prepare result for validation modal
        const validationData = {
            mapping: finalMapping,
            reverse_mapping: finalReverse,
            extracted_data: mappingData.extracted_data,
            compilation_documents: [] // Empty since we already have the files
        };

        // Close the convert-scan modal
        closeConvertScanModal();

        // Show mapping validation modal (existing function)
        showMappingValidation(validationData);

        addMessage('system', '📋 Veuillez valider le mapping d\'anonymisation détecté.');

        // NOTE: When user clicks "Valider et utiliser", the existing validateMapping()
        // function will save to server via PUT /api/anonymize/mapping/:documentId
        // which writes back to mapping_{documentId}.json, maintaining consistency

    } catch (error) {
        console.error('Error loading mapping for validation:', error);
        addMessage('system', `⚠️  Erreur lors du chargement du mapping : ${error.message}`);
    }
}

async function runConvertScan() {
    const files = Array.from(document.getElementById('convertScanFileInput').files);
    if (files.length === 0) return;

    const engine = document.getElementById('convertScanEngine').value;
    const mode = document.getElementById('convertScanMode').value;
    const lang = document.getElementById('convertScanLang').value;
    const documentId = anonymization.documentId || await getDocumentId();

    const outputEl  = document.getElementById('convertScanOutput');
    const runBtn    = document.getElementById('runConvertScanBtn');
    const cancelBtn = document.getElementById('cancelConvertScanBtn');
    const progressContainer = document.getElementById('convertScanProgressContainer');
    const progressBar = document.getElementById('convertScanProgressBar');
    const phaseLabel = document.getElementById('convertScanPhaseLabel');
    const progressText = document.getElementById('convertScanProgressText');

    // Show UI elements
    outputEl.style.display = 'block';
    progressContainer.style.display = 'block';
    outputEl.textContent = files.length === 1
        ? '📤 Upload du fichier…\n'
        : `📤 Upload de ${files.length} fichiers…\n`;
    runBtn.disabled = true;
    cancelBtn.textContent = '⏹ Annuler';
    progressBar.style.width = '0%';
    phaseLabel.textContent = 'Initialisation…';
    progressText.textContent = `0/${files.length} fichiers`;
    document.getElementById('convertScanChunkContainer').style.display = 'none';
    document.getElementById('convertScanChunkBar').style.width = '0%';
    document.getElementById('convertScanChunkText').textContent = '0 / 0 segments';

    // Setup cancel handler
    cancelBtn.onclick = () => {
        if (activeConvertScanJobId) {
            cancelPythonScript(activeConvertScanJobId);
            activeConvertScanJobId = null;
            outputEl.textContent += '\n⏹ Pipeline annulé par l\'utilisateur\n';
            runBtn.disabled = false;
            cancelBtn.textContent = 'Fermer';
            cancelBtn.onclick = closeConvertScanModal;
        } else {
            closeConvertScanModal();
        }
    };

    try {
        // Build options object
        const options = { engine };
        if (mode) options.mode = mode;
        if (lang) options.lang = lang;

        // Execute pipeline using batch API
        activeConvertScanJobId = await executePythonScriptBatch(
            'convert-scan',
            files,
            options,
            {
                onOutput(data) {
                    parseConvertScanProgress(data, outputEl, progressBar, phaseLabel, progressText, files.length);
                },
                onFileStart(fileName, index, total) {
                    outputEl.textContent += `\n📄 [${index + 1}/${total}] Traitement: ${fileName}\n`;
                    outputEl.scrollTop = outputEl.scrollHeight;
                },
                onFileComplete(fileName, index, total, exitCode) {
                    if (exitCode === 0) {
                        outputEl.textContent += `   ✅ ${fileName} traité avec succès\n`;
                    } else {
                        outputEl.textContent += `   ⚠️ ${fileName} partiellement traité (code ${exitCode})\n`;
                    }
                    outputEl.scrollTop = outputEl.scrollHeight;
                },
                onDone(successCount, totalFiles, outputDir) {
                    activeConvertScanJobId = null;
                    progressBar.style.width = '100%';
                    phaseLabel.textContent = '✅ Pipeline terminé';
                    progressText.textContent = `${successCount}/${totalFiles} fichiers`;

                    outputEl.textContent += `\n${'='.repeat(60)}\n`;
                    outputEl.textContent += `✅ Pipeline terminé : ${successCount}/${totalFiles} fichier(s) traité(s)\n`;
                    outputEl.textContent += `📂 Dossier de sortie : ${outputDir}\n`;
                    outputEl.scrollTop = outputEl.scrollHeight;

                    addMessage('system', `✅ Convert & Scan : ${successCount}/${totalFiles} fichier(s) traité(s). Sortie: ${outputDir}`);

                    runBtn.disabled = false;
                    cancelBtn.textContent = 'Fermer';
                    cancelBtn.onclick = closeConvertScanModal;

                    // NEW: Load and validate mapping
                    loadMappingForValidation();
                },
                onError(error) {
                    activeConvertScanJobId = null;
                    outputEl.textContent += `\n❌ Erreur pipeline: ${error}\n`;
                    outputEl.scrollTop = outputEl.scrollHeight;
                    runBtn.disabled = false;
                    cancelBtn.textContent = 'Fermer';
                    cancelBtn.onclick = closeConvertScanModal;
                }
            },
            documentId
        );

        outputEl.textContent += '🚀 Pipeline Convert & Scan lancé…\n';
        outputEl.scrollTop = outputEl.scrollHeight;

    } catch (error) {
        activeConvertScanJobId = null;
        outputEl.textContent += `\n❌ Erreur lors du lancement: ${error}\n`;
        outputEl.scrollTop = outputEl.scrollHeight;
        runBtn.disabled = false;
        cancelBtn.textContent = 'Fermer';
        cancelBtn.onclick = closeConvertScanModal;
    }
}

function initConvertScanListeners() {
    const convertScanBtn = document.getElementById('convertScanBtn');
    const closeBtn = document.getElementById('closeConvertScanModal');
    const fileInput = document.getElementById('convertScanFileInput');
    const runBtn = document.getElementById('runConvertScanBtn');
    const cancelBtn = document.getElementById('cancelConvertScanBtn');
    const engineSelect = document.getElementById('convertScanEngine');

    if (convertScanBtn) convertScanBtn.onclick = openConvertScanModal;
    if (closeBtn) closeBtn.onclick = closeConvertScanModal;
    if (fileInput) fileInput.onchange = handleConvertScanFileSelect;
    if (runBtn) runBtn.onclick = runConvertScan;
    if (cancelBtn) cancelBtn.onclick = closeConvertScanModal;

    // Show/hide MinerU options based on engine selection
    if (engineSelect) {
        engineSelect.onchange = function() {
            const showMineruOpts = (this.value === 'mineru' || this.value === 'auto');
            document.getElementById('convertScanModeGroup').style.display = showMineruOpts ? 'block' : 'none';
            document.getElementById('convertScanLangGroup').style.display = showMineruOpts ? 'block' : 'none';
        };
        // Initialize visibility
        engineSelect.onchange();
    }
}

// Clear files avec fermeture du modal
function clearFilesFromModal() {
    clearFiles();
    closeFilesModal();
}

// Add files avec fermeture du modal
async function addFilesFromModal() {
    await selectFiles();
    closeFilesModal();
    updateFilesListDisplay();
}

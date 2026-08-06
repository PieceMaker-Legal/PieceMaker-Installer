
// ============================================
// CLAUDE CODE CLI INTEGRATION (xterm.js + PTY)
// ============================================

let cliTabId = null;
let cliTerminal = null;
let cliFitAddon = null;
let cliPtyActive = false;
let cliContainerElement = null;

let deps = null;

export function initDependencies(dependencies) {
    deps = dependencies;
}

export function getCliTabId() {
    return cliTabId;
}

export function showCliTerminal() {
    const chatContainer = document.getElementById('chatContainer');
    const inputArea = document.getElementById('inputArea');
    if (inputArea) inputArea.style.display = 'none';

    if (cliContainerElement && chatContainer) {
        chatContainer.innerHTML = '';
        chatContainer.appendChild(cliContainerElement);
        if (cliFitAddon) setTimeout(() => cliFitAddon.fit(), 50);
        if (cliTerminal) cliTerminal.focus();
    }
}

export function hideCliTerminal() {
    const inputArea = document.getElementById('inputArea');
    if (inputArea) inputArea.style.display = '';
}
export async function openClaudeCLI() {
    // Si un onglet CLI existe déjà, basculer dessus
    if (cliTabId !== null) {
        const existingTab = deps.chatTabs.find(t => t.id === cliTabId);
        if (existingTab) {
            deps.switchToTab(cliTabId);
            return;
        }
    }

    // Sauvegarder le contenu du chat actuel
    if (deps.getActiveTabId() !== null) {
        deps.saveCurrentTabContent();
    }

    // Créer un nouvel onglet CLI
    cliTabId = deps.allocateTabId();
    const newTab = {
        id: cliTabId,
        type: 'claude-cli',
        conversationHistory: [],
        chatContent: ''
    };

    deps.chatTabs.push(newTab);
    deps.renderChatTabs();

    // Basculer sur l'onglet CLI avant d'initialiser le terminal
    // (switchToTab sauvegarde le contenu de l'onglet précédent tant que chatContainer est encore intact)
    deps.switchToTab(cliTabId);
    await initXtermTerminal();
}

export async function initXtermTerminal() {
    const chatContainer = document.getElementById('chatContainer');

    // Cacher l'inputArea car xterm gère l'input directement
    const inputArea = document.getElementById('inputArea');
    if (inputArea) {
        inputArea.style.display = 'none';
    }

    // Créer le conteneur du terminal
    chatContainer.innerHTML = `
        <div id="terminal-container" style="
            width: 100%;
            height: 100%;
            background: #1e1e1e;
            padding: 4px;
            box-sizing: border-box;
        "></div>
    `;

    const terminalContainer = document.getElementById('terminal-container');

    // Vérifier que xterm est disponible
    if (typeof Terminal === 'undefined') {
        chatContainer.innerHTML = `
            <div class="message error" style="color: #ff6b6b; padding: 20px;">
                ❌ xterm.js n'est pas chargé. Veuillez rafraîchir la page.
            </div>
        `;
        return;
    }

    // Créer le terminal xterm.js
    cliTerminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'block',
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#ffffff',
            cursorAccent: '#1e1e1e',
            selection: 'rgba(255, 255, 255, 0.3)',
            black: '#000000',
            red: '#cd3131',
            green: '#0dbc79',
            yellow: '#e5e510',
            blue: '#2472c8',
            magenta: '#bc3fbc',
            cyan: '#11a8cd',
            white: '#e5e5e5',
            brightBlack: '#666666',
            brightRed: '#f14c4c',
            brightGreen: '#23d18b',
            brightYellow: '#f5f543',
            brightBlue: '#3b8eea',
            brightMagenta: '#d670d6',
            brightCyan: '#29b8db',
            brightWhite: '#ffffff'
        },
        allowProposedApi: true,
        scrollback: 5000
    });

    // Addon pour le redimensionnement automatique
    if (typeof FitAddon !== 'undefined') {
        cliFitAddon = new FitAddon.FitAddon();
        cliTerminal.loadAddon(cliFitAddon);
    }

    // Ouvrir le terminal dans le conteneur
    cliTerminal.open(terminalContainer);
    cliContainerElement = terminalContainer;

    // Ajuster la taille
    if (cliFitAddon) {
        setTimeout(() => {
            cliFitAddon.fit();
        }, 100);
    }

    // Afficher message de démarrage
    cliTerminal.writeln('\x1b[1;36m🚀  Connexion au terminal...\x1b[0m');
    cliTerminal.writeln('');

    const { ws } = deps;
    
    // S'assurer que WebSocket est connecté
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        cliTerminal.writeln('\x1b[1;33m⏳ Attente de la connexion WebSocket...\x1b[0m');
        await waitForWebSocket();
    }

    // Démarrer le PTY via WebSocket
    startPtyTerminal();

    // Gérer l'input du terminal
    cliTerminal.onData((data) => {
        const { ws } = deps;
        if (ws && ws.readyState === WebSocket.OPEN && cliPtyActive) {
            ws.send(JSON.stringify({ type: 'pty-input', data }));
        }
    });

    // Gérer le redimensionnement
    const resizeObserver = new ResizeObserver(() => {
        if (cliFitAddon && cliTerminal) {
            cliFitAddon.fit();
            // Envoyer les nouvelles dimensions au serveur
            const { ws } = deps;
            if (ws && ws.readyState === WebSocket.OPEN && cliPtyActive) {
                ws.send(JSON.stringify({
                    type: 'pty-resize',
                    cols: cliTerminal.cols,
                    rows: cliTerminal.rows
                }));
            }
        }
    });
    resizeObserver.observe(terminalContainer);

    // Focus sur le terminal
    cliTerminal.focus();
}

export function waitForWebSocket() {
    if (!deps) return Promise.resolve();
    
    const { ws } = deps;
    
    return new Promise((resolve) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            resolve();
            return;
        }

        const checkInterval = setInterval(() => {
            const { ws } = deps;
            if (ws && ws.readyState === WebSocket.OPEN) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);

        // Timeout après 5 secondes
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 5000);
    });
}

export function startPtyTerminal() {
    if (!deps) return;
    
    const { ws } = deps;
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (cliTerminal) {
            cliTerminal.writeln('\x1b[1;31m❌ WebSocket non connecté\x1b[0m');
        }
        return;
    }

    // Obtenir les dimensions du terminal
    const cols = cliTerminal ? cliTerminal.cols : 80;
    const rows = cliTerminal ? cliTerminal.rows : 24;

    // Obtenir le documentId pour ouvrir le PTY dans le bon dossier
    const documentId = deps.getDocumentId ? deps.getDocumentId() : null;

    // Demander au serveur de créer un PTY
    ws.send(JSON.stringify({
        type: 'pty-start',
        cols,
        rows,
        documentId
    }));

    cliPtyActive = true;

    if (cliTerminal) {
        cliTerminal.writeln('\x1b[1;32m✅  Terminal PTY connecté\x1b[0m');
        cliTerminal.writeln('\x1b[90m─────────────────────────────────────\x1b[0m');
        cliTerminal.writeln('');
    }
}

export function stopPtyTerminal() {
    if (!deps) return;

    const { ws } = deps;

    if (ws && ws.readyState === WebSocket.OPEN && cliPtyActive) {
        ws.send(JSON.stringify({ type: 'pty-stop' }));
    }
    cliPtyActive = false;
}

export function cleanupCliTerminal() {
    stopPtyTerminal();
    if (cliTerminal) {
        cliTerminal.dispose();
        cliTerminal = null;
    }
    cliFitAddon = null;
    cliContainerElement = null;
    cliTabId = null;
    hideCliTerminal();
}

export function handlePtyMessage(data) {
    switch (data.type) {
        case 'pty-output':
            if (cliTerminal) {
                cliTerminal.write(data.data);
            }
            break;

        case 'pty-exit':
            if (cliTerminal) {
                cliTerminal.writeln('');
                cliTerminal.writeln(`\x1b[1;33m⚠️ Terminal fermé (code: ${data.exitCode})\x1b[0m`);
            }
            cliPtyActive = false;
            break;

        case 'pty-error':
            if (cliTerminal) {
                cliTerminal.writeln(`\x1b[1;31m❌ Erreur: ${data.error}\x1b[0m`);
            }
            break;
    }
}

export function setupPtyWebSocketHandler() {
    if (!deps) return;
    
    const { ws } = deps;
    if (!ws) return;

    const existingHandler = ws.onmessage;
    ws.onmessage = async (event) => {
        try {
            const message = JSON.parse(event.data);

            // Gérer les messages PTY
            if (message.type && message.type.startsWith('pty-')) {
                handlePtyMessage(message);
                return;
            }

            // Appeler le handler existant pour les autres messages
            if (existingHandler) {
                existingHandler(event);
            }
        } catch (error) {
            // Si ce n'est pas du JSON, passer au handler original
            if (existingHandler) {
                existingHandler(event);
            }
        }
    };
}
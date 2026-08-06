const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const Store = require('electron-store');
const UpdateManager = require('./UpdateManager');
const Config = require('./config');
const { spawn } = require('child_process');

const store = new Store();
const updateManager = new UpdateManager();
const config = new Config();

let mainWindow;
let serverProcess = null;
let mcpServerProcess = null;
let serverPort = 43098;

// Chemins des fichiers du add-in
const addonPath = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'taskpane')
  : path.join(__dirname, '..', 'taskpane');

const serverPath = path.join(__dirname, '..', 'websocket-server', 'server.cjs');
const mcpServerPath = path.join(__dirname, '..', 'mcp-server', 'mcp-server-local.js');
const manifestPath = path.join(addonPath, 'manifest.xml');


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    autoHideMenuBar: true,
    title: 'PieceMaker Word Assistant'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Ouvrir DevTools en développement
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Vérifier les mises à jour au démarrage (après 3 secondes)
  setTimeout(() => {
    checkForUpdatesAuto();
  }, 3000);
}

// Vérification automatique des mises à jour
async function checkForUpdatesAuto() {
  try {
    const updateInfo = await updateManager.checkForUpdates();
    
    if (updateInfo && updateInfo.available) {
      // Envoyer la notification au renderer
      if (mainWindow) {
        mainWindow.webContents.send('update-available', updateInfo);
      }
    }
  } catch (error) {
    console.error('[Update] Erreur vérification auto:', error);
  }
}

// Démarrer le serveur local
function startLocalServer() {
  return new Promise((resolve, reject) => {
    try {
      console.log('Démarrage du serveur local...');
      console.log('Chemin serveur:', serverPath);

      if (!fs.existsSync(serverPath)) {
        reject(new Error(`Fichier serveur introuvable: ${serverPath}`));
        return;
      }
// 🔍 LOG : Vérifier les valeurs du store AVANT de les passer
      const mcpUrl = store.get('mcp-url');
      const mcpApiKey = store.get('mcp-api-key');
      console.log('🔍 [MAIN] Valeurs du store:', {
        'mcp-url': mcpUrl,
        'mcp-api-key': mcpApiKey ? '***' + mcpApiKey.slice(-4) : 'UNDEFINED'
      });

      // Déterminer le chemin racine de l'app et node_modules
      const appRoot = app.isPackaged
        ? process.resourcesPath
        : __dirname;

      const nodeModulesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        : path.join(__dirname, 'node_modules');

      // Sur Windows packagé, le cwd doit être app.asar.unpacked pour que require() trouve les modules
      const serverCwd = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : __dirname;

      // Utiliser fork pour exécuter le script Node.js avec le même runtime que le processus parent
      serverProcess = fork(serverPath, [], {
        cwd: serverCwd, // Définir le cwd à app.asar.unpacked pour que Node trouve les modules
        env: {
          ...process.env,
          PORT: serverPort,
          MCP_URL: mcpUrl,
          MCP_API_KEY: mcpApiKey,
          NODE_PATH: nodeModulesPath, // Permet de trouver les modules
          OUTPUT_PATH: getOutputPath() // Passer le chemin de sortie au serveur
        },
        silent: false, // Permet de capturer stdout/stderr
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'] // Important pour capturer les logs
      });

      // Gestion des messages du processus forké
      if (serverProcess.stdout) {
        serverProcess.stdout.on('data', (data) => {
          const output = data.toString();
          console.log('[Serveur]', output);

          if (mainWindow) {
            mainWindow.webContents.send('server-log', {
              type: 'info',
              message: output
            });
          }

          if (output.includes('Serveur démarré') || output.includes('listening')) {
            resolve();
          }
        });
      }

      if (serverProcess.stderr) {
        serverProcess.stderr.on('data', (data) => {
          const error = data.toString();
          console.error('[Serveur Erreur]', error);

          if (mainWindow) {
            mainWindow.webContents.send('server-log', {
              type: 'error',
              message: error
            });
          }
        });
      }

      serverProcess.on('error', (error) => {
        console.error('Erreur serveur:', error);
        reject(error);
      });

      serverProcess.on('exit', (code) => {
        console.log(`Serveur terminé avec le code ${code}`);
        if (mainWindow) {
          mainWindow.webContents.send('server-status', 'stopped');
        }
      });

      // Timeout de 5 secondes
      setTimeout(() => {
        if (serverProcess && serverProcess.exitCode === null) {
          resolve();
        } else {
          reject(new Error('Le serveur n\'a pas démarré dans le temps imparti'));
        }
      }, 5000);

    } catch (error) {
      reject(error);
    }
  });
}

// Démarrer le serveur MCP
function startMCPServer() {
  return new Promise((resolve, reject) => {
        try {
      // ✅ VÉRIFIER que la clé API existe
      const mcpApiKey = store.get('mcp-api-key');
      if (!mcpApiKey) {
        reject(new Error('Aucune clé API MCP configurée. Veuillez configurer votre clé dans la section Configuration MCP.'));
        return;
      }
      console.log('Démarrage du serveur MCP...');
      console.log('Chemin MCP:', mcpServerPath);

      if (!fs.existsSync(mcpServerPath)) {
        reject(new Error(`Fichier MCP introuvable: ${mcpServerPath}`));
        return;
      }
      // Déterminer le chemin racine de l'app et node_modules
      const appRoot = app.isPackaged
        ? process.resourcesPath
        : __dirname;

      const nodeModulesPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
        : path.join(__dirname, 'node_modules');

      // Sur Windows packagé, le cwd doit être app.asar.unpacked pour que require() trouve les modules
      const mcpServerCwd = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked')
        : __dirname;

      // Créer un lien symbolique node_modules dans addon si nécessaire (pour résolution ESM)
      const addonNodeModules = path.join(addonPath, 'node_modules');
      if (!fs.existsSync(addonNodeModules)) {
        try {
          // Créer un lien symbolique relatif depuis addon/node_modules vers ../node_modules
          fs.symlinkSync('../node_modules', addonNodeModules, 'junction');
          console.log('✓ Lien symbolique node_modules créé dans addon');
        } catch (err) {
          console.warn('⚠️ Impossible de créer le lien symbolique node_modules:', err.message);
        }
      }

      // Utiliser fork pour exécuter le script Node.js avec le même runtime que le processus parent
      mcpServerProcess = fork(mcpServerPath, [], {
        cwd: mcpServerCwd, // Définir le cwd à app.asar.unpacked pour que Node trouve les modules
        env: {
          ...process.env,
          PORT: serverPort,
          MCP_REMOTE_URL: store.get('mcp-url'),
          MCP_API_KEY: store.get('mcp-api-key'),
          NODE_PATH: nodeModulesPath,
          OUTPUT_PATH: getOutputPath() // Passer le chemin de sortie au MCP server
        },
        silent: false,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      if (mcpServerProcess.stdout) {
        mcpServerProcess.stdout.on('data', (data) => {
          console.log('[MCP]', data.toString());
        });
      }

      if (mcpServerProcess.stderr) {
        mcpServerProcess.stderr.on('data', (data) => {
          const output = data.toString();
          console.log('[MCP Log]', output);

          if (output.includes('Serveur MCP local démarré')) {
            resolve();
          }
        });
      }

      mcpServerProcess.on('error', (error) => {
        console.error('Erreur MCP:', error);
        reject(error);
      });

      mcpServerProcess.on('exit', (code) => {
        console.log(`Serveur MCP terminé avec le code ${code}`);
      });

      // Timeout de 3 secondes
      setTimeout(() => {
        if (mcpServerProcess && mcpServerProcess.exitCode === null) {
          resolve();
        }
      }, 3000);

    } catch (error) {
      reject(error);
    }
  });
}

// Arrêter les serveurs
function stopServers() {
  if (serverProcess) {
    console.log('Arrêt du serveur local...');
    serverProcess.kill();
    serverProcess = null;
  }
  
  if (mcpServerProcess) {
    console.log('Arrêt du serveur MCP...');
    mcpServerProcess.kill();
    mcpServerProcess = null;
  }
}

// IPC Handlers existants
ipcMain.handle('start-servers', async () => {
  try {
    await startLocalServer();
    await startMCPServer();
    return { success: true, port: serverPort };
  } catch (error) {
    console.error('Erreur démarrage serveurs:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-servers', async () => {
  stopServers();
  return { success: true };
});

ipcMain.handle('get-server-status', async () => {
  return {
    serverRunning: serverProcess !== null && serverProcess.exitCode === null,
    mcpRunning: mcpServerProcess !== null && mcpServerProcess.exitCode === null,
    port: serverPort
  };
});

ipcMain.handle('open-manifest-location', async () => {
  try {
    const manifestDir = path.dirname(manifestPath);
    shell.openPath(manifestDir);
    return { success: true, path: manifestPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('copy-manifest-path', async () => {
  try {
    const { clipboard } = require('electron');
    clipboard.writeText(manifestPath);
    return { success: true, path: manifestPath };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('show-manifest-instructions', async () => {
  const instructions = `
📋 INSTALLATION DU COMPLÉMENT WORD

Pour installer le complément Word, suivez ces étapes :

1️⃣ COPIER LE CHEMIN DU MANIFEST
   Le chemin est : ${manifestPath}
   (Vous pouvez cliquer sur "Copier le chemin" dans l'application)

2️⃣ OUVRIR WORD
   Lancez Microsoft Word sur votre ordinateur

3️⃣ ACCÉDER AUX COMPLÉMENTS
   • Allez dans Fichier > Options > Centre de gestion de la confidentialité
   • Cliquez sur "Paramètres du Centre de gestion de la confidentialité"
   • Sélectionnez "Catalogues de compléments approuvés" dans le menu de gauche

4️⃣ AJOUTER LE DOSSIER
   • Collez le chemin dans "URL du catalogue"
   • Cochez "Afficher dans le menu"
   • Cliquez sur "Ajouter un catalogue"
   • Cliquez sur OK

5️⃣ INSÉRER LE COMPLÉMENT
   • Dans Word, allez dans Insertion > Compléments
   • Cliquez sur "DOSSIER PARTAGÉ"
   • Sélectionnez "PieceMaker Word Assistant"
   • Cliquez sur "Ajouter"

✅ Le complément est maintenant installé et accessible via Insertion > Mes compléments
`;

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Instructions d\'installation',
    message: 'Comment installer le complément Word',
    detail: instructions,
    buttons: ['OK', 'Copier le chemin'],
    defaultId: 0,
    cancelId: 0
  }).then(result => {
    if (result.response === 1) {
      const { clipboard } = require('electron');
      clipboard.writeText(manifestPath);
    }
  });

  return { success: true };
});

ipcMain.handle('get-addon-path', () => {
  return addonPath;
});

ipcMain.handle('open-url', async (event, url) => {
  shell.openExternal(url);
  return { success: true };
});

// Obtenir le chemin de sortie configuré
function getOutputPath() {
  const defaultPath = path.join(__dirname, '..', 'output');
  return config.getOutputPath(defaultPath);
}

// Ouvrir le dossier output/ressources
ipcMain.handle('open-output-folder', async () => {
  try {
    const outputPath = path.join(getOutputPath(), 'ressources');

    console.log('📂 Ouverture du dossier:', outputPath);

    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
      console.log('✅ Dossier créé:', outputPath);
    }

    // Ouvrir le dossier dans l'explorateur
    const result = await shell.openPath(outputPath);

    if (result === '') {
      // Succès (openPath retourne une string vide en cas de succès)
      return { success: true, path: outputPath };
    } else {
      // Erreur
      console.error('❌ Erreur openPath:', result);
      return { success: false, error: result };
    }
  } catch (error) {
    console.error('❌ Erreur ouverture dossier output:', error);
    return { success: false, error: error.message };
  }
});

// Obtenir la configuration du chemin de sortie
ipcMain.handle('get-output-path', async () => {
  try {
    const outputPath = getOutputPath();
    return { success: true, path: outputPath };
  } catch (error) {
    console.error('❌ Erreur récupération chemin output:', error);
    return { success: false, error: error.message };
  }
});

// Définir un nouveau chemin de sortie
ipcMain.handle('set-output-path', async (event, newPath) => {
  try {
    // Vérifier que le chemin est valide
    if (!newPath || typeof newPath !== 'string') {
      return { success: false, error: 'Chemin invalide' };
    }

    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }

    // Sauvegarder la configuration
    config.setOutputPath(newPath);

    console.log('✅ Nouveau chemin de sortie défini:', newPath);
    return { success: true, path: newPath };
  } catch (error) {
    console.error('❌ Erreur définition chemin output:', error);
    return { success: false, error: error.message };
  }
});

// Fonction pour copier récursivement un dossier
function copyDirectoryRecursive(source, destination) {
  // Créer le dossier destination s'il n'existe pas
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      // Copier récursivement les sous-dossiers
      copyDirectoryRecursive(sourcePath, destPath);
    } else {
      // Copier le fichier (seulement s'il n'existe pas déjà)
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`  ✓ Copié: ${entry.name}`);
      }
    }
  }
}

// Sélectionner un nouveau dossier de sortie via dialog
ipcMain.handle('select-output-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Sélectionner le dossier de sortie',
      defaultPath: getOutputPath()
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const selectedPath = result.filePaths[0];
    const oldOutputPath = getOutputPath();

    // Copier tout le contenu de l'ancien dossier output vers le nouveau
    console.log('📦 Copie du contenu de output vers le nouveau dossier...');
    console.log(`  Source: ${oldOutputPath}`);
    console.log(`  Destination: ${selectedPath}`);

    try {
      if (fs.existsSync(oldOutputPath)) {
        copyDirectoryRecursive(oldOutputPath, selectedPath);
        console.log('✅ Contenu copié avec succès');
      } else {
        console.log('⚠️ Dossier source introuvable, création du nouveau dossier vide');
        // Créer le dossier ressources dans le nouveau chemin
        const ressourcesPath = path.join(selectedPath, 'ressources');
        if (!fs.existsSync(ressourcesPath)) {
          fs.mkdirSync(ressourcesPath, { recursive: true });
        }
      }
    } catch (copyError) {
      console.error('❌ Erreur lors de la copie:', copyError);
      return {
        success: false,
        error: `Erreur lors de la copie des fichiers: ${copyError.message}`
      };
    }

    // Sauvegarder la configuration
    config.setOutputPath(selectedPath);

    console.log('✅ Nouveau dossier sélectionné:', selectedPath);
    return { success: true, path: selectedPath };
  } catch (error) {
    console.error('❌ Erreur sélection dossier:', error);
    return { success: false, error: error.message };
  }
});

// Store handlers
ipcMain.handle('store-get', (event, key) => {
  return store.get(key);
});

ipcMain.handle('store-set', (event, key, value) => {
  store.set(key, value);
  return { success: true };
});

ipcMain.handle('store-delete', (event, key) => {
  store.delete(key);
  return { success: true };
});

// ============================================
// NOUVEAUX HANDLERS POUR LES MISES À JOUR
// ============================================

// Vérifier les mises à jour
ipcMain.handle('check-for-updates', async () => {
  try {
    const updateInfo = await updateManager.checkForUpdates();
    return { success: true, update: updateInfo };
  } catch (error) {
    console.error('[Update] Erreur vérification:', error);
    return { success: false, error: error.message };
  }
});

// Télécharger et installer la mise à jour
ipcMain.handle('install-update', async (event, updateInfo) => {
  try {
    // Arrêter les serveurs avant la mise à jour
    stopServers();

    const success = await updateManager.downloadOnly(updateInfo, (progress) => {
      // Envoyer la progression au renderer
      if (mainWindow) {
        mainWindow.webContents.send('update-progress', progress);
      }
    });

    if (success) {
      // Enregistrer la mise à jour en attente
      store.set('pending-update', updateInfo);
      console.log('[Update] MAJ enregistrée pour application au prochain démarrage');
      
      return { success: true, needsRestart: true };
    }

    return { success: false };
  } catch (error) {
    console.error('[Update] Erreur installation:', error);
    return { success: false, error: error.message };
  }
});

// Ignorer une mise à jour
ipcMain.handle('skip-update', async (event, version) => {
  try {
    store.set('skipped-update-version', version);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Obtenir la version actuelle de l'addon
ipcMain.handle('get-addon-version', async () => {
  try {
    const version = updateManager.getInstalledVersion();
    return { success: true, version };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Redémarrer l'application
ipcMain.handle('restart-app', async () => {
  try {
    stopServers();
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


app.whenReady().then(async () => {
  // Vérifier et appliquer une MAJ en attente AVANT de démarrer
  const pendingUpdate = store.get('pending-update');
  if (pendingUpdate) {
    console.log('[Update] Application de la MAJ en attente...');
    try {
      await updateManager.applyPendingUpdate(pendingUpdate);
      store.delete('pending-update');
      console.log('[Update] MAJ appliquée avec succès');
    } catch (error) {
      console.error('[Update] Erreur application MAJ:', error);
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

const os = require('os');

// ============================================
// INSTALLATION AUTOMATIQUE
// ============================================

ipcMain.handle('auto-install-manifest', async () => {
  try {
    // Vérifier que le manifest existe
    if (!fs.existsSync(manifestPath)) {
      return {
        success: false,
        error: 'Le fichier manifest.xml est introuvable'
      };
    }

    // Lancer office-addin-debugging pour installer le manifest
    return new Promise((resolve) => {
      // Déterminer le chemin du CLI office-addin-debugging
      const officeAddinDebuggingCli = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'office-addin-debugging', 'cli.js')
        : path.join(__dirname, 'node_modules', 'office-addin-debugging', 'cli.js');

      console.log('📍 Chemin office-addin-debugging CLI:', officeAddinDebuggingCli);
      console.log('📍 Chemin manifest:', manifestPath);

      // Vérifier que le CLI existe
      if (!fs.existsSync(officeAddinDebuggingCli)) {
        resolve({
          success: false,
          error: `CLI office-addin-debugging introuvable: ${officeAddinDebuggingCli}`
        });
        return;
      }

      // Utiliser fork pour exécuter le CLI avec Node.js intégré
      const installProcess = fork(officeAddinDebuggingCli, ['start', manifestPath, 'desktop'], {
        cwd: app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked')
          : __dirname,
        env: {
          ...process.env,
          NODE_PATH: app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
            : path.join(__dirname, 'node_modules')
        },
        silent: false,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      let output = '';
      let errorOutput = '';
      let resolved = false;

      // Fonction pour résoudre une seule fois
      const resolveOnce = (result) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      if (installProcess.stdout) {
        installProcess.stdout.on('data', (data) => {
          const text = data.toString();
          output += text;
          console.log(`[Office Addin Debugging] ${text}`);

          // Détecter le succès dans les logs (sans attendre la fin du processus)
          if (text.includes('Debugging is being started') ||
              text.includes('Add-in registered') ||
              text.includes('Sideloading completed') ||
              text.includes('Dev server running')) {

            console.log('✅ Installation détectée comme réussie');

            // Attendre 2 secondes puis résoudre (laisser le temps à l'installation de se finaliser)
            setTimeout(() => {
              resolveOnce({
                success: true,
                message: 'Add-in installé avec succès',
                path: manifestPath,
                details: 'Le complément est maintenant disponible dans Word. Word devrait s\'ouvrir automatiquement.'
              });
            }, 2000);
          }
        });
      }

      if (installProcess.stderr) {
        installProcess.stderr.on('data', (data) => {
          const text = data.toString();
          errorOutput += text;
          console.error(`[Office Addin Debugging Error] ${text}`);

          // Détecter les erreurs critiques
          if (text.toLowerCase().includes('error') &&
              text.toLowerCase().includes('cannot') ||
              text.toLowerCase().includes('failed')) {
            resolveOnce({
              success: false,
              error: `Erreur détectée: ${text.substring(0, 200)}`
            });
          }
        });
      }

      installProcess.on('error', (error) => {
        console.error('❌ Erreur installation manifest:', error);
        resolveOnce({
          success: false,
          error: `Erreur: ${error.message}`
        });
      });

      // Timeout de 15 secondes - si aucun message de succès n'est détecté
      setTimeout(() => {
        if (!resolved) {
          console.log('⏱️ Timeout atteint - vérification du statut...');

          // Si aucune erreur n'a été détectée, considérer comme succès partiel
          if (!errorOutput || errorOutput.trim().length === 0) {
            resolveOnce({
              success: true,
              message: 'Installation en cours (timeout atteint mais aucune erreur détectée)',
              path: manifestPath,
              details: 'Le complément devrait être disponible dans Word. Vérifiez dans Insertion > Mes compléments > DOSSIER PARTAGÉ'
            });
          } else {
            resolveOnce({
              success: false,
              error: `Timeout: ${errorOutput || 'L\'installation a pris trop de temps'}`
            });
          }
        }
      }, 15000);
    });

  } catch (error) {
    console.error('Erreur installation manifest:', error);
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.handle('install-ssl-certificates', async () => {
  try {
    const platform = process.platform;
    
    if (platform !== 'win32') {
      return {
        success: false,
        error: 'Seul Windows est supporté pour l\'instant'
      };
    }
    
    const caCertPath = path.join(__dirname, '..', 'certificates', 'piecemaker-ca.crt');
    
    console.log('📁 Chemin CA:', caCertPath);
    
    if (!fs.existsSync(caCertPath)) {
      return {
        success: false,
        error: 'Certificat CA introuvable',
        certPath: caCertPath
      };
    }
    
    // ============================================
    // MÉTHODE 1 : Ouverture directe du certificat (L'utilisateur clique "Installer")
    // ============================================
    console.log('🔐 Ouverture du certificat pour installation manuelle guidée...');

    // Ouvrir directement le certificat avec l'assistant Windows
    const openResult = await shell.openPath(caCertPath);

    if (openResult !== '') {
      // Erreur lors de l'ouverture
      console.error('❌ Impossible d\'ouvrir le certificat:', openResult);
      return {
        success: false,
        needsManualInstall: true,
        message: 'Impossible d\'ouvrir automatiquement le certificat',
        certPath: caCertPath,
        manualInstructions: [
          '📋 INSTALLATION MANUELLE (3 clics):',
          '',
          '1️⃣ Naviguez vers ce dossier et double-cliquez sur piecemaker-ca.crt:',
          `   ${path.dirname(caCertPath)}`,
          '',
          '2️⃣ Cliquez sur "Installer le certificat..."',
          '',
          '3️⃣ Sélectionnez "Utilisateur actuel" → Suivant',
          '',
          '4️⃣ Choisissez "Placer tous les certificats dans le magasin suivant"',
          '',
          '5️⃣ Cliquez sur "Parcourir..." → "Autorités de certification racines de confiance"',
          '',
          '6️⃣ Suivant → Terminer → Acceptez l\'avertissement de sécurité',
          '',
          '⚠️ Redémarrez Word après l\'installation'
        ]
      };
    }

    // Le certificat a été ouvert - l'utilisateur va maintenant suivre l'assistant
    return {
      success: true,
      message: 'Assistant d\'installation du certificat ouvert',
      method: 'Assistant Windows',
      certPath: caCertPath,
      instructions: [
        '📝 L\'assistant d\'installation du certificat est maintenant ouvert',
        '',
        '👉 Suivez ces étapes:',
        '   1. Cliquez sur "Installer le certificat..."',
        '   2. Sélectionnez "Utilisateur actuel" → Suivant',
        '   3. Choisissez "Placer tous les certificats dans le magasin suivant"',
        '   4. Cliquez "Parcourir..." → Sélectionnez "Autorités de certification racines de confiance"',
        '   5. Suivant → Terminer → Acceptez l\'avertissement',
        '',
        '⚠️ Redémarrez Word pour que les changements prennent effet'
      ]
    };
    
  } catch (error) {
    console.error('❌ Erreur globale:', error);
    return { 
      success: false, 
      error: error.message,
      certPath: caCertPath
    };
  }
});
// Ouvrir le certificat directement (lance l'assistant Windows)
ipcMain.handle('open-certificate', async (event, certPath) => {
  try {
    // Ouvrir le fichier avec l'application par défaut (= assistant certificat Windows)
    const result = await shell.openPath(certPath);
    
    // Si result est une string vide, ça a marché
    // Si result contient une erreur, ça a échoué
    if (result === '') {
      console.log('✅ Certificat ouvert avec succès');
      return { success: true };
    } else {
      console.error('❌ Erreur ouverture:', result);
      // Fallback : ouvrir le dossier si l'ouverture directe échoue
      shell.showItemInFolder(certPath);
      return { success: true, fallback: true };
    }
  } catch (error) {
    console.error('❌ Erreur ouverture certificat:', error);
    return { success: false, error: error.message };
  }
});

// Installer la config Claude Desktop
ipcMain.handle('auto-install-claude-config', async () => {
  try {
    const platform = process.platform;
    let configPath;
    
    // Déterminer le chemin de configuration selon l'OS
    if (platform === 'win32') {
      configPath = path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
    } else if (platform === 'darwin') {
      configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    } else {
      return { success: false, error: 'Plateforme non supportée' };
    }
    
    // Créer le dossier s'il n'existe pas
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    // Charger la config existante ou créer une nouvelle
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
      } catch (parseError) {
        console.warn('Config existante invalide, création d\'une nouvelle');
      }
    }
    
    // Ajouter le serveur MCP
    if (!config.mcpServers) {
      config.mcpServers = {};
    }
    
    // Pour Claude Desktop, on doit pointer vers l'exécutable Electron en mode fork
    // Sur Windows, on peut utiliser l'exécutable de l'app pour exécuter le script
    const nodePath = app.isPackaged && process.platform === 'win32'
      ? process.execPath
      : 'node';

    config.mcpServers['PieceMaker'] = {
      command: nodePath,
      args: [mcpServerPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1' // Important: fait tourner Electron comme Node.js
      }
    };
    
    // Sauvegarder la config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    
    return { 
      success: true, 
      message: 'Configuration Claude Desktop mise à jour',
      path: configPath,
      serverPath: mcpServerPath
    };
    
  } catch (error) {
    console.error('Erreur installation config Claude:', error);
    return { success: false, error: error.message };
  }
});

// Obtenir les chemins d'installation
ipcMain.handle('get-install-paths', () => {
  const platform = process.platform;
  let wordTemplatePath;

  if (platform === 'win32') {
    wordTemplatePath = path.join(process.env.APPDATA, 'Microsoft', 'Templates');
  } else if (platform === 'darwin') {
    wordTemplatePath = path.join(
      os.homedir(),
      'Library/Group Containers/UBF8T346G9.Office/User Content.localized/Templates.localized'
    );
  }

  return {
    platform,
    manifestPath,
    mcpServerPath,
    wordWefPath: platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef')
      : 'Registre Windows',
    claudeConfigPath: platform === 'win32'
      ? path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json')
      : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    wordTemplatePath
  };
});

app.on('window-all-closed', () => {
  stopServers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServers();
  
  // Vider le cache manifest pour forcer la vérification au prochain démarrage
  const cacheFile = path.join(app.getPath('userData'), 'manifest-cache.json');
  if (fs.existsSync(cacheFile)) {
    fs.unlinkSync(cacheFile);
    console.log('[Update] Cache manifest vidé à la fermeture');
  }
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  console.error('Erreur non capturée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesse rejetée non gérée:', promise, 'raison:', reason);
});

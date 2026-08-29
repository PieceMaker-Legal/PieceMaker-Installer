const express = require('express');
const https = require('https');
const { fileURLToPath } = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');
const { WebSocketServer } = require('ws');
const {
  describeUnknownWebSocketMessage,
  isWordToolResponse,
} = require('./lib/websocket-message-diagnostics.cjs');
const { Ollama } = require('ollama');
const { z } = require('zod');
const { createAdminRouter, isLocalOrigin } = require('./admin-routes.cjs');
const { refreshRegisteredCaseRules } = require('./case-instructions.cjs');
const { syncClaudeAssets } = require('./claude-assets.cjs');
const { installClaudeHooks } = require('./claude-hooks.cjs');
const { syncCentralMapping } = require('../piecemaker-plugin/scripts/lib/central-mapping.cjs');
const { convertToPdf, findSoffice } = require('./lib/office-to-pdf.cjs');
const {
  detectStampImage,
  stampDataUrl,
  stampedPiecesDirectory,
} = require('./lib/stamping.cjs');
const { isInside, resolveConfiguredLegalCaseFolder } = require('./workspace-paths.cjs');
const { injectAutoOpen } = require('./lib/docx-autoopen.cjs');
const { createWordPaneRegistry } = require('./lib/word-pane-registry.cjs');
const {
  ensureDevRegistration,
  launchWord,
  activateWord,
  showTaskpaneForDocument,
} = require('./lib/word-launcher.cjs');
const { ADDIN_ID } = require('./lib/docx-autoopen.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const PIECEMAKER_HOME = process.env.PIECEMAKER_HOME || path.join(os.homedir(), '.piecemaker');
const CONFIG_PATH = path.join(PIECEMAKER_HOME, 'config.json');
const PID_PATH = path.join(PIECEMAKER_HOME, 'server.pid');

require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });

function readUserConfig() {
  try {
    return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  } catch (error) {
    console.warn(`⚠️ Configuration ignorée (${CONFIG_PATH}) : ${error.message}`);
    return {};
  }
}

const userConfig = readUserConfig();
if (!process.env.PYTHON_PATH && userConfig.pythonPath) process.env.PYTHON_PATH = userConfig.pythonPath;

// Les règles sont des fichiers PieceMaker gérés : un démarrage après mise à
// jour doit propager le template courant à tous les dossiers déjà enregistrés,
// sans attendre que l'utilisateur les ré-enregistre un par un.
const refreshedCaseRules = refreshRegisteredCaseRules(REPO_ROOT, userConfig);
if (refreshedCaseRules.failed.length) {
  console.warn(`⚠️ ${refreshedCaseRules.failed.length} règle(s) de dossier n’ont pas pu être actualisées.`);
}

// Import anonymization module
const { createAnonymizationRoutes, anonymizationMappings } = require('../taskpane/modules/anonymization-server.cjs');
// Sigle → préfixe de code société (SA_1, SARL_1…), vocabulaire partagé avec le
// pipeline GLiNER (voir legal-forms.cjs / scan_utils.py).
const { detectCompanySigle } = require('./legal-forms.cjs');

// ─── Anonymisation de la voie MCP Word (read_doc / edit_doc) ───────────────
// Le volet Word passe par ce serveur. Il conserve son mapping applicatif pour
// que les résultats documentaires soient déjà codés et que les écritures dans
// Word rétablissent les vrais noms. Les appels LLM, eux, sont tous couverts par
// le proxy PII LiteLLM.
const {
  resolveConfiguredCaseMapping,
  resolveMappedPath,
  applyMapping,
  revertMapping,
} = require('../piecemaker-plugin/scripts/lib/mapping.cjs');

function caseMappingForDocument(docPath) {
  if (!docPath) return null;
  try {
    const located = resolveConfiguredCaseMapping(userConfig, docPath);
    return located && located.exists ? located : null;
  } catch {
    return null;
  }
}

// Applique récursivement une transformation de chaînes en préservant la forme
// (objets/tableaux/nombres/booléens intacts) — le résultat reste un payload MCP
// valide, on ne code que les chaînes à l'intérieur.
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

const anonymizeShape = (value, mapping) => mapStrings(value, (s) => applyMapping(s, mapping));
const deanonymizeShape = (value, reverseMapping) => mapStrings(value, (s) => revertMapping(s, reverseMapping));
// 🔍 LOG : Vérifier les variables d'environnement au démarrage
console.log('🔍 [SERVER.JS] Variables d\'environnement au démarrage:');
console.log('  MCP_URL:', process.env.MCP_URL);
console.log('  MCP_API_KEY:', process.env.MCP_API_KEY ? '***' + process.env.MCP_API_KEY.slice(-4) : 'UNDEFINED');
console.log('  Dossiers juridiques enregistrés:', Array.isArray(userConfig.caseFolders) ? userConfig.caseFolders.length : 0);

const app = express();
const PORT = Number(process.env.PORT || userConfig.port || 43098);
const HOST = process.env.PIECEMAKER_HOST || '127.0.0.1';

// PieceMaker n'a plus de « dossier racine » configurable : chaque dossier
// juridique est enregistré individuellement (caseFolders) et peut vivre
// n'importe où sur le poste. getWorkspacePath ne sert donc que de base neutre
// pour les rares chemins sans dossier juridique actif : la racine du disque
// (« / » sur macOS/Linux, « C:\ » sur Windows), volontairement non
// inscriptible — rien ne doit s'y écrire. Les données du cabinet vont sous
// ~/.piecemaker (voir getSystemDataPath).
function getWorkspacePath() {
  return path.parse(os.homedir()).root;
}

// Stockage des clients WebSocket connectés
const wordClients = new Set();

// Chaque volet possède un identifiant opaque, propre à son WebSocket. Le chemin
// sert à trouver le volet pendant open_doc et à choisir le mapping RGPD ; tous
// les appels ultérieurs routent par l'identifiant, jamais par le document actif.
const wordPaneRegistry = createWordPaneRegistry();

function docUrlToPath(docUrl) {
  if (!docUrl) return null;
  try {
    if (docUrl.startsWith('file:')) return path.resolve(fileURLToPath(docUrl));
    if (/^[a-z][a-z0-9+.-]*:/i.test(docUrl) && !/^[a-z]:[\\/]/i.test(docUrl)) return null;
    return path.resolve(docUrl);
  } catch { return null; }
}

function requestedDocumentPath(req) {
  const encoded = req.get('X-PieceMaker-Document');
  if (!encoded) return null;
  try {
    return docUrlToPath(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function getRequestPane(req) {
  const requestedDocPath = requestedDocumentPath(req);
  const paneId = req.get('X-PieceMaker-Pane') || null;
  const candidate = paneId ? wordPaneRegistry.getById(paneId) : null;
  const client = candidate && candidate.readyState === 1 ? candidate : null;
  return {
    // Le chemin annoncé par le volet fait autorité pour le mapping. Le chemin
    // envoyé par le MCP reste un diagnostic, jamais une clé de routage.
    docPath: client ? wordPaneRegistry.pathFor(client) : requestedDocPath,
    requestedDocPath,
    paneId,
    client,
  };
}
const MANIFEST_PATH = path.join(REPO_ROOT, 'taskpane', 'manifest.xml');

// Stockage des mappings d'anonymisation par document
// MOVED TO MODULE: const anonymizationMappings = new Map();
// Now imported from ./modules/anonymization-server.cjs

// 🔧 Fonction utilitaire pour enlever le BOM (Byte Order Mark) sur Windows
function stripBOM(content) {
  if (typeof content === 'string' && content.charCodeAt(0) === 0xFEFF) {
    return content.slice(1);
  }
  return content;
}

// 🔧 Fonction pour lire un fichier en enlevant le BOM
function readFileStripBOM(filePath, encoding = 'utf8') {
  const content = fs.readFileSync(filePath, encoding);
  return stripBOM(content);
}

// Chaque document Word est rattaché à l'unique dossier juridique qui le
// contient. Tous ses fichiers (Markdown, mappings, compilations, conversions,
// brouillons et pièces tamponnées) sont ensuite écrits dans ce même dossier.
const ORIGINALS_SUBFOLDER = 'pièces originales';
const DOSSIER_FOLDERS_FILE = 'dossier_folders.json';

// Données propres au cabinet — tampon, ressources, registre documentId→dossier :
// sous ~/.piecemaker, indépendamment de tout dossier juridique.
function getSystemDataPath(...segments) {
  return path.join(PIECEMAKER_HOME, ...segments);
}

// Migration ponctuelle : ces données vivaient sous <ancienne racine>/.piecemaker.
// On les recopie dans ~/.piecemaker quand elles n'y sont pas encore, pour ne pas
// perdre le tampon ou le registre d'un poste déjà installé.
function migrateLegacySystemData() {
  const legacyRoot = userConfig.workspacePath || userConfig.outputPath;
  if (!legacyRoot) return;
  try {
    const legacyDir = path.join(path.resolve(legacyRoot), '.piecemaker');
    if (!fs.existsSync(legacyDir)) return;
    if (path.resolve(legacyDir) === path.resolve(PIECEMAKER_HOME)) return;
    fs.mkdirSync(PIECEMAKER_HOME, { recursive: true });
    for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
      const target = path.join(PIECEMAKER_HOME, entry.name);
      if (fs.existsSync(target)) continue;
      fs.cpSync(path.join(legacyDir, entry.name), target, { recursive: true });
    }
  } catch (error) {
    console.warn('⚠️ Migration des données système vers ~/.piecemaker impossible:', error.message);
  }
}
migrateLegacySystemData();

function readDossierFolders() {
  try {
    const file = getSystemDataPath(DOSSIER_FOLDERS_FILE);
    return fs.existsSync(file) ? JSON.parse(readFileStripBOM(file, 'utf8')) : {};
  } catch (error) {
    console.warn('⚠️ Registre des dossiers de travail illisible:', error.message);
    return {};
  }
}

function rememberDossierFolder(documentId, folder) {
  if (!documentId || !folder) throw new Error('documentId et dossier de travail requis.');
  const legalCase = resolveConfiguredLegalCaseFolder(readUserConfig(), folder);
  const registry = readDossierFolders();
  if (registry[documentId] === legalCase) return legalCase;
  registry[documentId] = legalCase;
  const registryFile = getSystemDataPath(DOSSIER_FOLDERS_FILE);
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2), 'utf8');
  return legalCase;
}

function getDossierFolder(documentId) {
  return readDossierFolders()[documentId] || null;
}

function getOutputPath(documentId = null) {
  if (!documentId) return getWorkspacePath();
  const legalCase = getDossierFolder(documentId);
  if (!legalCase) {
    throw new Error(`Aucun dossier juridique actif pour ${documentId}. Enregistrez le document Word dans la racine PieceMaker.`);
  }
  return resolveConfiguredLegalCaseFolder(readUserConfig(), legalCase);
}

// Middleware pour parser le JSON

app.use(express.json({ limit: '5000mb' }));
app.use(express.urlencoded({ limit: '5000mb', extended: true }));

// CORS pour développement
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && isLocalOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization, X-Filename, X-Document-Id, X-PieceMaker-Document, X-PieceMaker-Pane');

  if (req.method === 'OPTIONS') {
    return origin && !isLocalOrigin(origin) ? res.sendStatus(403) : res.sendStatus(204);
  }
  next();
});

// Servir les fichiers statiques
// Le visualiseur HTML est généré par Graphify, qui cible vis-network 9.1.x.
// On sert localement la révision corrective compatible afin que le graphe reste
// utilisable hors ligne et que son iframe isolée ne dépende d'aucun CDN.
app.get('/admin/vendor/vis-network.min.js', (_req, res) => {
  res.sendFile(path.join(REPO_ROOT, 'node_modules', 'vis-network', 'standalone', 'umd', 'vis-network.min.js'));
});
app.use('/admin', express.static(path.join(REPO_ROOT, 'admin'), { index: 'index.html' }));
app.use('/api/admin', createAdminRouter({
  repoRoot: REPO_ROOT,
  homeDir: PIECEMAKER_HOME,
  getRuntimeStatus: () => ({
    wordClients: wordClients.size,
    port: PORT,
    host: HOST,
    libreOffice: libreOfficeAvailable(),
    terminalReady: Boolean(pty),
  }),
}));

// Les composants du dépôt sont enregistrés directement dans ~/.claude au
// démarrage, sans manifest ni marketplace PieceMaker.
try {
  const sync = syncClaudeAssets(REPO_ROOT);
  console.log(`Claude Code : ${sync.registered} skill(s)/agent(s) enregistré(s)`
    + (sync.conflicts.length ? `, ${sync.conflicts.length} conflit(s) de nom dans ~/.claude` : ''));
  const hooks = installClaudeHooks(REPO_ROOT, os.homedir());
  if (!hooks.ok) console.warn('Enregistrement des hooks auprès de Claude Code impossible :', hooks.reason);
  else if (hooks.cleanup?.removed || hooks.cleanup?.deletedFile) {
    console.log(`Anciens hooks de mapping retirés : ${hooks.cleanup.removed} branchement(s)`
      + (hooks.cleanup.deletedFile ? ', script global supprimé' : ''));
  }
} catch (error) {
  console.warn('Enregistrement des composants auprès de Claude Code impossible :', error.message);
}

// Mapping central du proxy : fusion dé-conflictée de tous les dossiers. Le proxy
// le recharge à chaud ; aucun hook Claude Code n'est nécessaire.
try {
  const central = syncCentralMapping(userConfig);
  const entities = central && typeof central.entities === 'number' ? central.entities : 0;
  console.log(`Proxy PII : mapping central reconstruit (${entities} entité(s))`);
} catch (error) {
  console.warn('Reconstruction du mapping central impossible :', error.message);
}

// LibreOffice sert à convertir les pièces Excel/Word en PDF avant tamponnage.
// La détection lance un processus : on ne la fait qu'une fois.
let sofficeAvailable;
function libreOfficeAvailable() {
  if (sofficeAvailable === undefined) sofficeAvailable = Boolean(findSoffice());
  return sofficeAvailable;
}
app.use(express.static(path.join(__dirname, '..', 'taskpane')));

// Logs des requÃªtes
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// ============================================
// ANONYMIZATION ROUTES (MODULE)
// ============================================
// Mount anonymization routes from module
// Routes: GET/PUT/DELETE /api/anonymize/mapping/:documentId
//         GET/DELETE /api/anonymize/files/:documentId
//         POST /api/anonymize/text
app.use('/api/anonymize', createAnonymizationRoutes(getOutputPath));

app.get('/api/mcp-config', (req, res) => {
  const config = {
    url: process.env.MCP_URL,
    apiKey: process.env.MCP_API_KEY,
  };

  console.log('🔍 [SERVER.JS] /api/mcp-config appelé, retour:', {
    url: config.url,
    apiKey: config.apiKey ? '***' + config.apiKey.slice(-4) : 'UNDEFINED'
  });

  res.json(config);
});
// Proxy pour Anthropic Claude API (avec support streaming)
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({ error: 'API key manquante' });
    }

    const isStreaming = req.body.stream === true;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    if (!response.ok) {
      const data = await response.json();
      return res.status(response.status).json(data);
    }

    // âœ… Mode streaming : transférer le stream SSE au client
    if (isStreaming) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Transférer le stream directement
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          console.error('Stream aborted:', err);
          res.end();
        }
      }));

    } else {
      // Mode non-streaming : réponse JSON classique
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error('Erreur proxy Claude:', error);
    res.status(500).json({ error: error.message });
  }
});

// Proxy pour OpenAI API
app.post('/api/openai', async (req, res) => {
  try {
    const apiKey = req.headers['authorization'];

    if (!apiKey) {
      return res.status(401).json({ error: 'API key manquante' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error('Erreur proxy OpenAI:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/mistral', async (req, res) => {
    console.log('ðŸŒ [SERVER] RequÃªte Mistral reÃ§ue');
    console.log('ðŸ“¦ [SERVER] stream:', req.body.stream);
    
    try {
        const apiKey = req.headers.authorization?.replace('Bearer ', '');
        const payload = req.body;  // âœ… NE PAS destructurer {stream, ...payload}
        
        console.log('ðŸ“¡ [SERVER] Payload vers Mistral:', {
            model: payload.model,
            stream: payload.stream,
            messages: payload.messages?.length
        });

        const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(payload)  // âœ… Envoyer TOUT le payload avec stream:true
        });

        console.log('ðŸ“¥ [SERVER] Réponse Mistral:', response.status);
        console.log('ðŸ“„ [SERVER] Content-Type:', response.headers.get('content-type'));

        if (!response.ok) {
            const error = await response.json();
            console.error('âŒ [SERVER] Erreur:', error);
            return res.status(response.status).json(error);
        }

        // âœ… VÃ‰RIFIER si c'est vraiment du streaming
        const contentType = response.headers.get('content-type');
        console.log('ðŸ” [SERVER] Content-Type détecté:', contentType);

        if (contentType && contentType.includes('text/event-stream')) {
            console.log('ðŸ”„ [SERVER] Mode STREAMING détecté');
            
            // âœ… Headers SSE
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // â† Important pour nginx

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let chunkCount = 0;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        res.end();
                        break;
                    }

                    chunkCount++;
                    const chunk = decoder.decode(value, { stream: true });
                    
                    // âœ… Relayer directement
                    res.write(chunk);
                }
            } catch (err) {
                console.error('âŒ [SERVER] Erreur streaming:', err);
                res.end();
            }
        } else {
            // Non-streaming
            console.log('ðŸ“„ [SERVER] Mode NON-STREAMING');
            const data = await response.json();
            console.log('âœ… [SERVER] Réponse JSON:', {
                id: data.id,
                model: data.model,
                choices: data.choices?.length
            });
            res.json(data);
        }
    } catch (error) {
        console.error('âŒ [SERVER] Erreur:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy pour Ollama API (local)
app.post('/api/ollama', async (req, res) => {
  try {
    const ollamaUrl = req.body.ollamaUrl || 'http://localhost:11434';
    const endpoint = `${ollamaUrl}/api/chat`;
    const model = req.body.payload?.model;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body.payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error('Erreur proxy Ollama:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer la liste des modÃ¨les Ollama disponibles
app.get('/api/ollama/models', async (req, res) => {
  try {
    const ollamaUrl = req.query.url || 'http://localhost:11434';
    const endpoint = `${ollamaUrl}/api/tags`;

    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Ollama non disponible',
        models: []
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Erreur récupération modèles Ollama:', error);
    res.status(500).json({
      error: error.message,
      models: []
    });
  }
});


// Route de santé
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: PORT,
    wordClientsConnected: wordClients.size,
    wordPanesConnected: wordPaneRegistry.idCount
  });
});

// Attend qu'un volet PieceMaker soit connecté pour `docPath`, jusqu'à
// `timeoutMs`. Renvoie le WebSocket exact afin que open_doc puisse remettre son
// identifiant opaque au seul processus MCP appelant.
function waitForPane(timeoutMs, docPath) {
  const connectedPane = () => {
    const client = wordPaneRegistry.getByPath(docPath);
    return client && client.readyState === 1 ? client : null;
  };
  return new Promise((resolve) => {
    const existing = connectedPane();
    if (existing) return resolve(existing);
    const start = Date.now();
    const timer = setInterval(() => {
      const client = connectedPane();
      if (client) {
        clearInterval(timer);
        resolve(client);
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, 500);
  });
}

// Un volet peut survivre à « Enregistrer sous ». Avant de réutiliser une
// association chemin → volet pendant open_doc, lui demander son URL courante.
// Le volet répond par pane-hello ; le registre retire alors l'ancien chemin.
async function refreshPaneIdentityForPath(docPath, timeoutMs = 750) {
  const client = wordPaneRegistry.getByPath(docPath);
  if (!client || client.readyState !== 1) return false;

  const previousVersion = wordPaneRegistry.identityVersionFor(client);
  try {
    client.send(JSON.stringify({ type: 're-identify' }));
  } catch {
    wordPaneRegistry.remove(client);
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (wordPaneRegistry.identityVersionFor(client) > previousVersion) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Ouvre Word sur un document et fait apparaître automatiquement le volet
 * PieceMaker, sans clic manuel — c'est ce qui permet à une session extérieure
 * (Claude Code) d'écrire directement dans le document. Mécanisme :
 *   1. enregistrement « développeur » de l'add-in (une fois, idempotent) ;
 *   2. injection des parties webextension dans le .docx (idempotent) ;
 *   3. lancement de Word sur ce document (multi-plateforme) ;
 *   4. attente qu'un volet s'annonce.
 * Le fichier n'est modifié que par l'ajout des parties webextension : le
 * contenu visible du document est inchangé. Voir lib/docx-autoopen.cjs et
 * lib/word-launcher.cjs.
 */
app.post('/api/word/open-doc', async (req, res) => {
  try {
    const docPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!docPath) {
      return res.status(400).json({ error: 'Paramètre « path » requis (chemin du document .docx).' });
    }
    const requested = path.resolve(docPath);
    let resolved = requested;
    // Défense en profondeur : le chemin peut porter des codes d'anonymisation
    // (le modèle ne voit que des noms codés). Si le chemin littéral n'existe
    // pas, on cherche la variante canonique puis l'unique nom présent qui
    // s'anonymise vers le nom demandé. Le hook PreToolUse le fait normalement
    // en amont, mais un appel MCP direct peut le contourner.
    if (!fs.existsSync(requested)) {
      const lc = caseMappingForDocument(requested);
      if (lc) resolved = path.resolve(resolveMappedPath(requested, lc.mapping, lc.reverse_mapping));
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `Document introuvable : ${resolved}` });
    }
    if (!resolved.toLowerCase().endsWith('.docx')) {
      return res.status(400).json({
        error: 'Seuls les fichiers .docx sont supportés pour l\'ouverture automatique du volet (les .doc/.pdf doivent d\'abord être convertis).',
      });
    }

    // 1. Un seul manifeste/add-in est enregistré. Word crée une instance du
    // volet dans chaque document ; leur WebSocket et leur chemin permettent de
    // les distinguer côté serveur.
    await ensureDevRegistration(MANIFEST_PATH, ADDIN_ID);

    // 2. Injection des parties d'auto-ouverture avec l'unique GUID PieceMaker.
    try {
      await injectAutoOpen(resolved);
    } catch (err) {
      return res.status(422).json({
        error: `Impossible de préparer le document (n'est peut-être pas un .docx valide) : ${err.message}`,
      });
    }

    // Un volet déjà associé à ce chemin peut avoir fait « Enregistrer sous ».
    // Rafraîchir son identité avant de décider qu'il s'agit du bon document.
    await refreshPaneIdentityForPath(resolved);

    // 3. Lancement de Word sur ce document, mise au premier plan.
    const launch = launchWord(resolved);
    if (!launch.launched) {
      return res.status(500).json({ error: `Échec du lancement de Word : ${launch.error || 'inconnu'}` });
    }
    activateWord();

    // 4. Attente de la disponibilité d'un volet. Word pour Mac peut ignorer
    // l'auto-ouverture du deuxième document pour un même manifeste. Après un
    // délai de grâce, déclencher le bouton ShowTaskpane du manifeste dans la
    // bonne fenêtre permet plusieurs volets avec toujours un seul manifeste.
    const timeoutMs = Number(req.body?.timeoutMs) > 0 ? Number(req.body.timeoutMs) : 45000;
    const startedWaitingAt = Date.now();
    const autoOpenGraceMs = Math.min(10000, Math.max(1000, Math.floor(timeoutMs / 3)));
    let paneClient = await waitForPane(autoOpenGraceMs, resolved);
    if (!paneClient && process.platform === 'darwin') {
      showTaskpaneForDocument(resolved);
      const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedWaitingAt));
      if (remainingMs > 0) paneClient = await waitForPane(remainingMs, resolved);
    }
    if (!paneClient) {
      return res.status(504).json({
        error: 'Exécutez `piecemaker restart`, puis rappelez `open_doc`.',
      });
    }

    return res.json({ paneId: wordPaneRegistry.idFor(paneClient) });
  } catch (error) {
    console.error('Erreur /api/word/open-doc:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Endpoints pour les outils Word (appelés par Claude Desktop via MCP)

app.post('/api/word/edit', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      },  430980); // 30 secondes pour les opérations d'édition

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'edit_file',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/edit:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/word/search-case', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000); // 60 secondes pour les modifications batch

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);

            // ✅ Ajouter le warning système pour read_case
            let result = response.result;
            if (typeof result === 'string') {
              result = '<system-rule>Edit_doc requires at least one Markdown footnote citation from read_case, recherche_code, or recherche_jurisprudence: use [^id] in the text and a separate [^id]: source definition in the same edit payload.</system-rule>\n\n' + result;
            } else if (typeof result === 'object') {
              result = {
                ...result,
                system_rule: 'Edit_doc requires at least one Markdown footnote citation from read_case, recherche_code, or recherche_jurisprudence: use [^id] in the text and a separate [^id]: source definition in the same edit payload.'
              };
            }

            resolve(res.json(result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'read_case',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/search-case:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/workspace/register', (req, res) => {
  try {
    const { documentId, folder } = req.body || {};
    const legalCase = rememberDossierFolder(documentId, folder);
    res.json({ success: true, folder: legalCase });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ✨ NEW: Write extracted Markdown files to disk (used by the extraction task).
// The taskpane cannot write to the filesystem, so it POSTs the resolved folder
// (derived from the open Word document) + the markdown payloads here.
app.post('/api/extract/write-md', (req, res) => {
  try {
    const { folder, files, documentId } = req.body;

    if (!folder || typeof folder !== 'string') {
      return res.status(400).json({ error: 'Paramètre "folder" manquant' });
    }
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Paramètre "files" manquant ou vide' });
    }
    let legalCase;
    try {
      legalCase = rememberDossierFolder(documentId, folder);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const written = [];
    for (const f of files) {
      if (!f || !f.name) continue;
      // Sécurité: n'utiliser que le nom de base (pas de traversée de répertoire),
      // et forcer l'extension .md
      const base = path.basename(String(f.name)).replace(/\.[^.]+$/, '');
      const mdName = `${base}.md`;
      const target = path.join(legalCase, mdName);
      fs.writeFileSync(target, String(f.markdown || ''), 'utf8');
      written.push(mdName);
      console.log(`📝 Markdown écrit: ${target}`);
    }

    res.json({ success: true, folder: legalCase, written });
  } catch (error) {
    console.error('Erreur /api/extract/write-md:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✨ NEW: Read-doc endpoint
app.post('/api/word/read-doc', async (req, res) => {
  try {
    const { client, docPath } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000);

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            // Anonymisation à la lecture : le modèle ne doit jamais voir de nom
            // réel. On code le résultat via le mapping du dossier du document
            // actif — le résultat Word est codé avant de rejoindre la conversation.
            const legalCase = caseMappingForDocument(docPath);
            const result = legalCase
              ? anonymizeShape(response.result, legalCase.mapping)
              : response.result;
            resolve(res.json(result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'read_doc',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/read-doc:', error);
    res.status(500).json({ error: error.message });
  }
});

// ✨ NEW: Edit-doc endpoint
app.post('/api/word/edit-doc', async (req, res) => {
  try {
    const { client, docPath } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000);

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            // L'écho de confirmation reste codé pour le modèle.
            const legalCase = caseMappingForDocument(docPath);
            const result = legalCase
              ? anonymizeShape(response.result, legalCase.mapping)
              : response.result;
            resolve(res.json(result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      // Dé-anonymisation à l'écriture : le modèle a lu des codes, on rétablit les
      // vrais noms AVANT d'écrire dans Word — équivalent MCP de
      // la voie inverse du mapping Word. Sans cela, un code serait écrit tel quel dans le
      // document.
      const legalCaseOut = caseMappingForDocument(docPath);
      const outboundParams = legalCaseOut
        ? deanonymizeShape(params, legalCaseOut.reverse_mapping)
        : params;

      client.send(JSON.stringify({
        requestId,
        action: 'edit_doc',
        params: outboundParams
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/edit-doc:', error);
    res.status(500).json({ error: error.message });
  }
});

// Outil doc_styles — table des styles du document ciblé. Aucun binaire n'est lu
// ici : le volet interroge et redéfinit les styles du document déjà ouvert.
app.post('/api/word/doc-styles', async (req, res) => {
  try {
    const { client, docPath } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.off('message', messageHandler);
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000);

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            // Un style personnalisé peut porter le nom d'une partie : la table
            // rejoint la conversation codée, comme toute lecture Word.
            const legalCase = caseMappingForDocument(docPath);
            const result = legalCase
              ? anonymizeShape(response.result, legalCase.mapping)
              : response.result;
            resolve(res.json(result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      // Le modèle a lu des codes : on rétablit les vrais noms avant d'écrire
      // dans Word, comme pour edit_doc.
      const legalCaseOut = caseMappingForDocument(docPath);
      const outboundParams = legalCaseOut
        ? deanonymizeShape(params, legalCaseOut.reverse_mapping)
        : params;

      client.send(JSON.stringify({
        requestId,
        action: 'doc_styles',
        params: outboundParams
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/doc-styles:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Helper pour échapper les caractères spéciaux regex
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper pour créer une regex SIREN qui ignore les espaces
// Exemple: "801654908" matchera "801654908", "801 654 908", "801 654908", etc.
function createSirenRegex(siren) {
  // Enlever tous les espaces du SIREN source
  const cleanSiren = siren.replace(/\s/g, '');

  // Vérifier si c'est un SIREN (9 chiffres)
  if (!/^\d{9}$/.test(cleanSiren)) {
    return null; // Pas un SIREN valide
  }

  // Créer une regex qui accepte des espaces optionnels entre chaque chiffre
  const regexPattern = cleanSiren.split('').join('\\s*');
  return new RegExp(regexPattern, 'gi');
}

// Helper pour anonymiser du texte JSON avec un mapping donné
function anonymizeJsonContent(jsonString, mappingData) {
  let result = jsonString;

  for (const category of ['personnes_physiques', 'societes', 'adresses', 'siren']) {
    if (mappingData.mapping[category]) {
      for (const [entity, data] of Object.entries(mappingData.mapping[category])) {
        const code = data.code;
        const original = data.original;
        const variant = data.variant;

        // Traitement spécial pour les SIREN : ignorer les espaces
        if (category === 'siren') {
          if (original) {
            const sirenRegex = createSirenRegex(original);
            if (sirenRegex) {
              result = result.replace(sirenRegex, code);
            }
          }
          if (variant && variant !== original) {
            const sirenRegex = createSirenRegex(variant);
            if (sirenRegex) {
              result = result.replace(sirenRegex, code);
            }
          }
        } else {
          // Traitement normal pour les autres catégories
          if (original) {
            result = result.replace(new RegExp(escapeRegex(original), 'g'), code);
          }
          if (variant && variant !== original) {
            result = result.replace(new RegExp(escapeRegex(variant), 'g'), code);
          }
        }
      }
    }
  }

  return result;
}
// Récupérer le fichier de compilation ANONYMISÃ‰
app.get('/api/anonymize/compilation/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const outputDir = getOutputPath(documentId);

    const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
    const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

    // Vérifier si les fichiers existent
    if (!fs.existsSync(compilationPath)) {
      return res.status(404).json({ error: 'Fichier de compilation non trouvé' });
    }

    if (!fs.existsSync(mappingPath)) {
      return res.status(404).json({ error: 'Fichier de mapping non trouvé' });
    }

    // Charger les fichiers
    const compilationFile = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));
    const mappingData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));

    // Support pour l'ancien format (tableau) et nouveau format (objet avec informations_dossier)
    let compilationData;
    if (Array.isArray(compilationFile)) {
      // Ancien format - convertir vers nouveau format
      compilationData = {
        informations_dossier: {},
        documents: compilationFile
      };
    } else {
      // Nouveau format
      compilationData = compilationFile;
    }

    console.log('📄 [AVANT ANONYMISATION] Taille JSON:', JSON.stringify(compilationData).length, 'caractères');
    console.log('📄 [AVANT ANONYMISATION] Premier document:', compilationData.documents?.[0]?.filename);

    // Anonymiser le contenu de la compilation
    let compilationJson = JSON.stringify(compilationData);
    compilationJson = anonymizeJsonContent(compilationJson, mappingData);

    console.log('🔒 [APRÈS ANONYMISATION] Taille JSON:', compilationJson.length, 'caractères');
    console.log('🔒 [APRÈS ANONYMISATION] Extrait (100 premiers caractères):', compilationJson.substring(0, 100));

    // Retourner le JSON anonymisé
    res.json({
      content: JSON.parse(compilationJson),
      filename: `compilation_dossier_${documentId}.json`
    });

  } catch (error) {
    console.error('Erreur /api/anonymize/compilation:', error);
    res.status(500).json({ error: error.message });
  }
});// Route pour rechercher dans le dossier ou afficher sa structure
app.post('/api/anonymize/search/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const { 
      query, 
      show_structure, 
      date_debut, 
      date_fin,
      search_mode,
      read_full,
      edit
    } = req.body;
    
    const outputDir = getOutputPath(documentId);
    const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
    const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

    if (!fs.existsSync(compilationPath)) {
      return res.status(404).json({ error: 'Fichier de compilation non trouvé' });
    }

    if (!fs.existsSync(mappingPath)) {
      return res.status(404).json({ error: 'Fichier de mapping non trouvé' });
    }

    // Charger les fichiers
    const compilationData = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));
    const mappingData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));

    // ⭐ NOUVELLE LOGIQUE : Détecter la structure du fichier
    let documentsArray;
    let informationsDossier = null;
    
    if (Array.isArray(compilationData)) {
      // Ancienne structure : tableau direct
      documentsArray = compilationData;
    } else if (compilationData.documents && Array.isArray(compilationData.documents)) {
      // Nouvelle structure : objet avec documents et informations_dossier
      documentsArray = compilationData.documents;
      informationsDossier = compilationData.informations_dossier || null;
    } else {
      return res.status(500).json({ 
        error: 'Structure de fichier non reconnue. Attendu : tableau ou objet {documents: [...]}' 
      });
    }

    console.log(`🔍 [SEARCH] Document ID: ${documentId}, Mode: ${edit ? 'EDIT' : read_full ? 'READ_FULL' : show_structure ? 'STRUCTURE' : 'SEARCH'}`);

    // Fonction helper pour anonymiser un objet JSON (réutilise la logique de /api/anonymize/text)
    const anonymizeJsonData = (data, mappingData) => {
      let jsonString = JSON.stringify(data);
      jsonString = anonymizeJsonContent(jsonString, mappingData);
      return JSON.parse(jsonString);
    };

    // Anonymiser les documents
    const anonymizedData = anonymizeJsonData(documentsArray, mappingData);

    // Anonymiser les informations du dossier si disponibles
    let anonymizedInformationsDossier = null;
    if (informationsDossier) {
      anonymizedInformationsDossier = anonymizeJsonData(informationsDossier, mappingData);
      console.log('🔒 [ANONYMISATION] informations_dossier anonymisées');
    }

    // ========================================
    // MODE 1️⃣ : ÉDITION DE MÉTADONNÉES
    // ========================================
    if (edit && edit.id) {
      console.log(`✏️ [EDIT] Modification de la pièce ${edit.id}`);

      const pieceIndex = documentsArray.findIndex(p => p.id === edit.id);
      
      if (pieceIndex === -1) {
        return res.status(404).json({ error: `Pièce ${edit.id} introuvable` });
      }

      const piece = documentsArray[pieceIndex];

      // Mise à jour des champs modifiés
      if (edit.date_document !== undefined) {
        piece.date_document = edit.date_document;
        console.log(`  ✓ date_document: ${edit.date_document}`);
      }
      if (edit.type_document !== undefined) {
        piece.type_document = edit.type_document;
        console.log(`  ✓ type_document: ${edit.type_document}`);
      }
      if (edit.analyse !== undefined) {
        piece.analyse = edit.analyse;
        console.log(`  ✓ analyse: ${edit.analyse.substring(0, 50)}...`);
      }

      // ⭐ Sauvegarde avec la bonne structure
      const dataToSave = Array.isArray(compilationData) 
        ? documentsArray 
        : { informations_dossier: informationsDossier, documents: documentsArray };
      
      fs.writeFileSync(compilationPath, JSON.stringify(dataToSave, null, 2), 'utf8');

      return res.json({
        success: true,
        message: `Pièce ${edit.id} mise à jour`,
        piece: {
          id: piece.id,
          date_document: piece.date_document,
          type_document: piece.type_document,
          filename: piece.filename,
          analyse: piece.analyse
        }
      });
    }

    // ========================================
    // MODE 2️⃣ : LECTURE COMPLÈTE D'UNE OU PLUSIEURS PIÈCES
    // ========================================
    if (read_full && query) {
      // Support de plusieurs IDs séparés par des virgules (ex: "0001, 0002, 0003")
      const pieceIds = query.split(',').map(id => id.trim()).filter(id => id.length > 0);

      console.log(`📖 [READ_FULL] Lecture complète de ${pieceIds.length} pièce(s): ${pieceIds.join(', ')}`);

      const pieces = [];
      const notFound = [];
      const allWarnings = [];

      for (const pieceId of pieceIds) {
        const piece = anonymizedData.find(p => p.id === pieceId);

        if (!piece) {
          notFound.push(pieceId);
          continue;
        }

        const suggestions = [];

        if (!piece.date_document || piece.date_document === '' || piece.date_document === 'N/A') {
          suggestions.push({
            piece_id: pieceId,
            field: 'date_document',
            problem: 'Date manquante ou invalide',
            current_value: piece.date_document || 'vide',
            action: 'Extraire la date du texte_integral et proposer une correction via edit'
          });
        }

        if (!piece.type_document || piece.type_document === '' || piece.type_document === 'N/A') {
          suggestions.push({
            piece_id: pieceId,
            field: 'type_document',
            problem: 'Type de document manquant',
            current_value: piece.type_document || 'vide',
            action: 'Identifier le type (Jugement, Contrat, Courrier, Assignation, etc.) et proposer edit'
          });
        }

        if (!piece.analyse || piece.analyse === '' || piece.analyse === 'Aucune analyse disponible') {
          suggestions.push({
            piece_id: pieceId,
            field: 'analyse',
            problem: 'Analyse manquante',
            current_value: piece.analyse || 'vide',
            action: 'Générer : [Résumé concis] + [Points d\'attention] + [Créateur de droit: oui/non]'
          });
        }

        pieces.push(piece);

        if (suggestions.length > 0) {
          allWarnings.push(...suggestions);
        }
      }

      if (pieces.length === 0) {
        return res.status(404).json({
          error: `Aucune pièce trouvée parmi: ${pieceIds.join(', ')}`
        });
      }

      const response = {
        pieces
      };

      if (notFound.length > 0) {
        response.message = `${pieces.length}/${pieceIds.length} pièce(s) trouvée(s). Pièces introuvables: ${notFound.join(', ')}`;
      }

      return res.json(response);
    }

    // ========================================
    // MODE 3️⃣ : STRUCTURE COMPLÈTE
    // ========================================
    if (show_structure || (!query && !date_debut && !date_fin)) {
      const structure = anonymizedData.map(item => ({
        id: item.id,
        date_document: item.date_document,
        type_document: item.type_document,
        filename: item.filename,
        analyse: item.analyse || "Aucune analyse disponible"
      }));

      console.log(`📋 [STRUCTURE] Retour de ${structure.length} documents`);

      // ⭐ Ajouter les informations du dossier si disponibles (ANONYMISÉES)
      const responseData = {
        structure,
        total_documents: structure.length,
        message: "Structure du dossier. Options : read_full pour contenu complet, edit pour modifier métadonnées."
      };

      if (anonymizedInformationsDossier) {
        responseData.informations_dossier = anonymizedInformationsDossier;
        console.log('📋 [STRUCTURE] informations_dossier incluses (anonymisées)');
      }

      return res.json(responseData);
    }

    // ========================================
    // MODE 4️⃣ : RECHERCHE AVANCÉE
    // ========================================
    
    let filteredData = anonymizedData;

    if (date_debut || date_fin) {
      filteredData = anonymizedData.filter(item => {
        if (!item.date_document) return false;

        const itemDate = new Date(item.date_document);
        
        if (date_debut) {
          const startDate = new Date(date_debut);
          if (itemDate < startDate) return false;
        }

        if (date_fin) {
          const endDate = new Date(date_fin);
          if (itemDate > endDate) return false;
        }

        return true;
      });

      console.log(`📅 [DATE FILTER] ${anonymizedData.length} -> ${filteredData.length} documents`);
    }

    let results = filteredData;

    if (query) {
      const mode = search_mode || 'OU';
      
      if (mode === 'EXACTE') {
        const exactQuery = query.toLowerCase().replace(/^"|"$/g, '');
        
        results = filteredData.filter(item => {
          const searchableText = [
            item.texte_integral || '',
            item.analyse || '',
            item.filename || '',
            item.type_document || ''
          ].join(' ').toLowerCase();
          
          return searchableText.includes(exactQuery);
        });

        console.log(`🔍 [EXACTE] "${exactQuery}" -> ${results.length} résultat(s)`);

      } else {
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
        
        results = filteredData.filter(item => {
          const searchableText = [
            item.texte_integral || '',
            item.analyse || '',
            item.filename || '',
            item.type_document || ''
          ].join(' ').toLowerCase();

          if (mode === 'ET') {
            return keywords.every(kw => searchableText.includes(kw));
          } else {
            return keywords.some(kw => searchableText.includes(kw));
          }
        });

        console.log(`🔍 [${mode}] "${query}" (${keywords.length} mots) -> ${results.length} résultat(s)`);
      }
    }

    const formattedResults = results.map(item => ({
      id: item.id,
      date_document: item.date_document,
      type_document: item.type_document,
      analyse: item.analyse || "Aucune analyse disponible",
      filename: item.filename
    }));

    let message = '';
    const filters = [];
    
    if (date_debut || date_fin) {
      const dateRange = date_debut && date_fin 
        ? `entre ${date_debut} et ${date_fin}`
        : date_debut 
          ? `après ${date_debut}`
          : `avant ${date_fin}`;
      filters.push(`période: ${dateRange}`);
    }
    
    if (query) {
      const modeLabel = search_mode === 'ET' ? 'tous les mots' : search_mode === 'EXACTE' ? 'expression exacte' : 'au moins un mot';
      filters.push(`"${query}" (${modeLabel})`);
    }

    if (filters.length > 0) {
      message = `${formattedResults.length} document(s) trouvé(s) (${filters.join(', ')}). `;
    } else {
      message = `${formattedResults.length} document(s) dans le dossier. `;
    }
    
    message += "Options : read_full pour texte complet, edit pour modifier métadonnées.";

    res.json({
      query,
      search_mode: search_mode || 'OU',
      date_debut,
      date_fin,
      results: formattedResults,
      count: formattedResults.length,
      total_documents: anonymizedData.length,
      message
    });

  } catch (error) {
    console.error('❌ Erreur /api/anonymize/search:', error);
    res.status(500).json({ error: error.message });
  }
});

// Route pour récupérer un document spécifique par ID
app.get('/api/anonymize/document/:documentId/:itemId', (req, res) => {
  try {
    const { documentId, itemId } = req.params;

    const outputDir = getOutputPath(documentId);
    const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
    const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

    // Vérifier si les fichiers existent
    if (!fs.existsSync(compilationPath)) {
      return res.status(404).json({ error: 'Fichier de compilation non trouvé' });
    }

    if (!fs.existsSync(mappingPath)) {
      return res.status(404).json({ error: 'Fichier de mapping non trouvé' });
    }

    // Charger les fichiers
    const compilationFile = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));
    const mappingData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));

    // Support pour l'ancien format (tableau) et nouveau format (objet avec informations_dossier)
    let compilationData;
    if (Array.isArray(compilationFile)) {
      // Ancien format - convertir vers nouveau format
      compilationData = {
        informations_dossier: {},
        documents: compilationFile
      };
    } else {
      // Nouveau format
      compilationData = compilationFile;
    }

    console.log(`📄 [DOCUMENT] Recherche ID: ${itemId}`);

    // Anonymiser le contenu de la compilation
    let compilationJson = JSON.stringify(compilationData);
    compilationJson = anonymizeJsonContent(compilationJson, mappingData);

    const anonymizedData = JSON.parse(compilationJson);
    const document = anonymizedData.documents.find(item => item.id === itemId);

    if (!document) {
      return res.status(404).json({ error: `Document ID ${itemId} non trouvé dans le dossier` });
    }

    console.log(`✅ [DOCUMENT] Trouvé: ${document.filename}`);

    res.json({
      document,
      message: "Document complet récupéré avec succès"
    });

  } catch (error) {
    console.error('❌ Erreur /api/anonymize/document:', error);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer le fichier de compilation ANONYMISÉ (route dupliquée - TODO: À fusionner avec ligne 1446)
app.get('/api/anonymize/compilation/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const outputDir = getOutputPath(documentId);

    const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);
    const mappingPath = path.join(outputDir, `mapping_${documentId}.json`);

    // Vérifier si les fichiers existent
    if (!fs.existsSync(compilationPath)) {
      return res.status(404).json({ error: 'Fichier de compilation non trouvé' });
    }

    if (!fs.existsSync(mappingPath)) {
      return res.status(404).json({ error: 'Fichier de mapping non trouvé' });
    }

    // Charger les fichiers
    const compilationFile = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));
    const mappingData = JSON.parse(readFileStripBOM(mappingPath, 'utf8'));

    // Support pour l'ancien format (tableau) et nouveau format (objet avec informations_dossier)
    let compilationData;
    if (Array.isArray(compilationFile)) {
      // Ancien format - convertir vers nouveau format
      compilationData = {
        informations_dossier: {},
        documents: compilationFile
      };
    } else {
      // Nouveau format
      compilationData = compilationFile;
    }

    console.log('📄 [AVANT ANONYMISATION] Taille JSON:', JSON.stringify(compilationData).length, 'caractères');
    console.log('📄 [AVANT ANONYMISATION] Premier document:', compilationData.documents?.[0]?.filename);

    // Anonymiser le contenu de la compilation
    let compilationJson = JSON.stringify(compilationData);
    compilationJson = anonymizeJsonContent(compilationJson, mappingData);

    console.log('🔒 [APRÈS ANONYMISATION] Taille JSON:', compilationJson.length, 'caractères');
    console.log('🔒 [APRÈS ANONYMISATION] Extrait (100 premiers caractères):', compilationJson.substring(0, 100));

    // Retourner le JSON anonymisé
    res.json({
      content: JSON.parse(compilationJson),
      filename: `compilation_dossier_${documentId}.json`
    });

  } catch (error) {
    console.error('Erreur /api/anonymize/compilation:', error);
    res.status(500).json({ error: error.message });
  }
});
/**
 * Sauvegarder le fichier compilation_dossier.json
 */
app.post('/api/save-compilation', (req, res) => {
  try {
    const { documentId, compilation_data } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: 'documentId requis' });
    }

    const outputDir = getOutputPath(documentId);
    fs.mkdirSync(outputDir, { recursive: true });

    const compilationPath = path.join(outputDir, `compilation_dossier_${documentId}.json`);

    // Lire le fichier existant pour préserver informations_dossier
    let existingData = { informations_dossier: {}, documents: [] };
    if (fs.existsSync(compilationPath)) {
      try {
        const fileContent = readFileStripBOM(compilationPath, 'utf8');
        existingData = JSON.parse(fileContent);
      } catch (err) {
        console.warn(`⚠️ Impossible de lire le fichier existant: ${err.message}`);
      }
    }

    // Support pour l'ancien format (compilation_documents) et le nouveau (compilation_data)
    let dataToSave;
    if (compilation_data) {
      // Nouveau format avec informations_dossier
      dataToSave = compilation_data;
    } else if (req.body.compilation_documents) {
      // Ancien format (rétrocompatibilité) - PRÉSERVER informations_dossier
      dataToSave = {
        informations_dossier: existingData.informations_dossier || {},
        documents: req.body.compilation_documents
      };
    } else {
      return res.status(400).json({ error: 'compilation_data ou compilation_documents requis' });
    }

    fs.writeFileSync(
      compilationPath,
      JSON.stringify(dataToSave, null, 2),
      'utf8'
    );

    console.log(`✅ Compilation sauvegardée: ${compilationPath}`);

    res.json({ success: true, path: compilationPath });

  } catch (error) {
    console.error('❌ Erreur /api/save-compilation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ROUTE OLLAMA ANALYZER
// ============================================

/**
 * Analyse d'anonymisation avec OLLAMA
 * Traitement séquentiel optimisé pour modèles légers
 * Envoie la progression via WebSocket
 */
app.post('/api/ollama/analyze', async (req, res) => {
  try {
    const { extractedTexts, ollamaUrl, modelName, documentId, dossierInfo } = req.body;

    if (!extractedTexts || !Array.isArray(extractedTexts)) {
      return res.status(400).json({ error: 'extractedTexts requis (array)' });
    }

    if (!ollamaUrl || !modelName) {
      return res.status(400).json({ error: 'ollamaUrl et modelName requis' });
    }

    console.log(`🤖 [OLLAMA] Analyse de ${extractedTexts.length} document(s) avec ${modelName}`);
    console.log(`🔗 [OLLAMA] URL: ${ollamaUrl}`);

    // Fonction pour broadcaster aux clients WebSocket
    const broadcastProgress = (message) => {
      wordClients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(JSON.stringify({
            type: 'ollama-progress',
            message: message
          }));
        }
      });
    };

    // Pas de schéma Zod - on utilise YAML format libre
    console.log('📋 [OLLAMA] Format YAML simple demandé');

    // Initialiser le client Ollama
    const ollama = new Ollama({ host: ollamaUrl });

    // Prompt ULTRA-SIMPLIFIÉ en français - Format YAML
    const UNIFIED_PROMPT = `Extrais les données sensibles.

Identifie dans le texte :

1. PERSONNES MORALES avec leur forme sociale
2. PERSONNES PHYSIQUES
3. ADRESSES
4. NUMÉROS DIVERS

RÈGLE : Liste les données telles qu'elles apparaissent dans le texte.

FORMAT ATTENDU :
Personnes morales:
  - 

Personnes physiques:
  - 

Adresses:
  - 

Numéros divers:
  - 

Réponds UNIQUEMENT en YAML.".`;

    // Fonction pour extraire les emails par REGEX
    const extractEmails = (text) => {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      return text.match(emailRegex) || [];
    };

    // Fonction pour extraire les SIREN par REGEX
    const extractSIREN = (text) => {
      const siren = new Set();

      // Pattern 1: "SIREN" ou "RCS" suivi de 9 chiffres (avec ou sans espaces)
      const sirenPattern1 = /(?:SIREN|RCS)[^\d]{0,50}?(\d{3}\s?\d{3}\s?\d{3})/gi;
      let match;
      while ((match = sirenPattern1.exec(text)) !== null) {
        siren.add(match[1].replace(/\s/g, ''));
      }

      // Pattern 2: 9 chiffres avec espaces ou sans, proche de SIREN/RCS
      const sirenPattern2 = /(\d{3}\s?\d{3}\s?\d{3})/g;
      const textLower = text.toLowerCase();
      let match2;
      while ((match2 = sirenPattern2.exec(text)) !== null) {
        const pos = match2.index;
        const before = textLower.substring(Math.max(0, pos - 50), pos);
        const after = textLower.substring(pos, Math.min(text.length, pos + 50));

        if (before.includes('siren') || before.includes('rcs') ||
            after.includes('siren') || after.includes('rcs')) {
          siren.add(match2[1].replace(/\s/g, ''));
        }
      }

      return Array.from(siren);
    };

    // Fonction pour filtrer les villes et codes postaux
    const filterCitiesAndPostalCodes = (text) => {
      // Liste des villes françaises communes (non exhaustive)
      const commonCities = /\b(paris|lyon|marseille|toulouse|nice|nantes|montpellier|strasbourg|bordeaux|lille|rennes|reims|saint-étienne|toulon|grenoble|dijon|angers|nîmes|villeurbanne|le mans|aix-en-provence|clermont-ferrand|brest|tours|amiens|limoges|annecy|perpignan|besançon|orléans|metz|rouen|mulhouse|caen|nancy|argenteuil|montreuil|saint-denis)\b/gi;

      // Codes postaux (5 chiffres)
      const postalCodes = /\b\d{5}\b/g;

      // Retourne false si c'est une ville ou code postal
      if (commonCities.test(text)) return false;
      if (postalCodes.test(text)) return false;

      return true;
    };

    // Fonction pour normaliser et merger les duplicatas (ignore casse)
    const mergeVariants = (items) => {
      const normalized = new Map(); // clé en minuscules -> valeur originale

      items.forEach(item => {
        const key = item.toLowerCase();
        if (!normalized.has(key)) {
          normalized.set(key, item);
        }
      });

      return Array.from(normalized.values());
    };

    // Analyser chaque document séquentiellement
    const allEntities = {
      personnes: new Set(),
      societes: new Set(),
      siren: new Set(),
      emails: new Set(),
      adresses: new Set(),
      numeros: new Set()
    };

    broadcastProgress(`🚀 Démarrage de l'analyse OLLAMA...`);

    // Configuration des chunks (~4000 tokens pour test)
    const CHUNK_SIZE = 16000; // ~4000 tokens
    const MAX_RETRIES = 10; // Retry jusqu'à obtenir un JSON valide

    for (let i = 0; i < extractedTexts.length; i++) {
      const { fileName, text } = extractedTexts[i];

      console.log(`📄 [OLLAMA] Analyse ${i + 1}/${extractedTexts.length}: ${fileName} (${text.length} caractères)`);
      broadcastProgress(`📄 Document ${i + 1}/${extractedTexts.length}: ${fileName}`);

      // Extraction REGEX sur le texte complet
      console.log(`  [REGEX] Extraction emails et SIREN...`);
      const emails = extractEmails(text);
      const sirens = extractSIREN(text);

      emails.forEach(email => allEntities.emails.add(email));
      sirens.forEach(siren => allEntities.siren.add(siren));

      console.log(`  [REGEX] Trouvé: ${emails.length} emails, ${sirens.length} SIREN`);
      if (emails.length > 0 || sirens.length > 0) {
        broadcastProgress(`  📧 ${emails.length} emails, 🏢 ${sirens.length} SIREN`);
      }

      // Découper le texte en chunks si nécessaire (pas d'overlap)
      const chunks = [];
      if (text.length <= CHUNK_SIZE) {
        chunks.push(text);
      } else {
        let start = 0;
        while (start < text.length) {
          const end = Math.min(start + CHUNK_SIZE, text.length);
          chunks.push(text.substring(start, end));
          start = end; // Pas d'overlap
        }
      }

      console.log(`  [OLLAMA] ${chunks.length} chunk(s) à analyser`);
      if (chunks.length > 1) {
        broadcastProgress(`  📑 ${chunks.length} partie(s) à analyser`);
      }

      // Analyser chaque chunk avec le prompt fusionné
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkLabel = chunks.length > 1 ? ` (partie ${chunkIdx + 1}/${chunks.length})` : '';

        broadcastProgress(`  🔍 Analyse${chunkLabel}...`);
        console.log(`  [OLLAMA] Analyse${chunkLabel}`);

        let entities = null;

        // Retry logic
        for (let retryCount = 0; retryCount < MAX_RETRIES; retryCount++) {
          try {
            const prompt = `${UNIFIED_PROMPT}\n\nText to analyze:\n${chunk}`;

            if (retryCount > 0) {
              broadcastProgress(`    🔄 Nouvelle tentative (${retryCount + 1}/${MAX_RETRIES})...`);
              console.log(`    🔄 Retry ${retryCount + 1}/${MAX_RETRIES}`);
            }

            // Appel OLLAMA sans schéma - format libre YAML
            const response = await ollama.generate({
              model: modelName,
              prompt: prompt,
              stream: false,
              options: {
                temperature: 0,       // Pas de créativité
                num_predict: -1,      // Illimité pour capturer TOUTES les entités
                top_p: 0.1,           // Anti-hallucinations
                top_k: 10,            // Limite les choix improbables
                repeat_penalty: 1.1,  // Évite les répétitions
                num_ctx: 16384        // Fenêtre large : chunk + réponse complète
              }
            });

            let responseText = response.response?.trim() || '';

            console.log(`📥 [OLLAMA] Réponse (${responseText.length} chars): ${responseText.substring(0, 100)}...`);

            // Nettoyer les balises markdown
            responseText = responseText.replace(/```yaml\n?/g, '').replace(/```\n?/g, '').trim();

            // Parser le YAML manuellement (format simple)
            try {
              const lines = responseText.split('\n');
              entities = {
                personnes_morales: [],
                personnes_physiques: [],
                adresses: [],
                numeros: []
              };

              let currentCategory = null;

              for (const line of lines) {
                const trimmed = line.trim();

                if (trimmed.startsWith('Personnes morales:')) {
                  currentCategory = 'personnes_morales';
                } else if (trimmed.startsWith('Personnes physiques:')) {
                  currentCategory = 'personnes_physiques';
                } else if (trimmed.startsWith('Adresses:')) {
                  currentCategory = 'adresses';
                } else if (trimmed.startsWith('Numéros divers:')) {
                  currentCategory = 'numeros';
                } else if (trimmed.startsWith('- ') && currentCategory) {
                  const value = trimmed.substring(2).trim();
                  if (value) {
                    entities[currentCategory].push(value);
                  }
                }
              }

              console.log(`✅ [OLLAMA] YAML parsé`);

              // Vérifier si toutes les catégories sont vides
              const isEmpty = entities.personnes_morales.length === 0 &&
                             entities.personnes_physiques.length === 0 &&
                             entities.adresses.length === 0 &&
                             entities.numeros.length === 0;

              if (isEmpty && retryCount === 0) {
                console.warn(`⚠️ [OLLAMA] Résultat vide, nouvelle tentative...`);
                broadcastProgress(`    ⚠️ Résultat vide, nouvelle tentative...`);
                entities = null;
                continue;
              }

              break; // Succès
            } catch (parseError) {
              if (retryCount === MAX_RETRIES - 1) {
                console.error(`❌ [OLLAMA] YAML invalide après ${MAX_RETRIES} tentatives`);
                console.error(`    Réponse: ${responseText}`);
                broadcastProgress(`⚠️ YAML invalide pour ${fileName}`);
              } else {
                console.warn(`⚠️ [OLLAMA] YAML invalide (tentative ${retryCount + 1}/${MAX_RETRIES})`);
              }
            }

          } catch (error) {
            console.error(`❌ [OLLAMA] Erreur: ${error.message}`);
            broadcastProgress(`⚠️ Erreur: ${error.message}`);
            break;
          }
        }

        // Ajouter les entités si succès
        if (entities) {
          // Ajouter personnes morales
          if (entities.personnes_morales && Array.isArray(entities.personnes_morales)) {
            entities.personnes_morales.forEach(text => {
              if (text && text.trim()) {
                allEntities.societes.add(text.trim());
              }
            });
          }

          // Ajouter personnes physiques
          if (entities.personnes_physiques && Array.isArray(entities.personnes_physiques)) {
            entities.personnes_physiques.forEach(text => {
              if (text && text.trim()) {
                allEntities.personnes.add(text.trim());
              }
            });
          }

          // Ajouter adresses
          if (entities.adresses && Array.isArray(entities.adresses)) {
            entities.adresses.forEach(text => {
              if (text && text.trim()) {
                allEntities.adresses.add(text.trim());
              }
            });
          }

          // Ajouter numéros
          if (entities.numeros && Array.isArray(entities.numeros)) {
            entities.numeros.forEach(text => {
              if (text && text.trim()) {
                allEntities.numeros.add(text.trim());
              }
            });
          }

          const counts = `${entities.personnes_morales?.length || 0} sociétés, ${entities.personnes_physiques?.length || 0} personnes, ${entities.adresses?.length || 0} adresses, ${entities.numeros?.length || 0} numéros`;
          console.log(`✅ [OLLAMA] ${counts}`);
          broadcastProgress(`    ✅ ${counts}`);
        }
      } // Fin boucle chunks

      broadcastProgress(`  ✅ Document terminé: ${fileName}`);

    } // Fin boucle documents

    broadcastProgress(`🔄 Compilation des résultats...`);

    // Convertir Sets en Arrays (maintenant de simples strings)
    const personnes = mergeVariants(Array.from(allEntities.personnes)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const societes = mergeVariants(Array.from(allEntities.societes)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const siren = mergeVariants(Array.from(allEntities.siren)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const emails = mergeVariants(Array.from(allEntities.emails)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const adresses = mergeVariants(Array.from(allEntities.adresses)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
    const numeros = mergeVariants(Array.from(allEntities.numeros)).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );

    console.log(`✅ [OLLAMA] Analyse terminée: ${personnes.length} personnes, ${societes.length} sociétés, ${siren.length} SIREN, ${emails.length} emails, ${adresses.length} adresses, ${numeros.length} numéros`);

    // Créer le mapping et reverse_mapping
    const mapping = {};
    const reverse_mapping = {};

    // Mapper les personnes physiques
    personnes.forEach((personne, index) => {
      const code = `PERSONNE_PHYSIQUE_${String(index + 1).padStart(2, '0')}`;
      mapping[personne] = code;
      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(personne);
    });

    // Mapper les sociétés : sigle en préfixe (SA_1, SARL_1, GMBH_1…), un compteur
    // par sigle, sinon PERS_MORALE_1. Même vocabulaire que le pipeline GLiNER.
    const societeCounters = {};
    societes.forEach((societe) => {
      const key = detectCompanySigle(societe) || 'PERS_MORALE';
      const n = (societeCounters[key] = (societeCounters[key] || 0) + 1);
      const code = `${key}_${n}`;
      mapping[societe] = code;
      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(societe);
    });

    // Mapper les SIREN (extraits par REGEX)
    siren.forEach((num, index) => {
      const code = `SIREN_${String(index + 1).padStart(2, '0')}`;
      mapping[num] = code;
      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(num);
    });

    // Mapper les emails (extraits par REGEX)
    emails.forEach((email, index) => {
      const code = `EMAIL_${String(index + 1).padStart(2, '0')}`;
      mapping[email] = code;
      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(email);
    });

    // Mapper les adresses
    adresses.forEach((adresse, index) => {
      const code = `ADRESSE_${String(index + 1).padStart(2, '0')}`;
      mapping[adresse] = code;
      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(adresse);
    });

    // Mapper les numéros (OLLAMA + REGEX)
    numeros.forEach((numero, index) => {
      const code = `NUMERO_${String(index + 1).padStart(2, '0')}`;
      // Pour les numéros, on mappe le texte exact (pas de variants)
      mapping[numero] = code;

      if (!reverse_mapping[code]) reverse_mapping[code] = [];
      reverse_mapping[code].push(numero);
    });

    // Construire compilation_documents
    const compilation_documents = extractedTexts.map((textData, idx) => ({
      id: String(idx + 1).padStart(4, '0'),
      date_document: "",
      type_document: "",
      filename: textData.fileName,
      texte_integral: textData.text,
      analyse: ""
    }));

    // Construire extracted_data (compatible avec le format attendu)
    const extracted_data = {
      personnes_physiques: personnes.reduce((acc, personne) => {
        acc[personne] = { nom: personne };
        return acc;
      }, {}),
      societes: societes.reduce((acc, societe) => {
        acc[societe] = { nom: societe };
        return acc;
      }, {}),
      siren: siren.reduce((acc, num) => {
        acc[num] = { numero: num };
        return acc;
      }, {}),
      emails: emails.reduce((acc, email) => {
        acc[email] = { email };
        return acc;
      }, {}),
      adresses: adresses.reduce((acc, adresse) => {
        acc[adresse] = { adresse: adresse };
        return acc;
      }, {}),
      numeros: numeros.reduce((acc, numero) => {
        acc[numero] = { numero: numero };
        return acc;
      }, {})
    };

    // Résultat final
    const result = {
      mapping,
      reverse_mapping,
      extracted_data,
      compilation_documents,
      documentId,
      stats: {
        personnes: personnes.length,
        societes: societes.length,
        siren: siren.length,
        emails: emails.length,
        adresses: adresses.length,
        numeros: numeros.length
      }
    };

    console.log(`📊 [OLLAMA] Résultat: ${Object.keys(mapping).length} entités mappées`);
    broadcastProgress(`✅ Analyse terminée: ${personnes.length} personne(s), ${societes.length} société(s), ${siren.length} SIREN, ${emails.length} email(s), ${adresses.length} adresse(s), ${numeros.length} numéro(s)`);

    res.json(result);

  } catch (error) {
    console.error('❌ [OLLAMA] Erreur globale:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ENDPOINT OLLAMA : ANALYSE CONTEXTUELLE DES DOCUMENTS
// ========================================

app.post('/api/ollama/analyze-documents', async (req, res) => {
  try {
    const { extractedTexts, ollamaUrl, modelName, documentId } = req.body;

    if (!extractedTexts || !Array.isArray(extractedTexts)) {
      return res.status(400).json({ error: 'extractedTexts requis (array)' });
    }

    if (!ollamaUrl || !modelName) {
      return res.status(400).json({ error: 'ollamaUrl et modelName requis' });
    }

    console.log(`📄 [OLLAMA-DOC] Analyse contextuelle de ${extractedTexts.length} document(s) avec ${modelName}`);

    // Fonction pour broadcaster aux clients WebSocket
    const broadcastProgress = (message) => {
      wordClients.forEach(client => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'ollama-progress',
            message: message
          }));
        }
      });
    };

    // Initialiser le client Ollama
    const ollama = new Ollama({ host: ollamaUrl });

    // Résultats d'analyse pour chaque document
    const analyses = [];

    // Configuration des chunks (10000 tokens = ~40000 caractères)
    const CHUNK_SIZE = 40000;

    // Fonction pour normaliser les dates en format YYYY-MM-DD
    const normalizeDate = (dateStr) => {
      if (!dateStr || dateStr.trim() === '') return '';

      const cleaned = dateStr.trim();

      // Déjà au bon format YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        return cleaned;
      }

      // Formats français courants
      const frenchFormats = [
        // DD/MM/YYYY ou DD-MM-YYYY
        { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, handler: (m) => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
        // DD/MM/YY ou DD-MM-YY
        { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/, handler: (m) => {
          const year = parseInt(m[3]);
          const fullYear = year > 50 ? `19${m[3]}` : `20${m[3]}`;
          return `${fullYear}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        }},
        // DD mois YYYY (ex: "15 janvier 2023", "15 janv. 2023")
        { regex: /^(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|janv\.?|févr\.?|avr\.?|juil\.?|sept\.?|oct\.?|nov\.?|déc\.?)\s+(\d{4})$/i,
          handler: (m) => {
            const day = m[1].padStart(2, '0');
            const monthMap = {
              'janvier': '01', 'janv': '01', 'février': '02', 'févr': '02',
              'mars': '03', 'avril': '04', 'avr': '04', 'mai': '05',
              'juin': '06', 'juillet': '07', 'juil': '07', 'août': '08',
              'septembre': '09', 'sept': '09', 'octobre': '10', 'oct': '10',
              'novembre': '11', 'nov': '11', 'décembre': '12', 'déc': '12'
            };
            const monthKey = m[2].toLowerCase().replace('.', '');
            const month = monthMap[monthKey] || '01';
            return `${m[3]}-${month}-${day}`;
          }
        },
        // YYYY/MM/DD ou YYYY-MM-DD (déjà couvert mais avec séparateurs variés)
        { regex: /^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/, handler: (m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` },
        // YYYYMMDD (format compact)
        { regex: /^(\d{4})(\d{2})(\d{2})$/, handler: (m) => `${m[1]}-${m[2]}-${m[3]}` }
      ];

      for (const format of frenchFormats) {
        const match = cleaned.match(format.regex);
        if (match) {
          try {
            return format.handler(match);
          } catch (e) {
            console.warn(`Erreur normalisation date "${cleaned}":`, e);
          }
        }
      }

      // Si aucun format ne correspond, retourner la chaîne originale
      console.warn(`Format de date non reconnu: "${cleaned}"`);
      return cleaned;
    };

    broadcastProgress(`🚀 Démarrage de l'analyse contextuelle...`);

    // Analyser chaque document avec sa propre session
    for (let i = 0; i < extractedTexts.length; i++) {
      const { fileName, text } = extractedTexts[i];

      console.log(`📄 [OLLAMA-DOC] Analyse ${i + 1}/${extractedTexts.length}: ${fileName} (${text.length} caractères)`);
      broadcastProgress(`📄 Document ${i + 1}/${extractedTexts.length}: ${fileName}`);

      // Découper le texte en chunks si nécessaire (max 10000 tokens)
      const chunks = [];
      if (text.length <= CHUNK_SIZE) {
        chunks.push(text);
      } else {
        let start = 0;
        while (start < text.length) {
          const end = Math.min(start + CHUNK_SIZE, text.length);
          chunks.push(text.substring(start, end));
          start = end;
        }
      }

      console.log(`  [OLLAMA-DOC] ${chunks.length} chunk(s) à analyser`);
      if (chunks.length > 1) {
        broadcastProgress(`  📑 ${chunks.length} partie(s) à analyser`);
      }

      // Créer une session de chat pour ce document (contexte partagé entre chunks)
      const messages = [];

      // Prompt système pour l'analyse
      const systemPrompt = `Tu es un assistant d'analyse juridique. Ton rôle est d'analyser le document fourni et d'extraire les informations suivantes au format XML :

<type_document>Type exact du document (ex: Jugement du Tribunal de Commerce, Assignation, Procès-verbal, etc.)</type_document>
<date>Date du document au format YYYY-MM-DD uniquement (ex: 2023-01-15). N'utilise JAMAIS d'autre format.</date>
<analyse>
Analyse structurée du document avec 4 à 5 points clés principaux. Chaque point doit être concis et factuel.
- Point clé 1 : [Description]
- Point clé 2 : [Description]
- Point clé 3 : [Description]
- Point clé 4 : [Description]
- Point clé 5 : [Description] (optionnel)
</analyse>

IMPORTANT :
- Réponds UNIQUEMENT avec le XML demandé
- Sois précis et factuel
- Base-toi uniquement sur le contenu du document
- Pour la date : TOUJOURS utiliser le format YYYY-MM-DD (exemple: 2023-01-15, pas 15/01/2023)
- Si une information n'est pas trouvée, laisse le champ vide`;

      // Pour chaque chunk, construire le contexte progressivement
      for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
        const chunk = chunks[chunkIdx];
        const chunkLabel = chunks.length > 1 ? ` (partie ${chunkIdx + 1}/${chunks.length})` : '';

        broadcastProgress(`  🔍 Analyse${chunkLabel}...`);
        console.log(`  [OLLAMA-DOC] Analyse${chunkLabel}`);

        // Construire le message utilisateur
        let userMessage;
        if (chunkIdx === 0 && chunks.length === 1) {
          // Document complet en un seul chunk
          userMessage = `Voici le document complet à analyser :\n\n${chunk}`;
        } else if (chunkIdx === 0) {
          // Premier chunk d'un document long
          userMessage = `Voici le début du document (partie 1/${chunks.length}). Lis-le attentivement, je t'enverrai les parties suivantes :\n\n${chunk}`;
        } else if (chunkIdx < chunks.length - 1) {
          // Chunk intermédiaire
          userMessage = `Voici la suite du document (partie ${chunkIdx + 1}/${chunks.length}) :\n\n${chunk}`;
        } else {
          // Dernier chunk
          userMessage = `Voici la fin du document (partie ${chunkIdx + 1}/${chunks.length}). Maintenant, fournis l'analyse complète au format XML demandé :\n\n${chunk}`;
        }

        // Ajouter le message utilisateur à l'historique
        messages.push({
          role: 'user',
          content: userMessage
        });

        // Appel OLLAMA avec chat (contexte conservé)
        const response = await ollama.chat({
          model: modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages
          ],
          stream: false,
          options: {
            temperature: 0.3,     // Légère créativité pour l'analyse
            num_predict: 1024,    // Suffisant pour le XML de réponse
            top_p: 0.9,
            top_k: 40,
            num_ctx: 16384        // Contexte large pour les chunks
          }
        });

        const assistantMessage = response.message?.content?.trim() || '';

        // Ajouter la réponse à l'historique pour le contexte
        messages.push({
          role: 'assistant',
          content: assistantMessage
        });

        console.log(`  [OLLAMA-DOC] Réponse chunk ${chunkIdx + 1}: ${assistantMessage.substring(0, 100)}...`);

        // Si c'est le dernier chunk OU si c'est un document en un seul chunk, parser le résultat
        if (chunkIdx === chunks.length - 1) {
          broadcastProgress(`  ✅ Extraction des métadonnées...`);

          // Parser le XML de la réponse
          const typeMatch = assistantMessage.match(/<type_document>(.*?)<\/type_document>/s);
          const dateMatch = assistantMessage.match(/<date>(.*?)<\/date>/s);
          const analyseMatch = assistantMessage.match(/<analyse>(.*?)<\/analyse>/s);

          const type_document = typeMatch ? typeMatch[1].trim() : '';
          const date_raw = dateMatch ? dateMatch[1].trim() : '';
          const analyse = analyseMatch ? analyseMatch[1].trim() : '';

          // Normaliser la date au format YYYY-MM-DD
          const date_document = normalizeDate(date_raw);

          console.log(`  ✅ Type: ${type_document}`);
          console.log(`  ✅ Date (brute): ${date_raw}`);
          console.log(`  ✅ Date (normalisée): ${date_document}`);
          console.log(`  ✅ Analyse: ${analyse.substring(0, 100)}...`);

          analyses.push({
            fileName,
            type_document,
            date_document,
            analyse
          });
        }
      }

      broadcastProgress(`  ✅ Document terminé: ${fileName}`);
    }

    broadcastProgress(`🎉 Analyse terminée pour tous les documents`);

    console.log(`✅ [OLLAMA-DOC] Analyse terminée: ${analyses.length} document(s) analysé(s)`);

    // Retourner les analyses
    res.json({
      success: true,
      documentId,
      analyses
    });

  } catch (error) {
    console.error('❌ [OLLAMA-DOC] Erreur globale:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ENDPOINTS POUR LA GESTION DU TAMPON
// ========================================

// Sauvegarder le fichier tampon
app.post('/api/tampon/save', (req, res) => {
  try {
    const { tamponImage } = req.body;

    if (!tamponImage) {
      return res.status(400).json({ error: 'Image du tampon requise' });
    }

    const tamponPath = getSystemDataPath('tampon.png');
    fs.mkdirSync(path.dirname(tamponPath), { recursive: true });

    const match = String(tamponImage).match(/^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) {
      return res.status(400).json({ error: 'Format d’image du tampon non supporté. Utilisez PNG ou JPEG.' });
    }

    // Le nom historique reste `tampon.png` pour ne pas casser les
    // installations existantes. La signature binaire fait foi à la lecture.
    const base64Data = match[1].replace(/\s/g, '');
    const buffer = Buffer.from(base64Data, 'base64');
    let image;
    try {
      image = detectStampImage(buffer);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    fs.writeFileSync(tamponPath, buffer);

    console.log('✅ Tampon sauvegardé:', tamponPath);

    res.json({
      success: true,
      filename: 'tampon.png',
      format: image.format,
      path: tamponPath
    });

  } catch (error) {
    console.error('Erreur /api/tampon/save:', error);
    res.status(500).json({ error: error.message });
  }
});

// Charger le fichier tampon
app.get('/api/tampon/load', (req, res) => {
  try {
    const tamponPath = getSystemDataPath('tampon.png');

    if (!fs.existsSync(tamponPath)) {
      return res.status(404).json({ error: 'Aucun tampon configuré' });
    }

    // Lire et convertir en base64 en respectant le format réel. Les versions
    // historiques pouvaient stocker un JPEG dans le fichier `tampon.png`.
    const buffer = fs.readFileSync(tamponPath);
    const image = detectStampImage(buffer);
    const tamponImage = stampDataUrl(buffer);

    res.json({
      success: true,
      tamponImage: tamponImage,
      filename: 'tampon.png',
      format: image.format
    });

  } catch (error) {
    console.error('Erreur /api/tampon/load:', error);
    res.status(500).json({ error: error.message });
  }
});

// Supprimer le fichier tampon
app.delete('/api/tampon/delete', (req, res) => {
  try {
    const tamponPath = getSystemDataPath('tampon.png');

    if (fs.existsSync(tamponPath)) {
      fs.unlinkSync(tamponPath);
      console.log('🗑️ Tampon supprimé:', tamponPath);
    }

    res.json({ success: true });

  } catch (error) {
    console.error('Erreur /api/tampon/delete:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ENDPOINT POUR LE TAMPONNAGE DE PIÈCES
// ========================================
/**
 * Chemin réel de l'original d'une pièce. Les compilations écrites par la
 * version courante stockent le chemin complet, mais celles d'avant n'ont que
 * le nom du fichier : on le retrouve là où les originales ont été déposées au
 * fil des versions, sans jamais sortir du dossier juridique (`basename`).
 */
function resolvePieceFile(declaredPath, workingFolder, documentId) {
  const declared = String(declaredPath || '').trim();
  if (!declared) return null;
  if (path.isAbsolute(declared) && fs.existsSync(declared)) return declared;

  const name = path.basename(declared);
  return [
    path.join(workingFolder, ORIGINALS_SUBFOLDER, name),
    path.join(workingFolder, `fichiers_sources_${documentId}`, name),
    path.join(workingFolder, name),
  ].find((candidate) => fs.existsSync(candidate)) || null;
}

// Nouvelle logique de tamponnage : une pièce est désignée par son chemin
// relatif au dossier juridique (tel que listé par `listOriginals`). On refuse
// tout chemin absolu ou remontant hors du dossier, puis on exige un fichier.
function resolveCaseRelativeFile(caseFolder, relativePath) {
  const relative = String(relativePath || '').trim();
  if (!relative || path.isAbsolute(relative)) return null;
  const candidate = path.resolve(caseFolder, relative);
  if (candidate !== caseFolder && !isInside(caseFolder, candidate)) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

app.post('/api/stamping', async (req, res) => {
  try {
    const { pieces, documentId, folder } = req.body;

    if (!pieces || !Array.isArray(pieces) || pieces.length === 0) {
      return res.status(400).json({ error: 'Liste de pièces requise (array d\'IDs)' });
    }

    if (!documentId) {
      return res.status(400).json({ error: 'ID du document requis' });
    }

    // Les pièces tamponnées vont TOUJOURS dans le dossier juridique du
    // document Word ouvert, sous-dossier « Pièces tamponnées ».
    const requestedFolder = String(folder || '').trim() || getDossierFolder(documentId);

    if (!requestedFolder) {
      return res.status(400).json({
        error: 'Dossier de travail inconnu. Enregistrez le document Word puis rechargez les pièces, ou indiquez le dossier de travail (paramètre "folder").'
      });
    }

    if (!fs.existsSync(requestedFolder) || !fs.statSync(requestedFolder).isDirectory()) {
      return res.status(400).json({ error: `Dossier de travail introuvable : ${requestedFolder}` });
    }

    // rememberDossierFolder refuse tout dossier hors d'un dossier juridique enregistré.
    let workingFolder;
    try {
      workingFolder = rememberDossierFolder(documentId, requestedFolder);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    // Charger le tampon depuis le fichier sauvegardé
    const tamponPath = getSystemDataPath('tampon.png');
    if (!fs.existsSync(tamponPath)) {
      return res.status(400).json({
        error: 'Aucun tampon configuré. Veuillez d\'abord configurer un tampon via le menu "🖼️ Configurer le tampon".'
      });
    }

    // Lire le tampon et détecter son format réel. Un ancien tampon JPEG peut
    // légitimement porter le nom de fichier historique `tampon.png`.
    const tamponBuffer = fs.readFileSync(tamponPath);
    const tamponFormat = detectStampImage(tamponBuffer).format;

    // Une compilation `compilation_dossier_<documentId>.json` n'existe plus que
    // pour les dossiers chargés par l'ancien flux Word ; l'administration
    // désigne désormais les pièces par leur chemin relatif au dossier juridique.
    // On charge la compilation si elle est là (parcours Word/MCP), sinon on
    // résout chaque pièce directement comme un fichier du dossier.
    const compilationPath = path.join(workingFolder, `compilation_dossier_${documentId}.json`);
    let documentsArray = [];
    if (fs.existsSync(compilationPath)) {
      const compilationData = JSON.parse(readFileStripBOM(compilationPath, 'utf8'));
      // Deux formes coexistent sur disque : un objet
      // `{ informations_dossier, documents }` et, pour les plus anciennes, le
      // tableau nu.
      documentsArray = Array.isArray(compilationData)
        ? compilationData
        : compilationData.documents || [];
      if (!Array.isArray(documentsArray)) {
        return res.status(500).json({
          error: 'Structure de compilation invalide : documents doit être un tableau'
        });
      }
    }

    const tamponnedDir = stampedPiecesDirectory(workingFolder);
    fs.mkdirSync(tamponnedDir, { recursive: true });

    const { PDFDocument, rgb } = require('pdf-lib');
    const results = [];

    // Dossier temporaire des PDF intermédiaires (Excel, Word, images, texte).
    const conversionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-conversion-'));

    // Traiter chaque pièce dans l'ordre donné
    for (let i = 0; i < pieces.length; i++) {
      const pieceId = pieces[i];
      const pieceNumber = i + 1;

      // Deux origines pour l'`id` d'une pièce : une entrée de compilation (flux
      // Word/MCP) résolue par son `filename`, ou un chemin relatif au dossier
      // juridique (administration) résolu directement.
      const document = documentsArray.find(doc => doc.id === pieceId);
      const declaredName = document ? document.filename : pieceId;

      try {
        const filePath = document
          ? resolvePieceFile(document.filename, workingFolder, documentId)
          : resolveCaseRelativeFile(workingFolder, pieceId);

        if (!filePath) {
          results.push({
            pieceNumber,
            id: pieceId,
            filename: declaredName,
            success: false,
            error: `Fichier introuvable : ${declaredName || 'nom de fichier absent'}`
          });
          continue;
        }

        // Nom du fichier de sortie
        const outputFileName = `Pièce n°${pieceNumber}.pdf`;
        const outputPath = path.join(tamponnedDir, outputFileName);

        // Passage en PDF de l'original (Excel/Word via LibreOffice, images et
        // texte via pdf-lib, PDF laissé tel quel).
        const conversion = await convertToPdf(filePath, conversionDir);
        const pdfBytes = fs.readFileSync(conversion.pdfPath);

        // Charger le PDF avec pdf-lib
        const pdfDoc = await PDFDocument.load(pdfBytes);
        const pages = pdfDoc.getPages();
        const firstPage = pages[0];

        // Incorporer l'image en fonction de sa signature binaire.
        const tamponImg = tamponFormat === 'png'
          ? await pdfDoc.embedPng(tamponBuffer)
          : await pdfDoc.embedJpg(tamponBuffer);

        // Dimensions du carré pour le tampon
        const squareSize = 100;

        // Position en haut à droite
        const { width, height } = firstPage.getSize();
        const x = width - squareSize - 20;
        const y = height - squareSize - 20;

        // Calculer les dimensions de l'image pour qu'elle soit centrée dans le carré
        const imgWidth = tamponImg.width;
        const imgHeight = tamponImg.height;
        const scale = Math.min(squareSize / imgWidth, squareSize / imgHeight);
        const scaledWidth = imgWidth * scale;
        const scaledHeight = imgHeight * scale;

        // Centrer l'image dans le carré
        const imgX = x + (squareSize - scaledWidth) / 2;
        const imgY = y + (squareSize - scaledHeight) / 2;

        // Dessiner le tampon centré
        firstPage.drawImage(tamponImg, {
          x: imgX,
          y: imgY,
          width: scaledWidth,
          height: scaledHeight,
        });

        // Ajouter le numéro sur le tampon (centré)
        const fontSize = 16;
        const textString = String(pieceNumber);

        // Utiliser la police par défaut pour calculer la largeur du texte
        const textWidth = fontSize * textString.length * 0.6; // Approximation

        // Pour pdf-lib, le y représente la baseline du texte (bas du texte)
        // Pour centrer verticalement le centre du texte, on doit ajuster
        const textX = x + (squareSize - textWidth) / 2;
        const textY = y + (squareSize / 2) - (fontSize / 3); // Ajustement pour centrer le milieu du texte

        firstPage.drawText(textString, {
          x: textX,
          y: textY,
          size: fontSize,
          color: rgb(0, 0, 0),
        });

        // Sauvegarder le PDF tamponné
        const tamponnedPdfBytes = await pdfDoc.save();
        fs.writeFileSync(outputPath, tamponnedPdfBytes);

        results.push({
          pieceNumber,
          id: pieceId,
          filename: declaredName,
          outputFileName: outputFileName,
          outputPath: outputPath,
          converted: conversion.converted,
          conversionEngine: conversion.engine,
          success: true
        });

      } catch (error) {
        results.push({
          pieceNumber,
          id: pieceId,
          filename: declaredName,
          success: false,
          error: error.message
        });
      }
    }

    try {
      fs.rmSync(conversionDir, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn('⚠️ Nettoyage des PDF intermédiaires impossible:', cleanupError.message);
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      folder: workingFolder,
      tamponnedDir,
      results,
      summary: {
        total: pieces.length,
        success: successCount,
        failure: failureCount
      },
      message: `Tamponnage terminé : ${successCount} pièce(s) traitée(s), ${failureCount} erreur(s).`
    });

  } catch (error) {
    console.error('Erreur /api/stamping:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ROUTES POUR LES RESSOURCES
// ========================================
// Route proxy pour get_resource
app.post('/api/word/get-resource', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000); // 60 secondes

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'get_resource',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/get-resource:', error);
    res.status(500).json({ error: error.message });
  }
});

// Outil Template - injecte un template .docx local dans le volet explicitement
// ciblé. Le modèle ne reçoit jamais le binaire : le serveur le lit et l'envoie
// directement au volet Word par WebSocket.
app.post('/api/word/template', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const sourcePath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!sourcePath) {
      return res.status(400).json({ error: 'Paramètre « path » requis (chemin absolu du template .docx).' });
    }
    if (!path.isAbsolute(sourcePath)) {
      return res.status(400).json({ error: 'Le chemin du template doit être absolu.' });
    }

    const resolved = path.resolve(sourcePath);
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `Template introuvable : ${resolved}` });
    }
    if (path.extname(resolved).toLowerCase() !== '.docx') {
      return res.status(400).json({ error: 'Le template doit être un fichier .docx.' });
    }
    if (!fs.statSync(resolved).isFile()) {
      return res.status(400).json({ error: 'Le chemin du template ne désigne pas un fichier.' });
    }

    const requestId = Date.now().toString();
    const params = {
      template_name: path.basename(resolved),
      template_base64: fs.readFileSync(resolved).toString('base64')
    };

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        client.off('message', messageHandler);
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 120000);

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);
      client.send(JSON.stringify({
        requestId,
        action: 'template',
        params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/template:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Outil Draft Conclusions - Rédaction de conclusions juridiques par étapes
app.post('/api/word/draft-conclusions', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000); // 60 secondes

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'draft',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/draft-conclusions:', error);
    res.status(500).json({ error: error.message });
  }
});

// Outil Template Library - Gestion de la bibliothèque de placeholders
app.post('/api/word/template-library', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 60000); // 60 secondes

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'template_library',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/template-library:', error);
    res.status(500).json({ error: error.message });
  }
});

// Outil stamping - Créer un bordereau de pièces tamponnées
app.post('/api/word/stamping', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 120000); // 120 secondes (tamponnage peut être long)

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'stamping',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/stamping:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// ENDPOINT CALL_OLLAMA : Lancer l'analyse Ollama des documents
// ========================================
app.post('/api/word/call-ollama', async (req, res) => {
  try {
    const { client } = getRequestPane(req);
    if (!client) {
      return res.status(503).json({
        error: 'Aucun volet Word connecté pour le document actif. Appelez open_doc d’abord.'
      });
    }

    const requestId = Date.now().toString();
    const params = req.body;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(res.status(504).json({ error: 'Timeout: Le client Word n\'a pas répondu' }));
      }, 180000); // 180 secondes (analyse Ollama peut être très longue)

      const messageHandler = (data) => {
        try {
          const response = JSON.parse(data);
          if (response.requestId === requestId) {
            clearTimeout(timeout);
            client.off('message', messageHandler);
            resolve(res.json(response.result));
          }
        } catch (e) {
          // Ignorer les messages mal formés
        }
      };

      client.on('message', messageHandler);

      client.send(JSON.stringify({
        requestId,
        action: 'Call_Ollama',
        params: params
      }));
    });
  } catch (error) {
    console.error('Erreur /api/word/call-ollama:', error);
    res.status(500).json({ error: error.message });
  }
});

// Liste des ressources disponibles
app.get('/api/resources', (req, res) => {
  try {
    const resourcesDir = getSystemDataPath('ressources');
    
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
      return res.json({ resources: [], message: 'Dossier ressources créé' });
    }

    const files = fs.readdirSync(resourcesDir);
    const resources = files
      .filter(f => !f.startsWith('.'))
      .map(filename => {
        const filepath = path.join(resourcesDir, filename);
        const stats = fs.statSync(filepath);
        const ext = path.extname(filename).toLowerCase();
        
        return {
          filename,
          size: stats.size,
          modified: stats.mtime.toISOString(),
          type: ext === '.docx' ? 'template' : 'document',
          is_template: filename.toLowerCase().includes('template')
        };
      });

    res.json({ 
      resources,
      count: resources.length,
      path: 'output/ressources'
    });

  } catch (error) {
    console.error('Erreur /api/resources:', error);
    res.status(500).json({ error: error.message });
  }
});

// Lire une ressource spécifique
app.get('/api/resources/:filename', async (req, res) => {
  try {
    // Décoder le nom de fichier (gère les espaces et caractères spéciaux)
    const filename = decodeURIComponent(req.params.filename);
    const { format } = req.query;

    const resourcesDir = getSystemDataPath('ressources');
    const filepath = path.join(resourcesDir, filename);

    console.log('[GET /api/resources/:filename] Fichier demandé:', filename);
    console.log('[GET /api/resources/:filename] Format:', format);
    console.log('[GET /api/resources/:filename] Chemin complet:', filepath);

    // Sécurité : vérifier que le fichier est bien dans le dossier ressources
    if (!filepath.startsWith(resourcesDir)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    if (!fs.existsSync(filepath)) {
      console.error('[GET /api/resources/:filename] ❌ Fichier introuvable:', filepath);
      console.error('[GET /api/resources/:filename] Dossier ressources:', resourcesDir);
      // Lister les fichiers disponibles
      try {
        const availableFiles = fs.readdirSync(resourcesDir);
        console.error('[GET /api/resources/:filename] Fichiers disponibles:', availableFiles);
      } catch (e) {
        console.error('[GET /api/resources/:filename] Impossible de lister les fichiers:', e.message);
      }
      return res.status(404).json({ error: 'Ressource non trouvée' });
    }

    const ext = path.extname(filename).toLowerCase();

    console.log('[GET /api/resources/:filename] Extension:', ext);

    // Si format=base64 demandé (utilisé par draft pour injection)
    if (format === 'base64') {
      console.log('[GET /api/resources/:filename] Lecture du fichier...');
      const fileBuffer = fs.readFileSync(filepath);
      console.log('[GET /api/resources/:filename] ✅ Fichier lu, taille:', fileBuffer.length, 'octets');

      console.log('[GET /api/resources/:filename] Conversion en base64...');
      const base64Content = fileBuffer.toString('base64');
      console.log('[GET /api/resources/:filename] ✅ Base64 généré, taille:', base64Content.length, 'caractères');
      return res.json({
        filename,
        format: 'base64',
        content: base64Content,
        message: 'Fichier en base64'
      });
    }

    // Pour les fichiers texte
    if (['.txt', '.md', '.json', '.xml'].includes(ext)) {
      const content = fs.readFileSync(filepath, 'utf8');
      return res.json({
        filename,
        format: 'text',
        content
      });
    }

    // Fichiers binaires non supportés pour lecture directe
    return res.status(400).json({
      error: 'Format non supporté pour lecture directe',
      suggestion: 'Les fichiers .docx sont binaires. Utilisez action="copy" pour les dupliquer.'
    });

  } catch (error) {
    console.error('❌ [GET /api/resources/:filename] Erreur:', error);
    console.error('Stack:', error.stack);
    res.status(500).json({
      error: error.message,
      filename: req.params.filename
    });
  }
});

// Créer ou modifier une ressource
app.put('/api/resources/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const { content, format } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Contenu requis' });
    }

    const resourcesDir = getSystemDataPath('ressources');
    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }

    const filepath = path.join(resourcesDir, filename);

    // Sécurité
    if (!filepath.startsWith(resourcesDir)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    const ext = path.extname(filename).toLowerCase();

    // Si format='base64', accepter les fichiers binaires (.docx, .pdf, etc.)
    if (format === 'base64') {
      // Décoder le base64 et écrire en binaire
      const buffer = Buffer.from(content, 'base64');
      fs.writeFileSync(filepath, buffer);

      res.json({
        success: true,
        filename,
        format: 'base64',
        size: buffer.length,
        message: 'Ressource binaire sauvegardée'
      });
      return;
    }

    // Sinon, vérifier que c'est un fichier texte
    if (!['.txt', '.md', '.json', '.xml'].includes(ext)) {
      return res.status(400).json({
        error: 'Format non supporté pour écriture',
        suggestion: 'Seuls les fichiers texte (.txt, .md, .json, .xml) peuvent être créés/modifiés, ou utilisez format="base64" pour les fichiers binaires'
      });
    }

    // Écrire le fichier texte
    fs.writeFileSync(filepath, content, 'utf8');

    res.json({
      success: true,
      filename,
      format: 'text',
      message: 'Ressource sauvegardée'
    });

  } catch (error) {
    console.error('Erreur /api/resources PUT:', error);
    res.status(500).json({ error: error.message });
  }
});

// Renommer une ressource
app.patch('/api/resources/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const { new_filename } = req.body;

    if (!new_filename) {
      return res.status(400).json({ error: 'new_filename requis' });
    }

    const resourcesDir = getSystemDataPath('ressources');
    const oldPath = path.join(resourcesDir, filename);
    const newPath = path.join(resourcesDir, new_filename);

    // Sécurité
    if (!oldPath.startsWith(resourcesDir) || !newPath.startsWith(resourcesDir)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    if (!fs.existsSync(oldPath)) {
      return res.status(404).json({ error: 'Ressource non trouvée' });
    }

    if (fs.existsSync(newPath)) {
      return res.status(409).json({ error: 'Une ressource existe déjà avec ce nom' });
    }

    fs.renameSync(oldPath, newPath);

    res.json({
      success: true,
      old_filename: filename,
      new_filename,
      message: 'Ressource renommée'
    });

  } catch (error) {
    console.error('Erreur /api/resources PATCH:', error);
    res.status(500).json({ error: error.message });
  }
});

// Supprimer une ressource
app.delete('/api/resources/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    
    const resourcesDir = getSystemDataPath('ressources');
    const filepath = path.join(resourcesDir, filename);

    // Sécurité
    if (!filepath.startsWith(resourcesDir)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Ressource non trouvée' });
    }

    fs.unlinkSync(filepath);

    res.json({
      success: true,
      filename,
      message: 'Ressource supprimée'
    });

  } catch (error) {
    console.error('Erreur /api/resources DELETE:', error);
    res.status(500).json({ error: error.message });
  }
});

// Copier une ressource
app.post('/api/resources/copy', (req, res) => {
  try {
    const { filename, new_filename } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'filename requis' });
    }

    if (!new_filename) {
      return res.status(400).json({ error: 'new_filename requis' });
    }

    if (filename === new_filename) {
      return res.status(400).json({ error: 'Le fichier source et destination doivent être différents' });
    }

    const resourcesDir = getSystemDataPath('ressources');
    const sourcePath = path.join(resourcesDir, filename);
    const destPath = path.join(resourcesDir, new_filename);

    // Sécurité
    if (!sourcePath.startsWith(resourcesDir) || !destPath.startsWith(resourcesDir)) {
      return res.status(403).json({ error: 'Accès interdit' });
    }

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Ressource source non trouvée' });
    }

    if (fs.existsSync(destPath)) {
      return res.status(409).json({ error: 'Une ressource existe déjà avec ce nom de destination' });
    }

    // Copier le fichier
    fs.copyFileSync(sourcePath, destPath);

    const stats = fs.statSync(destPath);

    res.json({
      success: true,
      source_filename: filename,
      destination_filename: new_filename,
      size: stats.size,
      message: 'Ressource copiée avec succès'
    });

  } catch (error) {
    console.error('Erreur /api/resources/copy:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/modify-ooxml-styles', async (req, res) => {
  try {
    const { original_ooxml, styles_xml } = req.body;

    if (!original_ooxml || !styles_xml) {
      return res.status(400).json({ error: 'Données manquantes', success: false });
    }

    console.log('📝 Modification OOXML...');
    console.log('📏 Taille OOXML original:', original_ooxml.length);
    console.log('📏 Taille nouveau styles.xml:', styles_xml.length);

    // Regex pour capturer et remplacer UNIQUEMENT le contenu de xmlData dans styles.xml
    const stylesRegex = /(<pkg:part[^>]*pkg:name=["']\/word\/styles\.xml["'][^>]*>[\s\S]*?<pkg:xmlData>)([\s\S]*?)(<\/pkg:xmlData>[\s\S]*?<\/pkg:part>)/i;
    
    const match = original_ooxml.match(stylesRegex);
    
    let modifiedOoxml;
    
    if (match) {
      console.log('✅ Section styles trouvée');
      console.log('📏 Ancienne taille styles:', match[2].length);
      
      // Remplacer UNIQUEMENT le contenu XML entre les balises xmlData
      modifiedOoxml = original_ooxml.replace(stylesRegex, `$1${styles_xml}$3`);
      
      console.log('✅ Styles remplacés');
    } else {
      console.log('⚠️ Aucune section styles trouvée, ajout...');
      
      // Ajouter la section styles avant </pkg:package>
      const newStylesPart = `
  <pkg:part pkg:name="/word/styles.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml">
    <pkg:xmlData>${styles_xml}</pkg:xmlData>
  </pkg:part>`;
      
      modifiedOoxml = original_ooxml.replace('</pkg:package>', newStylesPart + '\n</pkg:package>');
    }

    const originalParts = (original_ooxml.match(/<pkg:part/g) || []).length;
    const modifiedParts = (modifiedOoxml.match(/<pkg:part/g) || []).length;
    
    console.log('📊 Parties: original=' + originalParts + ', modifié=' + modifiedParts);
    console.log('📏 Taille finale:', modifiedOoxml.length);
    
    // Vérifier qu'on a toujours document.xml
    if (!modifiedOoxml.includes('pkg:name="/word/document.xml"')) {
      throw new Error('document.xml manquant !');
    }

    console.log('✅ Package OOXML valide');

    res.json({ 
      success: true, 
      modified_ooxml: modifiedOoxml,
      debug: {
        original_size: original_ooxml.length,
        modified_size: modifiedOoxml.length,
        original_parts: originalParts,
        modified_parts: modifiedParts,
        styles_replaced: !!match
      }
    });

  } catch (error) {
    console.error('❌ Erreur modification OOXML:', error);
    res.status(500).json({ 
      error: error.message,
      success: false 
    });
  }
});
// Chemins des certificats SSL et de la CA générés dans websocket-server/
const keyPath = path.join(__dirname, 'localhost.key');
const certPath = path.join(__dirname, 'localhost.crt');
const caCertPath = path.join(__dirname, 'piecemaker-ca.crt');

// Vérifier la présence des certificats
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('❌ Certificats SSL non trouvés !');
  console.error('');
  console.error('Fichiers requis:');
  console.error(`  - ${keyPath}`);
  console.error(`  - ${certPath}`);
  console.error(`  - ${caCertPath} (CA - optionnel mais recommandé)`);
  console.error('');
  console.error('Générez-les avec l\'étape d\'installation 05 — Certificats HTTPS — ou manuellement depuis la racine du dépôt :');
  console.error('  node websocket-server/generate-ca-certificates.cjs');
  console.error('');
  process.exit(1);
}

console.log(`✅ Certificats SSL trouvés: ${path.basename(certPath)} / ${path.basename(keyPath)}`);

// Vérifier si le CA est disponible pour la chaîne complète
if (fs.existsSync(caCertPath)) {
  console.log(`🔐 Certificat CA disponible pour la chaîne TLS: ${path.basename(caCertPath)}`);
  console.log('📋 Chaîne présentée: localhost.crt → PieceMaker Root CA');
} else {
  console.log('⚠️ Certificat CA (piecemaker-ca.crt) non trouvé — seul le certificat serveur sera présenté');
  console.log('   Générez les certificats avec: node websocket-server/generate-ca-certificates.cjs');
}

// Options HTTPS avec chaîne de certificats complète
const options = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath)
};

// Si on a le CA, ajouter la chaîne complète pour que le client puisse valider
// Cela permet au serveur d'envoyer le certificat serveur + le CA en même temps
if (caCertPath && fs.existsSync(caCertPath)) {
  const caCert = fs.readFileSync(caCertPath, 'utf8');
  const serverCert = fs.readFileSync(certPath, 'utf8');
  // Concaténer: certificat serveur + CA (dans cet ordre)
  options.cert = serverCert + '\n' + caCert;
  console.log('✅ Chaîne de certificats complète configurée (serveur + CA)');

  // Afficher des informations sur le certificat pour vérification
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📋 CONFIGURATION SSL COMPLÈTE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Certificat serveur: ${path.basename(certPath)}`);
  console.log(`   Clé privée serveur: ${path.basename(keyPath)}`);
  console.log(`   Certificat CA: ${path.basename(caCertPath)}`);
  console.log('');
  console.log(`🔐 Le certificat affiché sur https://localhost:${PORT} est:`);
  console.log('   ✅ localhost.crt (CN=localhost)');
  console.log('   ✅ Signé par: PieceMaker Root CA');
  console.log('   ℹ️ À installer dans les autorités racines de confiance du système');
  console.log('');
  console.log('ℹ️ Le CA doit être installé dans les autorités racines de confiance');
  console.log('   pour que Word et les navigateurs approuvent automatiquement la connexion.');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
} else {
  console.log('');
  console.log('⚠️  ATTENTION: Certificat CA non trouvé!');
  console.log(`   Certificat utilisé: ${path.basename(certPath)} (sans chaîne CA)`);
  console.log('   Cela peut causer des avertissements de sécurité.');
  console.log('');
  console.log('   Pour résoudre: générez les certificats avec: node websocket-server/generate-ca-certificates.cjs');
  console.log('');
}

// ============================================================================
// CLAUDE CODE CLI INTEGRATION
// ============================================================================

const { spawn } = require('child_process');
const { PassThrough } = require('stream');

// ============================================
// TERMINAL PTY POUR CLAUDE CODE CLI
// ============================================
let pty;
try {
  pty = require('node-pty');
  console.log('✅ node-pty chargé avec succès');
} catch (e) {
  console.warn('⚠️ node-pty non disponible:', e.message);
  pty = null;
}

// Confinement OS optionnel (microsoft/mxc) : la session Claude Code du volet
// tourne sous Seatbelt/ProcessContainer pour bloquer au niveau syscall le venv
// et les mappings d'anonymisation, en défense en profondeur des hooks
// (contournables). Voir websocket-server/mxc-sandbox.cjs et docs/mxc-sandbox.md.
const mxcSandbox = require('./mxc-sandbox.cjs');

// Stockage des terminaux PTY actifs (par WebSocket client)
const ptyTerminals = new Map();

// Fonction pour créer un terminal PTY
function createPtyTerminal(ws, cols = 80, rows = 24, documentId = null) {
  if (!pty) {
    ws.send(JSON.stringify({
      type: 'pty-error',
      error: 'node-pty non disponible. Installer avec: npm install node-pty'
    }));
    return null;
  }

  try {
    // Utiliser les APIs Node.js natives pour cross-platform support (Windows, macOS, Linux)
    const userInfo = os.userInfo();

    let cwd = os.homedir();
    if (documentId) {
      cwd = getOutputPath(documentId);
    }

    const ptyEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    };

    // Router le shell à travers mxc quand le confinement OS est disponible : le
    // venv et les mappings sont alors refusés au niveau syscall, quel que soit
    // le phrasé de la commande de l'agent. Repli silencieux sur le shell nu si
    // mxc est absent ou si la génération de la politique échoue.
    let sandbox = null;
    if (mxcSandbox.isMxcAvailable()) {
      try {
        sandbox = mxcSandbox.buildSandboxConfig({
          shell: userInfo.shell,
          cwd,
          documentId,
          env: ptyEnv,
          resolveCaseRoot: getOutputPath,
        });
      } catch (error) {
        console.warn('⚠️ [PTY] Politique mxc non générée, session non confinée:', error.message);
        sandbox = null;
      }
    }

    const spawnFile = sandbox ? sandbox.mxcPath : userInfo.shell;
    const spawnArgs = sandbox ? sandbox.args : [];
    const ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: cols,
      rows: rows,
      cwd,
      env: ptyEnv
    });
    console.log(sandbox
      ? `🔒 [PTY] Session confinée via mxc (${mxcSandbox.containmentBackend()})`
      : '🔓 [PTY] Session non confinée (mxc indisponible — protection par hooks uniquement)');
    ws.send(JSON.stringify({ 
      type: 'pty-config', 
      fontSize: 10  // Taille en pixels (par défaut 15)
    }));
    console.log(`🚀 [PTY] Terminal créé (PID: ${ptyProcess.pid}, shell: ${userInfo.shell})`);

    // Envoyer les données du terminal au client
    ptyProcess.onData((data) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(JSON.stringify({ type: 'pty-output', data }));
      }
    });

    // Gérer la fin du processus
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`🛑 [PTY] Terminal fermé (code: ${exitCode}, signal: ${signal})`);
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'pty-exit', exitCode, signal }));
      }
      if (sandbox) sandbox.cleanup();
      ptyTerminals.delete(ws);
    });

    ptyTerminals.set(ws, ptyProcess);
    return ptyProcess;
  } catch (error) {
    console.error('❌ [PTY] Erreur création terminal:', error);
    ws.send(JSON.stringify({ type: 'pty-error', error: error.message }));
    return null;
  }
}

// Fonction pour redimensionner le terminal
function resizePtyTerminal(ws, cols, rows) {
  const ptyProcess = ptyTerminals.get(ws);
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows);
      console.log(`📐 [PTY] Redimensionné: ${cols}x${rows}`);
    } catch (error) {
      console.error('❌ [PTY] Erreur redimensionnement:', error);
    }
  }
}

// Fonction pour envoyer des données au terminal
function writeToPty(ws, data) {
  const ptyProcess = ptyTerminals.get(ws);
  if (ptyProcess) {
    ptyProcess.write(data);
  }
}

// Fonction pour fermer le terminal
function closePtyTerminal(ws) {
  const ptyProcess = ptyTerminals.get(ws);
  if (ptyProcess) {
    console.log(`🛑 [PTY] Fermeture terminal (PID: ${ptyProcess.pid})`);
    ptyProcess.kill();
    ptyTerminals.delete(ws);
  }
}

// ============================================
// PYTHON SCRIPT BRIDGE
// ============================================
// Script registry — to add a new script, add an entry here.
// Each entry: { path, python, description }
//   path   — absolute path to the .py file (env-overridable)
//   python — interpreter binary (env-overridable via PYTHON_PATH)
//   description — human-readable label
const PYTHON_SCRIPTS = {
  convert: {
    path: process.env.SMART_CONVERTER_PATH || path.join(__dirname, 'scripts', 'smart_converter.py'),
    python: process.env.PYTHON_PATH || 'python3',
    description: 'Smart Document Converter — auto-routes to markitdown or MinerU'
  },
  'convert-scan': {
    path: path.join(__dirname, 'scripts', 'convert_and_scan_pipeline.py'),
    python: process.env.PYTHON_PATH || 'python3',
    description: 'Convert & Scan Pipeline — convert to Markdown + PII scan'
  }
  // Exemple pour ajouter un nouveau script :
  // myscript: {
  //   path: process.env.MYSCRIPT_PATH || '/chemin/vers/myscript.py',
  //   python: process.env.PYTHON_PATH || 'python3',
  //   description: 'Description de mon script'
  // }
};

// Active Python processes — Map<jobId, { process: ChildProcess, ws: WebSocket }>
const pythonProcesses = new Map();

// ── Validate documentId format to prevent directory traversal ──────────────
function sanitizeDocumentId(docId) {
  if (!docId || typeof docId !== 'string') return null;
  if (!/^doc_\d+_[a-z0-9]+$/i.test(docId)) return null;
  return docId;
}

// ── REST: upload a file for the Python bridge ─────────────────────────────
app.post('/api/python/upload', express.raw({ type: 'application/octet-stream', limit: '100mb' }), (req, res) => {
  try {
    const raw = decodeURIComponent(req.headers['x-filename'] || 'upload.pdf');
    const safeName = path.basename(raw); // prevent directory-traversal
    const documentId = sanitizeDocumentId(req.headers['x-document-id']);

    if (!documentId) return res.status(400).json({ error: 'X-Document-Id requis pour rattacher le fichier à un dossier juridique.' });
    const destDir = path.join(getOutputPath(documentId), ORIGINALS_SUBFOLDER);
    fs.mkdirSync(destDir, { recursive: true });

    const dest = path.join(destDir, safeName);
    fs.writeFileSync(dest, req.body);
    console.log(`📤 [PYTHON] Fichier uploadé: ${dest} (${req.body.length} octets)`);
    res.json({ filePath: dest });
  } catch (error) {
    console.error('❌ [PYTHON] Erreur upload:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── REST: list registered scripts (useful for a future dynamic selector) ──
app.get('/api/python/scripts', (req, res) => {
  const list = Object.entries(PYTHON_SCRIPTS).map(([id, def]) => ({
    id,
    description: def.description
  }));
  res.json({ scripts: list });
});

// ── REST: warmup status endpoint ────────────────────────────────────────────
app.get('/api/warmup/status', (req, res) => {
  const cacheStatus = checkModelCacheStatus();
  
  res.json({
    warmup: {
      status: warmupState.status,
      result: warmupState.result,
      startTime: warmupState.startTime,
      endTime: warmupState.endTime
    },
    cache: cacheStatus,
    ready: cacheStatus.ready === true || warmupState.result?.success === true
  });
});

// ── REST: trigger warmup manually ──────────────────────────────────────────
app.post('/api/warmup/run', (req, res) => {
  if (warmupState.status === 'running') {
    res.json({ success: false, message: 'Warmup already running' });
    return;
  }
  
  // Reset state for manual re-run
  warmupState.status = 'pending';
  warmupState.result = null;
  initWarmupPromise();
  
  runWarmupAsync();
  res.json({ success: true, message: 'Warmup started' });
});

// ── Spawn & stream a Python script ─────────────────────────────────────────
async function executePythonScript(ws, jobId, scriptId, filePath, options = {}, documentId = null) {
  // Wait for warmup to complete before executing any script
  await waitForWarmup();
  
  const scriptDef = PYTHON_SCRIPTS[scriptId];
  if (!scriptDef) {
    ws.send(JSON.stringify({ type: 'python-error', jobId, error: `Script inconnu: ${scriptId}` }));
    return;
  }

  if (!fs.existsSync(scriptDef.path)) {
    ws.send(JSON.stringify({ type: 'python-error', jobId, error: `Script non trouvé: ${scriptDef.path}` }));
    return;
  }

  if (!fs.existsSync(filePath)) {
    ws.send(JSON.stringify({ type: 'python-error', jobId, error: `Fichier source non trouvé: ${filePath}` }));
    return;
  }

  if (!documentId) {
    ws.send(JSON.stringify({ type: 'python-error', jobId, error: 'Document sans dossier juridique actif.' }));
    return;
  }
  const outputDir = getOutputPath(documentId);
  fs.mkdirSync(outputDir, { recursive: true });

  // ── Build args — add scriptId-specific mappings here when new scripts arrive
  const args = [scriptDef.path, filePath, '-o', outputDir];
  if (scriptId === 'convert') {
    if (options.mode) args.push('--mode', options.mode);
    if (options.lang) args.push('--lang', options.lang);
    if (options.engine) args.push('--engine', options.engine);
  }

  console.log(`🐍 [PYTHON] Lancement (jobId: ${jobId}): ${scriptDef.python} ${args.join(' ')}`);

  const child = spawn(scriptDef.python, args, {
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
  pythonProcesses.set(jobId, { process: child, ws });

  child.stdout.on('data', (data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'python-output', jobId, stream: 'stdout', data: data.toString() }));
    }
  });

  child.stderr.on('data', (data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'python-output', jobId, stream: 'stderr', data: data.toString() }));
    }
  });

  child.on('close', (code) => {
    pythonProcesses.delete(jobId);
    console.log(`🐍 [PYTHON] Terminé (jobId: ${jobId}, exitCode: ${code})`);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'python-done', jobId, exitCode: code, outputDir }));
    }
  });

  child.on('error', (err) => {
    pythonProcesses.delete(jobId);
    console.error(`❌ [PYTHON] Erreur spawn (jobId: ${jobId}):`, err.message);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'python-error', jobId, error: err.message }));
    }
  });
}

function cancelPythonScript(jobId) {
  const entry = pythonProcesses.get(jobId);
  if (entry) {
    console.log(`🛑 [PYTHON] Annulation (jobId: ${jobId})`);
    entry.process.kill('SIGTERM');
    pythonProcesses.delete(jobId);
  }
}

// Kill every Python process spawned on behalf of a disconnecting WebSocket
function cleanupPythonProcesses(ws) {
  for (const [jobId, entry] of pythonProcesses.entries()) {
    if (entry.ws === ws) {
      entry.process.kill('SIGTERM');
      pythonProcesses.delete(jobId);
    }
  }
}

// ============================================================================
// WARMUP - Model downloading on startup (state-based coordination)
// ============================================================================

let warmupState = {
  status: 'pending', // 'pending' | 'running' | 'completed' | 'failed'
  promise: null,
  resolvePromise: null,
  result: null,
  startTime: null,
  endTime: null
};

// Initialize the warmup promise
function initWarmupPromise() {
  warmupState.promise = new Promise((resolve) => {
    warmupState.resolvePromise = resolve;
  });
}

// Wait for warmup to complete (no timeout)
async function waitForWarmup() {
  if (warmupState.status === 'completed' || warmupState.status === 'failed') {
    return warmupState.result;
  }
  // Hang/wait until warmup completes
  return warmupState.promise;
}

function runWarmupAsync() {
  const warmupPath = path.join(__dirname, 'scripts', 'warmup.py');
  
  // Initialize promise for scripts to await
  initWarmupPromise();
  
  if (!fs.existsSync(warmupPath)) {
    warmupState.status = 'failed';
    warmupState.result = { success: false, error: 'Warmup script not found' };
    warmupState.resolvePromise(warmupState.result);
    return;
  }
  
  warmupState.status = 'running';
  warmupState.startTime = Date.now();
  
  const python = process.env.PYTHON_PATH || 'python3';
  const child = spawn(python, [warmupPath], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  child.stdout.on('data', (data) => {
    // Silent output - only errors are logged
  });
  
  child.stderr.on('data', (data) => {
    // Log warmup errors only
    const output = data.toString().trim();
    if (output) {
      console.error(`[WARMUP ERROR] ${output}`);
    }
  });
  
  child.on('close', (code) => {
    warmupState.endTime = Date.now();
    
    if (code === 0) {
      warmupState.status = 'completed';
      warmupState.result = { success: true };
    } else {
      warmupState.status = 'failed';
      warmupState.result = { success: false, exitCode: code };
    }
    
    // Resolve the promise so waiting scripts can proceed
    warmupState.resolvePromise(warmupState.result);
  });
  
  child.on('error', (err) => {
    warmupState.status = 'failed';
    warmupState.endTime = Date.now();
    warmupState.result = { success: false, error: err.message };
    console.error(`[WARMUP ERROR] ${err.message}`);
    
    // Resolve the promise so waiting scripts can proceed
    warmupState.resolvePromise(warmupState.result);
  });
}

// Check if models are cached (synchronous check)
function checkModelCacheStatus() {
  const warmupPath = path.join(__dirname, 'scripts', 'warmup.py');
  if (!fs.existsSync(warmupPath)) {
    return { error: 'Warmup script not found' };
  }
  
  try {
    const python = process.env.PYTHON_PATH || 'python3';
    const result = spawn.sync(python, [warmupPath, '--status'], {
      encoding: 'utf8',
      timeout: 10000
    });
    
    if (result.status === 0) {
      return JSON.parse(result.stdout);
    }
    return { error: 'Failed to check status', exitCode: result.status };
  } catch (err) {
    return { error: err.message };
  }
}

// Démarrer le serveur HTTPS
const server = https.createServer(options, app);

// Node ferme les sockets keep-alive inactives au bout de 5 s par défaut : le
// navigateur qui réutilise la sienne après une pause (l'administration passe
// des minutes sans requête) voit alors « The network connection was lost ».
// On tient la socket plus longtemps que l'inactivité typique de l'UI, et
// headersTimeout reste au-dessus pour ne pas couper une requête en cours.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// Configurer WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('✅ Client Word connecté via WebSocket');
  wordClients.add(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // Gérer les messages du terminal PTY
      switch (data.type) {
        case 'pty-start': {
          // Démarrer un nouveau terminal
          const cols = data.cols || 80;
          const rows = data.rows || 24;
          const ptyDocId = sanitizeDocumentId(data.documentId);
          createPtyTerminal(ws, cols, rows, ptyDocId);
          break;
        }

        case 'pty-input':
          // Envoyer des données au terminal
          writeToPty(ws, data.data);
          break;

        case 'pty-resize':
          // Redimensionner le terminal
          resizePtyTerminal(ws, data.cols, data.rows);
          break;

        case 'pty-stop':
          // Fermer le terminal
          closePtyTerminal(ws);
          break;

        case 'pane-hello': {
          const panePath = docUrlToPath(data.docUrl);
          console.log(`📋 pane-hello reçu — docUrl: ${data.docUrl || '(absent)'} → panePath: ${panePath || '(null)'}`);
          if (panePath) {
            const registration = wordPaneRegistry.register(ws, panePath, data.paneId);
            ws.send(JSON.stringify({ type: 'pane-bound', paneId: registration.paneId }));
          } else {
            console.warn('⚠️ Volet Word non routable : Office.context.document.url est absent.');
          }
          break;
        }

        case 'python-exec':
          executePythonScript(ws, data.jobId, data.scriptId, data.filePath, data.options || {}, sanitizeDocumentId(data.documentId));
          break;

        case 'python-exec-batch': {
          const batchDocId = sanitizeDocumentId(data.documentId);
          const { jobId: batchJobId, scriptId: batchScriptId, filePaths, fileNames, options: batchOptions } = data;
          const totalFiles = filePaths.length;
          let successCount = 0;
          let lastOutputDir = null;

          (async () => {
            // Wait for warmup to complete before executing batch
            await waitForWarmup();
            
            for (let i = 0; i < totalFiles; i++) {
              const fileName = fileNames?.[i] || path.basename(filePaths[i]);
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'python-batch-file-start', jobId: batchJobId, fileName, fileIndex: i, totalFiles }));
              }

              const fileJobId = batchJobId + '_f' + i;
              const exitCode = await new Promise((resolve) => {
                // Reuse executePythonScript but intercept its messages
                const scriptDef = PYTHON_SCRIPTS[batchScriptId];
                if (!scriptDef || !fs.existsSync(scriptDef.path) || !fs.existsSync(filePaths[i])) {
                  resolve(1);
                  return;
                }

                if (!batchDocId) {
                  resolve(1);
                  return;
                }
                const outputDir = getOutputPath(batchDocId);
                fs.mkdirSync(outputDir, { recursive: true });
                lastOutputDir = outputDir;

                const args = [scriptDef.path, filePaths[i], '-o', outputDir];
                if (batchScriptId === 'convert' || batchScriptId === 'convert-scan') {
                  if (batchOptions?.mode) args.push('--mode', batchOptions.mode);
                  if (batchOptions?.lang) args.push('--lang', batchOptions.lang);
                  if (batchOptions?.engine) args.push('--engine', batchOptions.engine);
                }
                if (batchScriptId === 'convert-scan' && batchDocId) {
                  args.push('--document-id', batchDocId);
                  args.push('--mapping-dir', outputDir);
                }

                const child = spawn(scriptDef.python, args, {
                  env: { ...process.env, PYTHONUNBUFFERED: '1' }
                });
                child.stdout.on('data', (d) => {
                  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'python-output', jobId: batchJobId, stream: 'stdout', data: d.toString() }));
                });
                child.stderr.on('data', (d) => {
                  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'python-output', jobId: batchJobId, stream: 'stderr', data: d.toString() }));
                });
                child.on('close', (code) => resolve(code));
                child.on('error', () => resolve(1));
              });

              if (exitCode === 0) successCount++;
              if (ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'python-batch-file-complete', jobId: batchJobId, fileName, fileIndex: i, totalFiles, exitCode }));
              }
            }

            // Load mapping into memory so GET /api/anonymize/mapping/:documentId works immediately
            if (batchScriptId === 'convert-scan' && batchDocId && successCount > 0) {
              const mappingPath = path.join(getOutputPath(batchDocId), `mapping_${batchDocId}.json`);
              if (fs.existsSync(mappingPath)) {
                try {
                  const data = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
                  anonymizationMappings.set(batchDocId, {
                    mapping: data.mapping,
                    reverse_mapping: data.reverse_mapping,
                    extracted_data: data.extracted_data || {},
                    timestamp: new Date().toISOString()
                  });
                  console.log(`✅ Mapping loaded into memory for document ${batchDocId}`);
                } catch (e) {
                  console.error(`⚠️ Failed to load mapping for ${batchDocId}:`, e.message);
                }
              }
            }

            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'python-batch-complete', jobId: batchJobId, successCount, totalFiles, outputDir: lastOutputDir }));
            }
          })();
          break;
        }

        case 'python-cancel':
          cancelPythonScript(data.jobId);
          break;

        default:
          // Les réponses Word sont déjà consommées par l'écouteur corrélé à
          // requestId de la route HTTP. Elles n'ont pas de `type` et ne sont
          // donc pas des messages inconnus.
          if (!isWordToolResponse(data)) {
            console.warn('⚠️ Message WebSocket inconnu:', describeUnknownWebSocketMessage(data));
          }
      }
    } catch (error) {
      console.error('Erreur parsing message WebSocket:', error);
    }
  });

  ws.on('close', () => {
    console.log('❌ Client Word déconnecté');
    closePtyTerminal(ws);
    cleanupPythonProcesses(ws);
    wordClients.delete(ws);
    wordPaneRegistry.remove(ws);
  });

  ws.on('error', (error) => {
    console.error('Erreur WebSocket:', error);
    closePtyTerminal(ws);
    cleanupPythonProcesses(ws);
    wordClients.delete(ws);
    wordPaneRegistry.remove(ws);
  });

  // Envoyer un message de bienvenue
  ws.send(JSON.stringify({ type: 'connected', message: 'Connecté au serveur MCP' }));
});

function writeRuntimePid() {
  fs.mkdirSync(PIECEMAKER_HOME, { recursive: true });
  fs.writeFileSync(PID_PATH, `${process.pid}\n`, 'utf8');
}

function removeRuntimePid() {
  try {
    if (Number.parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(PID_PATH);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`⚠️ PID non nettoyé : ${error.message}`);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 Arrêt PieceMaker (${signal})...`);
  for (const client of wss.clients) client.close(1001, 'Server shutdown');
  server.close(() => {
    removeRuntimePid();
    process.exit(0);
  });
  setTimeout(() => {
    removeRuntimePid();
    process.exit(1);
  }, 3000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('exit', removeRuntimePid);
server.once('error', (error) => {
  removeRuntimePid();
  console.error(`❌ Impossible de démarrer le serveur HTTPS : ${error.message}`);
});
wss.once('error', (error) => {
  removeRuntimePid();
  console.error(`❌ Erreur WebSocket : ${error.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  writeRuntimePid();
  console.log('');
  console.log('🎉 ========================================');
  console.log('   MCP Proxy Word - Serveur Local HTTPS');
  console.log('========================================');
  console.log('');
  console.log(`✅ Serveur démarré : https://localhost:${PORT} (${HOST})`);
  console.log(`⚙️  Administration  : https://localhost:${PORT}/admin/`);
  console.log(`🔌 WebSocket prêt : wss://localhost:${PORT}`);
  console.log(`📄 Complément Word : https://localhost:${PORT}/taskpane.html`);
  console.log(`🧪 Page de test    : https://localhost:${PORT}/test.html`);
  console.log(`❤️  Health check   : https://localhost:${PORT}/health`);
  console.log(`🚀 Warmup status   : https://localhost:${PORT}/api/warmup/status`);
  console.log('');
  console.log('📋 Prochaines étapes :');
  console.log(`   1. Modifier manifest.xml avec : https://localhost:${PORT}`);
  console.log('   2. Installer manifest.xml dans Word');
  console.log('   3. Ouvrir le complément et tester');
  console.log('');
  console.log('⚠️  Si avertissement SSL : accepter l\'exception');
  console.log('🛑 Arrêter : Ctrl+C');
  console.log('');
  console.log('========================================');
  console.log('');
  console.log('🔧 Jobs d\'anonymisation : nettoyage auto toutes les 15 min');
  console.log('');
  
  // Start warmup in background (disabled only by isolated smoke tests).
  if (process.env.PIECEMAKER_SKIP_WARMUP !== '1') runWarmupAsync();
});

// ============================================================================
// ROUTES API POUR L'ÉTAT DU DRAFT
// ============================================================================

// Sauvegarder l'état du draft
app.post('/api/draft-state/:docId', (req, res) => {
  try {
    const { docId } = req.params;
    const state = req.body;

    const stateDir = path.join(getOutputPath(docId), '.piecemaker', 'draft_states');

    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }

    const stateFile = path.join(stateDir, `${docId}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    console.log('[POST /api/draft-state] ✅ État sauvegardé:', docId);
    res.json({ success: true, message: 'État sauvegardé' });
  } catch (error) {
    console.error('[POST /api/draft-state] ❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

// Charger l'état du draft
app.get('/api/draft-state/:docId', (req, res) => {
  try {
    const { docId } = req.params;
    const stateDir = path.join(getOutputPath(docId), '.piecemaker', 'draft_states');
    const stateFile = path.join(stateDir, `${docId}.json`);

    if (!fs.existsSync(stateFile)) {
      return res.status(404).json({ error: 'État non trouvé' });
    }

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    console.log('[GET /api/draft-state] ✅ État chargé:', docId);
    res.json(state);
  } catch (error) {
    console.error('[GET /api/draft-state] ❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

// Supprimer l'état du draft
app.delete('/api/draft-state/:docId', (req, res) => {
  try {
    const { docId } = req.params;
    const stateDir = path.join(getOutputPath(docId), '.piecemaker', 'draft_states');
    const stateFile = path.join(stateDir, `${docId}.json`);

    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
      console.log('[DELETE /api/draft-state] ✅ État supprimé:', docId);
    }

    res.json({ success: true, message: 'État supprimé' });
  } catch (error) {
    console.error('[DELETE /api/draft-state] ❌ Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

// Gestion propre de l'arrêt
process.on('SIGINT', () => {
  console.log('');
  console.log('🛑 Arrêt du serveur...');
  process.exit(0);
});

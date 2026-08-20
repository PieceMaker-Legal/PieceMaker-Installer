'use strict';

/**
 * word-launcher.cjs — deux responsabilités distinctes :
 *
 *  1. ENREGISTREMENT DÉVELOPPEUR de l'add-in PieceMaker sur le poste. C'est
 *     l'étape unique qui permet à la référence webextension écrite dans un
 *     .docx (store="developer" storeType="Registry", voir docx-autoopen.cjs)
 *     de se résoudre, et donc au volet de s'ouvrir tout seul.
 *
 *     Cet enregistrement est entièrement DÉLÉGUÉ à l'outillage officiel
 *     `office-addin-dev-settings` — le même moteur que celui utilisé par
 *     `office-addin-debugging start`, la commande que lance
 *     `npm start --prefix taskpane`. Il n'y a plus de code d'écriture natif
 *     (lien dans le dossier « wef » sur macOS, `reg add` sur Windows) : une
 *     seule implémentation, celle de Microsoft, sert les deux chemins
 *     (installeur / serveur d'un côté, CLI de développement de l'autre), ce qui
 *     élimine toute divergence entre eux.
 *
 *     Ce que l'outil fait réellement, pour mémoire :
 *       - macOS   : lien dur du manifeste dans
 *                   ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
 *                   sous le nom `<Id du manifeste>.<nom du manifeste>` ;
 *       - Windows : valeur REG_SZ sous
 *                   HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer, dont le
 *                   NOM est l'<Id> du manifeste et la DONNÉE son chemin.
 *                   (L'ancien code PieceMaker écrivait nom == donnée == chemin ;
 *                   l'outil supprime explicitement cette forme héritée avant
 *                   d'écrire la sienne. Word lit les deux.)
 *
 *  2. LANCEMENT DE WORD sur un document donné, et mise au premier plan.
 *     Sans équivalent dans l'outillage Office (`office-addin-debugging
 *     --document` copie le fichier dans un dossier temporaire), donc conservé
 *     tel quel. Consommé par websocket-server/server.cjs (/api/word/open-doc).
 *
 * Les fonctions d'enregistrement sont ASYNCHRONES (l'API office-addin-dev-settings
 * l'est) ; launchWord/activateWord restent synchrones.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const WORD_APP_MAC = 'Microsoft Word';

/**
 * Dossier de sideload de Word sur macOS. Purement informatif (diagnostics,
 * messages d'erreur) : plus rien n'y écrit ici, c'est office-addin-dev-settings
 * qui le gère.
 */
function macWefDir() {
  return path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef');
}

/**
 * Chargement paresseux de l'outillage Office. Paresseux à dessein : le module
 * lit le registre / le système de fichiers à l'import, et le serveur doit
 * pouvoir démarrer même si les dépendances de développement manquent.
 */
function loadDevSettings() {
  return require('office-addin-dev-settings');
}

function unsupportedPlatform() {
  return process.platform !== 'darwin' && process.platform !== 'win32';
}

function methodForPlatform() {
  return process.platform === 'darwin' ? 'wef' : 'registry';
}

/**
 * Enregistre l'add-in pour le développement Office sur ce poste, si ce n'est
 * pas déjà fait. Idempotent.
 *
 * @returns {Promise<{registered:boolean, alreadyRegistered?:boolean,
 *                    method:'wef'|'registry'|'unsupported', target?:string,
 *                    error?:string}>}
 */
async function ensureDevRegistration(manifestPath, addinId) {
  if (!fs.existsSync(manifestPath)) {
    return { registered: false, method: 'unsupported', error: `Manifest introuvable: ${manifestPath}` };
  }
  if (unsupportedPlatform()) {
    return {
      registered: false,
      method: 'unsupported',
      error: `Plateforme non supportée pour Word: ${process.platform}`,
    };
  }

  const method = methodForPlatform();
  try {
    if (await isDevRegistered(manifestPath, addinId)) {
      return { registered: true, alreadyRegistered: true, method, target: manifestPath };
    }
    await loadDevSettings().registerAddIn(manifestPath);
    return { registered: true, alreadyRegistered: false, method, target: manifestPath };
  } catch (err) {
    return {
      registered: false,
      method,
      error: `Enregistrement via office-addin-dev-settings impossible : ${err && err.message ? err.message : err}`,
    };
  }
}

/**
 * Retire l'enregistrement développeur. Équivalent programmatique de
 * `npm run stop --prefix taskpane`. Ne jette jamais.
 */
async function removeDevRegistration(manifestPath) {
  if (unsupportedPlatform()) return { unregistered: false, method: 'unsupported' };
  try {
    await loadDevSettings().unregisterAddIn(manifestPath);
    return { unregistered: true, method: methodForPlatform() };
  } catch (err) {
    return {
      unregistered: false,
      method: methodForPlatform(),
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Sonde en lecture seule : l'add-in est-il déjà enregistré pour le
 * développement ? Utilisée par check() de l'installeur et par les diagnostics.
 * Ne jette jamais — renvoie false en cas de doute.
 *
 * @returns {Promise<boolean>}
 */
async function isDevRegistered(manifestPath, addinId) {
  if (unsupportedPlatform()) return false;
  try {
    const registered = await loadDevSettings().getRegisteredAddIns();
    const wanted = path.resolve(manifestPath);
    return registered.some((entry) => {
      if (addinId && entry.id && entry.id.toLowerCase() === String(addinId).toLowerCase()) return true;
      if (!entry.manifestPath) return false;
      return path.resolve(entry.manifestPath) === wanted;
    });
  } catch {
    return false;
  }
}

/**
 * Lance Word sur `docPath` et met l'application au premier plan. Non bloquant.
 * Returns { launched:boolean, method:string, error?:string }.
 */
function launchWord(docPath) {
  if (!fs.existsSync(docPath)) {
    return { launched: false, error: `Document introuvable: ${docPath}` };
  }
  try {
    if (process.platform === 'darwin') {
      // `open -a` launches or reuses Word, opens the doc, and brings it front.
      const res = spawnSync('open', ['-a', WORD_APP_MAC, docPath], { encoding: 'utf8' });
      if (res.status !== 0) {
        return { launched: false, method: 'open', error: (res.stderr || '').trim() || `open a échoué (code ${res.status})` };
      }
      return { launched: true, method: 'open' };
    }
    if (process.platform === 'win32') {
      // `start "" "<doc>"` opens with the default handler (Word) and focuses it.
      // detached so the server process isn't tied to the shell.
      const child = spawn('cmd', ['/c', 'start', '', docPath], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false });
      child.unref();
      return { launched: true, method: 'start' };
    }
    return { launched: false, error: `Plateforme non supportée pour Word: ${process.platform}` };
  } catch (err) {
    return { launched: false, error: err.message };
  }
}

/**
 * Best-effort: bring Word (and thus the just-opened active document) to the
 * foreground. On macOS this uses AppleScript; on Windows the `start` verb
 * already focuses. Never throws.
 */
function activateWord() {
  if (process.platform === 'darwin') {
    try {
      spawnSync('osascript', ['-e', `tell application "${WORD_APP_MAC}" to activate`], { encoding: 'utf8', timeout: 5000 });
    } catch {
      /* best effort */
    }
  }
}

module.exports = {
  ensureDevRegistration,
  removeDevRegistration,
  isDevRegistered,
  launchWord,
  activateWord,
  macWefDir,
};

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

const MAC_SHOW_TASKPANE_SCRIPT = `
on run argv
  set documentPath to item 1 of argv
  set buttonLabel to item 2 of argv
  set targetHfsPath to (POSIX file documentPath as alias) as text

  tell application "${WORD_APP_MAC}"
    set matchingDocuments to every document whose full name is targetHfsPath
    if (count of matchingDocuments) is 0 then error "Document Word introuvable: " & documentPath
    activate
    activate object (item 1 of matchingDocuments)
  end tell

  delay 0.5
  tell application "System Events"
    tell process "${WORD_APP_MAC}"
      set frontmost to true
      tell tab group 1 of window 1
        if value of radio button 1 is not 1 then click radio button 1
        set ribbonReady to false
        repeat 20 times
          if exists scroll area 1 then
            set ribbonReady to true
            exit repeat
          end if
          delay 0.2
        end repeat
        if ribbonReady is false then error "Ruban Word indisponible"
        repeat with ribbonGroup in every group of scroll area 1
          if exists button buttonLabel of ribbonGroup then
            click button buttonLabel of ribbonGroup
            return "clicked"
          end if
        end repeat
      end tell
    end tell
  end tell

  error "Bouton PieceMaker introuvable dans le ruban Word"
end run
`.trim();

/**
 * Word pour Mac n'auto-ouvre parfois que le premier exemplaire d'un même
 * complément quand plusieurs documents sont ouverts. Le bouton ShowTaskpane
 * du manifeste reste toutefois disponible dans chaque fenêtre. Ce fallback
 * active le document par son chemin complet (pas par son seul nom), puis
 * déclenche ce bouton via l'API d'accessibilité macOS.
 *
 * Ne jette jamais. `options` permet d'injecter la plateforme et spawnSync dans
 * les tests sans lancer Word.
 */
function showTaskpaneForDocument(docPath, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const buttonLabel = options.buttonLabel || 'Ouvrir PieceMaker';

  if (platform !== 'darwin') {
    return { shown: false, method: 'unsupported' };
  }
  if (!fs.existsSync(docPath)) {
    return { shown: false, method: 'ribbon-applescript', error: `Document introuvable: ${docPath}` };
  }

  try {
    const result = spawnSyncImpl('osascript', [
      '-e',
      MAC_SHOW_TASKPANE_SCRIPT,
      '--',
      docPath,
      buttonLabel,
    ], { encoding: 'utf8', timeout: 10000 });
    if (result.status !== 0) {
      return {
        shown: false,
        method: 'ribbon-applescript',
        error: (result.stderr || result.error?.message || `osascript a échoué (code ${result.status})`).trim(),
      };
    }
    return { shown: true, method: 'ribbon-applescript' };
  } catch (error) {
    return { shown: false, method: 'ribbon-applescript', error: error.message };
  }
}

module.exports = {
  ensureDevRegistration,
  removeDevRegistration,
  isDevRegistered,
  launchWord,
  activateWord,
  showTaskpaneForDocument,
  macWefDir,
};

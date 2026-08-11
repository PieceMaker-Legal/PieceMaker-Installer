'use strict';

/**
 * word-launcher.cjs — cross-platform helpers to (1) register the PieceMaker
 * add-in for Office *development* (the one-time step that lets an embedded
 * webextension reference resolve, see docx-autoopen.cjs and the
 * word-taskpane-autoopen mechanism) and (2) launch Microsoft Word on a given
 * document, bringing it to the front.
 *
 * Registration is done natively — no dependency on office-addin-dev-settings —
 * replicating exactly what that tool writes:
 *   - macOS:   a hard link (fallback: copy) of the manifest at
 *              ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
 *              <addinId>.<manifestBasename>
 *   - Windows: a REG_SZ value under
 *              HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer whose *name*
 *              and *data* are both the manifest path (that name==data shape is
 *              how the tooling recognises a manifest-path registration).
 *
 * Only "developer" registration is needed; storeType="Registry" in the embedded
 * doc resolves against it on both platforms.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const WORD_APP_MAC = 'Microsoft Word';
const WIN_DEV_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\Wef\\Developer';

function macWefDir() {
  return path.join(os.homedir(), 'Library/Containers/com.microsoft.Word/Data/Documents/wef');
}

/**
 * Ensure the add-in is registered for Office development on this machine.
 * Idempotent. Returns { registered:boolean, alreadyRegistered:boolean,
 * method:'wef'|'registry'|'unsupported', target?:string, error?:string }.
 */
function ensureDevRegistration(manifestPath, addinId) {
  if (!fs.existsSync(manifestPath)) {
    return { registered: false, method: 'unsupported', error: `Manifest introuvable: ${manifestPath}` };
  }
  if (process.platform === 'darwin') {
    return registerMac(manifestPath, addinId);
  }
  if (process.platform === 'win32') {
    return registerWindows(manifestPath);
  }
  return { registered: false, method: 'unsupported', error: `Plateforme non supportée pour Word: ${process.platform}` };
}

function registerMac(manifestPath, addinId) {
  const wef = macWefDir();
  try {
    fs.mkdirSync(wef, { recursive: true });
  } catch (err) {
    return { registered: false, method: 'wef', error: `Impossible de créer ${wef}: ${err.message}` };
  }
  const target = path.join(wef, `${addinId}.${path.basename(manifestPath)}`);
  if (fs.existsSync(target)) {
    return { registered: true, alreadyRegistered: true, method: 'wef', target };
  }
  // Prefer a hard link (what the tooling does — later manifest edits stay in
  // sync); fall back to a copy across filesystems or when linking is refused.
  try {
    fs.linkSync(manifestPath, target);
  } catch {
    try {
      fs.copyFileSync(manifestPath, target);
    } catch (err) {
      return { registered: false, method: 'wef', error: `Échec de l'enregistrement wef: ${err.message}` };
    }
  }
  return { registered: true, alreadyRegistered: false, method: 'wef', target };
}

function registerWindows(manifestPath) {
  // Idempotent: `reg add … /f` overwrites without prompting. name==data==path.
  const res = spawnSync('reg', ['add', WIN_DEV_KEY, '/v', manifestPath, '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    encoding: 'utf8',
  });
  if (res.status === 0) {
    return { registered: true, method: 'registry', target: `${WIN_DEV_KEY}\\${manifestPath}` };
  }
  return {
    registered: false,
    method: 'registry',
    error: `reg add a échoué (code ${res.status}): ${(res.stderr || res.stdout || '').trim()}`,
  };
}

/**
 * Non-mutating check: is the add-in already registered for development on this
 * machine? Used by the installer's check() and diagnostics. Returns a boolean;
 * on unsupported platforms returns false.
 */
function isDevRegistered(manifestPath, addinId) {
  if (process.platform === 'darwin') {
    try {
      return fs.existsSync(path.join(macWefDir(), `${addinId}.${path.basename(manifestPath)}`));
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') {
    const res = spawnSync('reg', ['query', WIN_DEV_KEY, '/v', manifestPath], { encoding: 'utf8' });
    return res.status === 0;
  }
  return false;
}

/**
 * Launch Word on `docPath`, bringing the app to the front. Non-blocking.
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

module.exports = { ensureDevRegistration, isDevRegistered, launchWord, activateWord, macWefDir };

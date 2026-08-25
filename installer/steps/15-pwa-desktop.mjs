/**
 * Étape 15 — application native PieceMaker sur le Bureau.
 *
 * Compile une app Swift (WKWebView) si swiftc est disponible, sinon un
 * lanceur shell qui ouvre le navigateur. Le gestionnaire de protocole
 * `piecemaker:` permet à la page hors ligne de relancer le serveur.
 */

import { installDesktopLauncher, desktopLauncherStatus } from '../lib/desktop-launcher.mjs';
import { confirm } from '../lib/prompt.mjs';
import { log } from '../lib/ui.mjs';

export const meta = {
  id: '15-pwa-desktop',
  label: 'Application PieceMaker sur le Bureau',
  description: `Installe une application native (WKWebView) qui démarre le serveur et affiche l'administration`,
  required: false,
};

function launcherResult(result, action = 'créée') {
  const mode = result.native ? 'native (WKWebView)' : 'lanceur navigateur';
  if (!result.protocolReady) {
    return {
      status: 'partial',
      note: `Application ${mode} ${action} (${result.shortcut}), mais le protocole piecemaker: n'a pas pu être enregistré${result.protocolError ? ` : ${result.protocolError}` : '.'}`,
    };
  }
  return { status: 'done', note: `Application ${mode} ${action} : ${result.shortcut}` };
}

/**
 * Réinstalle l'application seulement si l'utilisateur l'avait déjà installée.
 * `piecemaker update` peut ainsi rejouer l'étape 15 sans créer un raccourci
 * qui avait été refusé lors de l'installation initiale.
 */
export function refreshInstalledDesktopApplication({
  status = desktopLauncherStatus(),
  installLauncher = installDesktopLauncher,
} = {}) {
  if (!status.shortcutReady && !status.protocolReady) {
    return { status: 'skipped', note: 'Application PieceMaker absente du Bureau.' };
  }
  return launcherResult(installLauncher(), 'mise à jour');
}

export async function install(ctx) {
  if (ctx.dryRun) {
    log.info(`[simulation] proposition d'ajouter PieceMaker au Bureau`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!await confirm(`Installer l'application PieceMaker sur le Bureau ?`, true)) {
    return { status: 'skipped', note: 'Application Bureau refusée.' };
  }

  return launcherResult(installDesktopLauncher());
}

export async function check() {
  const status = desktopLauncherStatus();
  if (status.shortcutReady && status.protocolReady) return { status: 'done', note: status.shortcut };
  if (status.shortcutReady) return { status: 'partial', note: 'Application présente, mais protocole piecemaker: absent.' };
  return { status: 'partial', note: 'Application PieceMaker absente du Bureau.' };
}

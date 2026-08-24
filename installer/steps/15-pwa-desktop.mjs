/**
 * Étape 15 — accès PieceMaker depuis le Bureau et relance depuis la PWA.
 */

import { installDesktopLauncher, desktopLauncherStatus } from '../lib/desktop-launcher.mjs';
import { confirm } from '../lib/prompt.mjs';
import { log } from '../lib/ui.mjs';

export const meta = {
  id: '15-pwa-desktop',
  label: 'Application PieceMaker sur le Bureau',
  description: 'Ajoute une icône qui démarre le serveur local avant d’ouvrir l’administration',
  required: false,
};

export async function install(ctx) {
  if (ctx.dryRun) {
    log.info('[simulation] proposition d’ajouter PieceMaker au Bureau et d’enregistrer le lanceur local de la PWA');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!await confirm('Ajouter l’icône PieceMaker sur le Bureau ?', true)) {
    return { status: 'skipped', note: 'Raccourci Bureau refusé.' };
  }

  const result = installDesktopLauncher();
  if (!result.protocolReady) {
    return {
      status: 'partial',
      note: `Icône créée (${result.shortcut}), mais le bouton de redémarrage PWA n’a pas pu être enregistré${result.protocolError ? ` : ${result.protocolError}` : '.'}`,
    };
  }
  return { status: 'done', note: `Icône créée : ${result.shortcut}` };
}

export async function check() {
  const status = desktopLauncherStatus();
  if (status.shortcutReady && status.protocolReady) return { status: 'done', note: status.shortcut };
  if (status.shortcutReady) return { status: 'partial', note: 'Icône présente, mais lanceur de redémarrage PWA absent.' };
  return { status: 'partial', note: 'Icône PieceMaker absente du Bureau.' };
}

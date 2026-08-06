/**
 * Step 10 — LibreOffice, moteur de conversion des pièces vers PDF.
 *
 * Une pièce Excel ou Word doit être en PDF avant d'être tamponnée
 * (`POST /api/stamping` → `websocket-server/lib/office-to-pdf.cjs`). Les
 * images et le texte brut sont rendus par `pdf-lib`, sans dépendance ; les
 * formats bureautiques exigent LibreOffice en mode headless, comme le font
 * les skills documentaires officielles d'Anthropic (`anthropics/skills`).
 *
 * Cette étape installe LibreOffice avec le gestionnaire de paquets du système
 * (Homebrew, winget, apt/dnf) et enregistre SOFFICE_PATH quand le binaire
 * n'est pas sur le PATH — sur macOS il vit dans le bundle .app.
 */

import { createRequire } from 'node:module';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { commandExists, run, IS_MAC, IS_WINDOWS, REPO_ROOT } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

const require = createRequire(import.meta.url);
const { findSoffice } = require(`${REPO_ROOT}/websocket-server/lib/office-to-pdf.cjs`);

export const meta = {
  id: '10-libreoffice',
  label: 'Conversion des pièces en PDF (LibreOffice)',
  description: 'Installe LibreOffice, requis pour tamponner les pièces Excel et Word',
};

const MANUAL_URL = 'https://www.libreoffice.org/download/download-libreoffice/';

/** Commande d'installation adaptée au système, ou null si aucun gestionnaire connu. */
function installerCommand() {
  if (IS_MAC) {
    if (commandExists('brew')) return { command: 'brew', args: ['install', '--cask', 'libreoffice'], manager: 'Homebrew' };
    return null;
  }
  if (IS_WINDOWS) {
    if (commandExists('winget', ['--version'])) {
      return {
        command: 'winget',
        args: ['install', '-e', '--id', 'TheDocumentFoundation.LibreOffice',
          '--accept-package-agreements', '--accept-source-agreements'],
        manager: 'winget',
      };
    }
    return null;
  }
  if (commandExists('apt-get', ['--version'])) {
    return { command: 'sudo', args: ['apt-get', 'install', '-y', 'libreoffice'], manager: 'apt' };
  }
  if (commandExists('dnf', ['--version'])) {
    return { command: 'sudo', args: ['dnf', 'install', '-y', 'libreoffice'], manager: 'dnf' };
  }
  return null;
}

/** Enregistre SOFFICE_PATH si le binaire n'est pas joignable par son nom seul. */
function recordPath(soffice) {
  if (soffice === 'soffice' || soffice === 'libreoffice') return;
  writeEnv({ SOFFICE_PATH: soffice });
  log.detail(`SOFFICE_PATH enregistré : ${soffice}`);
}

export async function install(ctx) {
  log.step('Vérification de LibreOffice...');

  const existing = findSoffice();
  if (existing) {
    log.ok(`LibreOffice déjà installé (${existing})`);
    recordPath(existing);
    return { status: 'done', note: '' };
  }

  const installer = installerCommand();

  if (ctx.dryRun) {
    log.info(installer
      ? `[simulation] ${installer.command} ${installer.args.join(' ')}`
      : `[simulation] Installation manuelle depuis ${MANUAL_URL}`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!installer) {
    log.warn('Aucun gestionnaire de paquets reconnu pour installer LibreOffice automatiquement.');
    log.detail(`Installez-le depuis ${MANUAL_URL}, puis relancez cette étape.`);
    log.detail('Binaire déjà présent ailleurs ? Renseignez SOFFICE_PATH dans .env');
    return {
      status: 'failed',
      note: `LibreOffice absent — installation manuelle requise (${MANUAL_URL}). Les pièces Excel et Word ne pourront pas être tamponnées.`,
    };
  }

  log.info('LibreOffice convertit les pièces Excel et Word en PDF avant tamponnage (téléchargement de plusieurs centaines de Mo).');
  const accepted = await confirm(`Installer LibreOffice via ${installer.manager} ?`, true);
  if (!accepted) {
    return {
      status: 'partial',
      note: 'LibreOffice non installé — seules les pièces PDF, images et texte pourront être tamponnées.',
    };
  }

  const spin = spinner(`Installation de LibreOffice (${installer.manager})...`);
  const code = await run(installer.command, installer.args, {
    onLine: (line) => spin.update(line.slice(0, 100)),
  });

  const soffice = findSoffice();
  if (code === 0 && soffice) {
    spin.succeed(`LibreOffice installé (${soffice})`);
    recordPath(soffice);
    return { status: 'done', note: '' };
  }

  spin.fail('Installation de LibreOffice échouée');
  log.detail(`Installez-le manuellement depuis ${MANUAL_URL}, puis relancez cette étape.`);
  return {
    status: 'failed',
    note: `LibreOffice n'a pas pu être installé automatiquement (${installer.manager}, code ${code}). Installation manuelle : ${MANUAL_URL}`,
  };
}

export async function check() {
  const soffice = findSoffice();
  if (soffice) return { status: 'done', note: '' };
  return {
    status: 'failed',
    note: 'LibreOffice introuvable — les pièces Excel et Word ne pourront pas être converties en PDF pour le tamponnage.',
  };
}

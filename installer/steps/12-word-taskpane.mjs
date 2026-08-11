/**
 * Step 12 — Ouverture automatique du volet PieceMaker dans Word.
 *
 * Pour qu'une session extérieure (Claude Code) puisse ouvrir Word sur un
 * document et y écrire directement, le volet PieceMaker doit s'afficher tout
 * seul, sans clic sur le ruban. Cela repose sur deux éléments : des parties
 * « webextension » injectées dans le .docx au moment de l'ouverture (fait par
 * le serveur, voir websocket-server/lib/docx-autoopen.cjs) et un enregistrement
 * de l'add-in sur le poste, que Word consulte pour résoudre cette référence.
 *
 * Cette étape réalise cet enregistrement, une fois, de façon idempotente :
 *   - macOS   : lien du manifeste dans le dossier « wef » de Word ;
 *   - Windows : valeur sous la clé de registre Office correspondante.
 * Aucune donnée n'est envoyée à l'extérieur ; tout reste local au poste.
 */

import { createRequire } from 'node:module';
import { log } from '../lib/ui.mjs';
import { REPO_ROOT, IS_MAC, IS_WINDOWS } from '../lib/platform.mjs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ensureDevRegistration, isDevRegistered } = require(`${REPO_ROOT}/websocket-server/lib/word-launcher.cjs`);
const { ADDIN_ID } = require(`${REPO_ROOT}/websocket-server/lib/docx-autoopen.cjs`);

const MANIFEST_PATH = path.join(REPO_ROOT, 'taskpane', 'manifest.xml');

export const meta = {
  id: '12-word-taskpane',
  label: 'Ouverture automatique du volet Word',
  description: 'Permet à PieceMaker d\'ouvrir Word sur un document avec le volet déjà affiché',
};

export async function install(ctx) {
  if (!IS_MAC && !IS_WINDOWS) {
    return { status: 'skipped', note: 'Word n\'est disponible que sur macOS et Windows.' };
  }

  if (ctx.dryRun) {
    log.info('[simulation] enregistrement local de l\'add-in Word (macOS : dossier « wef » ; Windows : registre Office)');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const result = ensureDevRegistration(MANIFEST_PATH, ADDIN_ID);
  if (!result.registered) {
    return { status: 'failed', note: result.error || 'Enregistrement de l\'add-in Word impossible.' };
  }
  if (result.alreadyRegistered) {
    return { status: 'done', note: 'Add-in Word déjà enregistré sur ce poste.' };
  }
  return { status: 'done', note: 'Volet Word prêt à s\'ouvrir automatiquement.' };
}

export async function check(ctx) {
  if (!IS_MAC && !IS_WINDOWS) {
    return { status: 'skipped', note: 'Word n\'est disponible que sur macOS et Windows.' };
  }
  return isDevRegistered(MANIFEST_PATH, ADDIN_ID)
    ? { status: 'done', note: '' }
    : { status: 'partial', note: 'Add-in Word non enregistré — relancez cette étape.' };
}

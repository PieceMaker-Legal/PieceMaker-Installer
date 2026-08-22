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
 * Cette étape réalise cet enregistrement, une fois, de façon idempotente, en
 * DÉLÉGUANT à l'outillage officiel `office-addin-dev-settings` — exactement le
 * moteur qu'utilise `office-addin-debugging start`, c'est-à-dire
 * `npm start --prefix taskpane`. Les deux chemins écrivent donc rigoureusement
 * le même enregistrement :
 *   - macOS   : lien du manifeste dans le dossier « wef » de Word ;
 *   - Windows : valeur sous la clé de registre Office HKCU…\Wef\Developer.
 * Aucune donnée n'est envoyée à l'extérieur ; tout reste local au poste.
 *
 * Le manifeste est validé avant enregistrement : un manifeste invalide
 * s'enregistre sans erreur mais Word refuse ensuite silencieusement le volet.
 */

import { createRequire } from 'node:module';
import { log } from '../lib/ui.mjs';
import { REPO_ROOT, IS_MAC, IS_WINDOWS, npmBin, runCapture } from '../lib/platform.mjs';
import path from 'node:path';
import { registerWordMcpClients, wordMcpClientStatus } from '../lib/word-mcp-clients.mjs';

const require = createRequire(import.meta.url);
const { ensureDevRegistration, isDevRegistered } = require(`${REPO_ROOT}/websocket-server/lib/word-launcher.cjs`);
const { ADDIN_ID } = require(`${REPO_ROOT}/websocket-server/lib/docx-autoopen.cjs`);

const TASKPANE_DIR = path.join(REPO_ROOT, 'taskpane');
const MANIFEST_PATH = path.join(TASKPANE_DIR, 'manifest.xml');

export const meta = {
  id: '12-word-taskpane',
  label: 'Ouverture automatique du volet Word',
  description: 'Permet à PieceMaker d\'ouvrir Word sur un document avec le volet déjà affiché',
};

/**
 * Validation hors ligne du manifeste via office-addin-manifest. Best-effort :
 * l'outil peut appeler un service distant ; une indisponibilité ne doit pas
 * bloquer l'installation, seulement priver du diagnostic.
 */
function validateManifest() {
  const result = runCapture(npmBin('npx'), ['--no-install', 'office-addin-manifest', 'validate', 'manifest.xml'], {
    cwd: TASKPANE_DIR,
  });
  if (result.error) return { available: false };
  return { available: true, valid: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
}

export async function install(ctx) {
  if (!IS_MAC && !IS_WINDOWS) {
    return { status: 'skipped', note: 'Word n\'est disponible que sur macOS et Windows.' };
  }

  if (ctx.dryRun) {
    log.info('[simulation] enregistrement de l\'add-in Word via office-addin-dev-settings (macOS : dossier « wef » ; Windows : registre Office)');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const validation = validateManifest();
  if (validation.available && !validation.valid) {
    log.detail(validation.output.split('\n').slice(-5).join('\n'));
    return { status: 'failed', note: 'taskpane/manifest.xml est invalide — Word refuserait le volet.' };
  }

  const result = await ensureDevRegistration(MANIFEST_PATH, ADDIN_ID);
  if (!result.registered) {
    return { status: 'failed', note: result.error || 'Enregistrement de l\'add-in Word impossible.' };
  }
  const mcpClients = registerWordMcpClients(REPO_ROOT);
  const failedClients = mcpClients.filter((client) => client.available && !client.configured);
  if (failedClients.length) {
    return { status: 'partial', note: `Volet Word prêt, mais MCP non enregistré dans : ${failedClients.map((client) => client.name).join(', ')}.` };
  }
  const configuredClients = mcpClients.filter((client) => client.configured).map((client) => client.name);
  if (result.alreadyRegistered) {
    return { status: 'done', note: `Add-in Word déjà enregistré${configuredClients.length ? ` ; MCP prêt dans ${configuredClients.join(' et ')}` : ''}.` };
  }
  return {
    status: 'done',
    note: IS_WINDOWS
      ? `Volet Word prêt (registre Office HKCU…\\Wef\\Developer)${configuredClients.length ? ` ; MCP prêt dans ${configuredClients.join(' et ')}` : ''}.`
      : `Volet Word prêt (dossier de sideload de Word)${configuredClients.length ? ` ; MCP prêt dans ${configuredClients.join(' et ')}` : ''}.`,
  };
}

export async function check(ctx) {
  if (!IS_MAC && !IS_WINDOWS) {
    return { status: 'skipped', note: 'Word n\'est disponible que sur macOS et Windows.' };
  }
  const addinReady = await isDevRegistered(MANIFEST_PATH, ADDIN_ID);
  const missingMcp = ['codex', 'claude']
    .map((name) => wordMcpClientStatus(REPO_ROOT, name))
    .filter((client) => client.available && !client.configured);
  return addinReady && missingMcp.length === 0
    ? { status: 'done', note: '' }
    : addinReady
      ? { status: 'partial', note: `MCP Word non enregistré dans : ${missingMcp.map((client) => client.name).join(', ')}.` }
    : { status: 'partial', note: 'Add-in Word non enregistré — relancez cette étape (ou : npm start --prefix taskpane).' };
}

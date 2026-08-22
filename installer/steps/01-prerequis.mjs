/**
 * Step 01 — system prerequisites.
 *
 * Read-only probe of the toolchain the rest of the installer depends on:
 * Node >= 18 (this process already proves Node exists, only the version is
 * checked), npm, git, Python >= 3.10 (via findPython()), LibreOffice
 * (conversion des pièces Excel/Word en PDF avant tamponnage) et pandoc/typst
 * (facultatifs, voie génération — chronologie/historique). Disk space is
 * intentionally not checked — out of scope per the installer spec.
 */

import { createRequire } from 'node:module';
import { log } from '../lib/ui.mjs';
import { commandExists, compareVersions, npmBin, npmEnv, runCapture, IS_WINDOWS, REPO_ROOT } from '../lib/platform.mjs';

const require = createRequire(import.meta.url);
const { findSoffice } = require(`${REPO_ROOT}/websocket-server/lib/office-to-pdf.cjs`);
const { findPandoc, findTypst } = require(`${REPO_ROOT}/websocket-server/lib/doc-generate.cjs`);

export const meta = {
  id: '01-prerequis',
  label: 'Prérequis système',
  description: 'Vérifie Node.js, npm, git et Python avant toute installation',
};

const MIN_NODE = '18.0.0';

function probe(ctx) {
  const nodeVersion = process.version;
  const nodeOk = compareVersions(nodeVersion, MIN_NODE) >= 0;

  const npmProbe = runCapture(npmBin('npm'), ['--version'], { env: npmEnv() });
  const npmOk = npmProbe.code === 0 && !npmProbe.error;
  const npmVersion = npmOk ? npmProbe.stdout : null;

  const gitOk = commandExists('git');

  const pythonOk = Boolean(ctx.python);

  // node-pty (used by the PTY terminal bridge) needs a native build toolchain
  // on Windows. Best-effort probe only — this never fails the step.
  let winToolchainOk = true;
  if (IS_WINDOWS) {
    winToolchainOk = commandExists('cl', ['/?']) || commandExists('where', ['cl']);
  }

  // LibreOffice : indispensable pour tamponner une pièce Excel ou Word, qui
  // doit être convertie en PDF au préalable (websocket-server/lib/office-to-pdf.cjs).
  const soffice = findSoffice();

  // pandoc/typst : facultatifs, améliorent la qualité des exports de la
  // chronologie et de l'historique (voie génération) ; sans eux, repli
  // intégral et fonctionnel sur LibreOffice (installer/steps/10-pandoc.mjs).
  const pandoc = findPandoc();
  const typst = findTypst();

  return { nodeVersion, nodeOk, npmOk, npmVersion, gitOk, pythonOk, winToolchainOk, soffice, pandoc, typst };
}

function report(probeResult, ctx) {
  const { nodeVersion, nodeOk, npmOk, npmVersion, gitOk, pythonOk, winToolchainOk, soffice, pandoc, typst } = probeResult;

  if (nodeOk) log.ok(`Node.js ${nodeVersion} (>= ${MIN_NODE} requis)`);
  else log.error(`Node.js ${nodeVersion} — version >= ${MIN_NODE} requise`);

  if (npmOk) log.ok(`npm ${npmVersion}`);
  else log.error('npm introuvable — installez-le avec Node.js (nodejs.org)');

  if (gitOk) log.ok('git présent');
  else log.warn('git introuvable — optionnel pour l\'installateur, mais recommandé pour les mises à jour');

  if (pythonOk) log.ok(`Python ${ctx.python.version} (${ctx.python.command})`);
  else log.error('Python >= 3.10 introuvable — requis pour l\'anonymisation GLiNER (étape 03)');

  if (soffice) log.ok(`LibreOffice détecté (${soffice})`);
  else log.warn('LibreOffice introuvable — l\'étape "10-libreoffice" l\'installera (requis pour tamponner les pièces Excel et Word)');

  if (pandoc) log.ok(`pandoc détecté (${pandoc})`);
  else log.warn('pandoc introuvable — facultatif, améliore la qualité des exports de la chronologie et de l\'historique (piecemaker --step 10-pandoc)');

  if (typst) log.ok(`typst détecté (${typst})`);
  else log.warn('typst introuvable — facultatif, sert de moteur PDF à pandoc pour ces exports (piecemaker --step 10-pandoc)');

  if (IS_WINDOWS) {
    if (winToolchainOk) log.ok('Outils de compilation C++ détectés (nécessaires à node-pty)');
    else {
      log.warn('Outils de compilation C++ non détectés (node-pty ne pourra pas se compiler)');
      log.detail('Installez "Visual Studio Build Tools" (charge de travail "Développement Desktop en C++")');
      log.detail('Voir : https://github.com/nodejs/node-gyp#on-windows');
    }
  }
}

function computeStatus({ nodeOk, npmOk, pythonOk, gitOk }) {
  const missing = [];
  if (!nodeOk) missing.push(`Node.js >= ${MIN_NODE}`);
  if (!npmOk) missing.push('npm');
  if (!pythonOk) missing.push('Python >= 3.10');

  if (missing.length) {
    return { status: 'failed', note: `Manquant : ${missing.join(', ')}. Installez-les puis relancez cette étape.` };
  }
  if (!gitOk) {
    return { status: 'partial', note: 'git est absent — installez-le pour faciliter les futures mises à jour.' };
  }
  return { status: 'done', note: '' };
}

export async function install(ctx) {
  log.step('Vérification des prérequis...');
  const result = probe(ctx);
  report(result, ctx);
  return computeStatus(result);
}

export async function check(ctx) {
  const result = probe(ctx);
  return computeStatus(result);
}

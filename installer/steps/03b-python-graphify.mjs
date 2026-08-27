/**
 * Step 03b — Environnement virtuel Graphify (graphe juridique).
 *
 * Graphify est installé dans un venv séparé du venv GLiNER (config.venvPath) :
 * les deux outils n'ont pas les mêmes dépendances et ne doivent pas se marcher
 * dessus. Le fork PieceMaker-Legal/graphify est installé à un tag immuable —
 * jamais une branche mouvante — via pip + git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { run, runCapture, venvPaths, ensureDir } from '../lib/platform.mjs';
import { updateConfig } from '../lib/state.mjs';

export const meta = {
  id: '03b-python-graphify',
  label: 'Graphify (graphe juridique)',
  description: 'Crée un venv dédié et installe le fork Graphify PieceMaker-Legal',
};

// Tag immuable du fork à publier — voir docs/PLAN-Legal-Graphify.md §9.
// Placeholder tant que le tag n'a pas été publié par le dépôt Graphify.
const GRAPHIFY_FORK_TAG = 'REPLACE_WITH_PUBLISHED_TAG';
const GRAPHIFY_EXPECTED_VERSION = '0.9.48';
const GRAPHIFY_REQUIREMENT = `graphify-doc @ git+https://github.com/PieceMaker-Legal/graphify@${GRAPHIFY_FORK_TAG}`;

export async function install(ctx) {
  if (!ctx.python) {
    return { status: 'failed', note: 'Python >= 3.10 introuvable — exécutez d\'abord l\'étape des prérequis.' };
  }

  const venvDir = ctx.config.graphifyVenvPath;
  const vp = venvPaths(venvDir);

  if (ctx.dryRun) {
    log.info(`[simulation] Création du venv dans ${venvDir}`);
    log.info(`[simulation] pip install "${GRAPHIFY_REQUIREMENT}"`);
    return { status: 'skipped', note: 'Mode simulation — aucune installation effectuée.' };
  }

  const proceed = await confirm(
    `Installer Graphify (fork PieceMaker-Legal, tag ${GRAPHIFY_FORK_TAG}) depuis GitHub dans un venv dédié ?`,
    true
  );
  if (!proceed) {
    return { status: 'partial', note: 'Graphify non installé — relancez l\'étape "03b-python-graphify" quand vous serez prêt.' };
  }

  // 1. Create the venv if it does not exist yet.
  if (!vp.exists) {
    ensureDir(path.dirname(venvDir));
    const spin = spinner(`Création de l'environnement virtuel Graphify (${ctx.python.command})...`);
    const code = await run(ctx.python.command, ['-m', 'venv', venvDir]);
    if (code !== 0) {
      spin.fail('Échec de la création du venv Graphify');
      return { status: 'failed', note: `python -m venv a échoué (code ${code}). Vérifiez votre installation Python.` };
    }
    spin.succeed(`Environnement virtuel Graphify créé : ${venvDir}`);
  } else {
    log.info(`Environnement virtuel Graphify déjà présent : ${venvDir}`);
  }

  // 2. Upgrade pip.
  {
    const spin = spinner('Mise à jour de pip...');
    const code = await run(vp.python, ['-m', 'pip', 'install', '-U', 'pip']);
    if (code !== 0) {
      spin.fail('Échec de la mise à jour de pip');
      return { status: 'failed', note: `pip install -U pip a échoué (code ${code}).` };
    }
    spin.succeed('pip à jour');
  }

  // 3. Install the pinned fork tag.
  {
    const spin = spinner(`Installation de Graphify (tag ${GRAPHIFY_FORK_TAG})...`);
    const code = await run(vp.python, ['-m', 'pip', 'install', '--upgrade', GRAPHIFY_REQUIREMENT]);
    if (code !== 0) {
      spin.fail('Échec de l\'installation de Graphify');
      return {
        status: 'failed',
        note: `pip install a échoué (code ${code}). Vérifiez que le tag ${GRAPHIFY_FORK_TAG} a bien été publié sur PieceMaker-Legal/graphify.`,
      };
    }
    spin.succeed('Graphify installé');
  }

  // 4. Verify the binary landed in the venv.
  const graphifyBin = path.join(vp.binDir, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  if (!fs.existsSync(graphifyBin)) {
    return { status: 'failed', note: `Le binaire graphify est introuvable dans ${vp.binDir} après installation.` };
  }

  updateConfig({ graphifyVenvPath: venvDir, graphifyPath: graphifyBin });

  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const venvDir = ctx.config.graphifyVenvPath;
  const vp = venvPaths(venvDir);
  if (!vp.exists) {
    return { status: 'failed', note: `Environnement virtuel Graphify introuvable : ${venvDir}` };
  }

  const graphifyBin = path.join(vp.binDir, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  if (!fs.existsSync(graphifyBin)) {
    return { status: 'failed', note: `Binaire graphify introuvable : ${graphifyBin}` };
  }

  const versionResult = runCapture(graphifyBin, ['--version']);
  if (versionResult.code !== 0) {
    return { status: 'failed', note: 'graphify --version a échoué — venv corrompu, relancez cette étape.' };
  }
  const version = `${versionResult.stdout} ${versionResult.stderr}`.trim();
  const versionMatch = version.match(/(\d+\.\d+\.\d+)/);
  if (!versionMatch || versionMatch[1] !== GRAPHIFY_EXPECTED_VERSION) {
    return {
      status: 'partial',
      note: `Version inattendue (${version || 'inconnue'}) — attendu ${GRAPHIFY_EXPECTED_VERSION}. Relancez l'étape pour réinstaller le tag ${GRAPHIFY_FORK_TAG}.`,
    };
  }

  const helpResult = runCapture(graphifyBin, ['extract', '--help']);
  if (helpResult.code !== 0 || !helpResult.stdout.includes('--entity-map')) {
    return {
      status: 'partial',
      note: 'La prise en charge d\'--entity-map (entity_metadata) est absente de ce build Graphify.',
    };
  }

  return { status: 'done', note: `Graphify ${GRAPHIFY_EXPECTED_VERSION}, --entity-map disponible.` };
}

/**
 * Step 03 — Python virtualenv, dependencies and GLiNER models.
 *
 * This is the anonymisation core: a venv is created at config.venvPath,
 * websocket-server/scripts/requirements.txt is installed into it, then
 * warmup.py downloads the GLiNER2 (~400MB) and spaCy fr/en models. warmup.py
 * emits JSON status lines on stdout (see log_json in warmup.py) interleaved
 * with plain emoji lines (log_plain) — both are surfaced through the spinner.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner, columns } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { run, runCapture, venvPaths, ensureDir, REPO_ROOT } from '../lib/platform.mjs';
import { writeEnv, updateConfig } from '../lib/state.mjs';

export const meta = {
  id: '03-python-gliner',
  label: 'Python, GLiNER & anonymisation',
  description: 'Crée le venv Python, installe les dépendances et télécharge les modèles GLiNER',
};

const SCRIPTS_DIR = path.join(REPO_ROOT, 'websocket-server', 'scripts');
const REQUIREMENTS = path.join(SCRIPTS_DIR, 'requirements.txt');
const WARMUP = path.join(SCRIPTS_DIR, 'warmup.py');

function truncate(text) {
  const width = Math.max(20, columns() - 6);
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

/** Feed a warmup.py output line to the spinner, preferring the JSON `message` field. */
function onWarmupLine(spin) {
  return (line) => {
    try {
      const parsed = JSON.parse(line);
      spin.update(truncate(parsed.message || line));
    } catch {
      spin.update(truncate(line));
    }
  };
}

export async function install(ctx) {
  if (!fs.existsSync(REQUIREMENTS)) {
    return { status: 'failed', note: `requirements.txt introuvable : ${REQUIREMENTS}` };
  }
  if (!fs.existsSync(WARMUP)) {
    return { status: 'failed', note: `warmup.py introuvable : ${WARMUP}` };
  }
  if (!ctx.python) {
    return { status: 'failed', note: 'Python >= 3.10 introuvable — exécutez d\'abord l\'étape des prérequis.' };
  }

  const venvDir = ctx.config.venvPath;
  const vp = venvPaths(venvDir);

  if (ctx.dryRun) {
    log.info(`[simulation] Création du venv dans ${venvDir}`);
    log.info(`[simulation] pip install -r ${REQUIREMENTS}`);
    log.info('[simulation] python warmup.py (téléchargement des modèles)');
    return { status: 'skipped', note: 'Mode simulation — aucune installation effectuée.' };
  }

  // 1. Create the venv if it does not exist yet.
  if (!vp.exists) {
    ensureDir(path.dirname(venvDir));
    const spin = spinner(`Création de l'environnement virtuel (${ctx.python.command})...`);
    const code = await run(ctx.python.command, ['-m', 'venv', venvDir]);
    if (code !== 0) {
      spin.fail('Échec de la création du venv');
      return { status: 'failed', note: `python -m venv a échoué (code ${code}). Vérifiez votre installation Python.` };
    }
    spin.succeed(`Environnement virtuel créé : ${venvDir}`);
  } else {
    log.info(`Environnement virtuel déjà présent : ${venvDir}`);
  }

  // 2. Upgrade pip.
  {
    const spin = spinner('Mise à jour de pip...');
    const code = await run(vp.python, ['-m', 'pip', 'install', '-U', 'pip'], {
      onLine: (line) => spin.update(truncate(line)),
    });
    if (code !== 0) {
      spin.fail('Échec de la mise à jour de pip');
      return { status: 'failed', note: `pip install -U pip a échoué (code ${code}).` };
    }
    spin.succeed('pip à jour');
  }

  // 3. Install requirements.txt (markitdown, pypdf, gliner2, presidio-analyzer, spacy...).
  {
    const spin = spinner('Installation des dépendances Python (requirements.txt)...');
    const code = await run(vp.python, ['-m', 'pip', 'install', '-r', REQUIREMENTS], {
      onLine: (line) => spin.update(truncate(line)),
    });
    if (code !== 0) {
      spin.fail('Échec de l\'installation des dépendances Python');
      return {
        status: 'failed',
        note: `pip install -r requirements.txt a échoué (code ${code}). Relancez cette étape après avoir corrigé l'erreur ci-dessus.`,
      };
    }
    spin.succeed('Dépendances Python installées');
  }

  // Persist the interpreter path now — useful even if the model download is declined.
  updateConfig({ pythonPath: vp.python, venvPath: venvDir });
  writeEnv({ PYTHON_PATH: vp.python });

  // 4. Download models (~500MB) — ask first.
  const proceed = await confirm(
    'Télécharger les modèles GLiNER2 et spaCy (fr/en), environ 500 Mo au total ?',
    true
  );
  if (!proceed) {
    return {
      status: 'partial',
      note: 'Modèles non téléchargés — relancez l\'étape "03-python-gliner" quand vous serez prêt.',
    };
  }

  const spin = spinner('Téléchargement des modèles GLiNER2 et spaCy...');
  const code = await run(vp.python, [WARMUP], { cwd: SCRIPTS_DIR, onLine: onWarmupLine(spin) });

  if (code !== 0) {
    spin.fail('Le téléchargement des modèles ne s\'est pas terminé complètement');
    return {
      status: 'partial',
      note: 'Certains modèles n\'ont pas pu être téléchargés (réseau ?). Relancez cette étape pour réessayer.',
    };
  }

  spin.succeed('Modèles GLiNER2 et spaCy prêts');
  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const vp = venvPaths(ctx.config.venvPath);
  if (!vp.exists) {
    return { status: 'failed', note: `Environnement virtuel introuvable : ${ctx.config.venvPath}` };
  }
  if (!fs.existsSync(WARMUP)) {
    return { status: 'failed', note: `warmup.py introuvable : ${WARMUP}` };
  }

  const result = runCapture(vp.python, [WARMUP, '--status'], { cwd: SCRIPTS_DIR });
  let statusJson;
  try {
    statusJson = JSON.parse(result.stdout);
  } catch {
    return { status: 'failed', note: 'Impossible de lire l\'état des modèles (venv incomplet ?).' };
  }

  const models = statusJson.models || {};
  const missing = Object.entries(models)
    .filter(([, info]) => !info.cached)
    .map(([key]) => key);

  if (statusJson.ready && missing.length === 0) return { status: 'done', note: '' };
  if (statusJson.ready) return { status: 'partial', note: `Modèles optionnels manquants : ${missing.join(', ')}` };
  return { status: 'failed', note: `Modèle critique manquant : gliner2. Relancez cette étape.` };
}

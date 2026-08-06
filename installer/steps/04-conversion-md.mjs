/**
 * Step 04 — document-to-Markdown conversion pipeline.
 *
 * smart_converter.py (websocket-server/scripts/) auto-routes between
 * markitdown (fast text extraction) and MinerU (OCR, for scanned PDFs and
 * images). markitdown/pypdf come from requirements.txt (step 03); MinerU is
 * a separate, heavy, optional install offered here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { run, runCapture, venvPaths, REPO_ROOT } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

export const meta = {
  id: '04-conversion-md',
  label: 'Conversion de documents en Markdown',
  description: 'Vérifie markitdown/pypdf et propose MinerU pour les PDF scannés',
};

const SCRIPTS_DIR = path.join(REPO_ROOT, 'websocket-server', 'scripts');
const SMART_CONVERTER = path.join(SCRIPTS_DIR, 'smart_converter.py');

function checkImports(pythonBin) {
  return runCapture(pythonBin, ['-c', 'import markitdown, pypdf']);
}

async function smokeTest(pythonBin) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-smoke-'));
  const outDir = path.join(tmpDir, 'out');
  const inputFile = path.join(tmpDir, 'smoke.txt');
  fs.writeFileSync(inputFile, 'Bonjour installateur PieceMaker.\n', 'utf8');

  try {
    const result = runCapture(pythonBin, [
      SMART_CONVERTER,
      inputFile,
      '-o',
      outDir,
      '--engine',
      'markitdown',
    ]);
    const outputFile = path.join(outDir, 'smoke.md');
    const ok = result.code === 0 && fs.existsSync(outputFile);
    return { ok, code: result.code, stderr: result.stderr };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function install(ctx) {
  if (!fs.existsSync(SMART_CONVERTER)) {
    return { status: 'failed', note: `smart_converter.py introuvable : ${SMART_CONVERTER}` };
  }

  const vp = venvPaths(ctx.config.venvPath);

  // Dry run reports intent only: step 03 has not run yet in simulation mode,
  // so a missing venv here is expected rather than a failure.
  if (ctx.dryRun) {
    log.info(`[simulation] Vérification des imports markitdown/pypdf dans ${vp.python}`);
    log.info('[simulation] Écriture de SMART_CONVERTER_PATH dans .env');
    log.info('[simulation] Test de conversion sur un fichier temporaire');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!vp.exists) {
    return {
      status: 'failed',
      note: 'Environnement virtuel introuvable — exécutez d\'abord l\'étape "03-python-gliner".',
    };
  }

  // 1. Verify markitdown + pypdf are importable in the venv.
  const importCheck = checkImports(vp.python);
  if (importCheck.code !== 0) {
    return {
      status: 'failed',
      note: 'markitdown ou pypdf non installés dans le venv. Relancez l\'étape "03-python-gliner" (pip install -r requirements.txt).',
    };
  }
  log.ok('markitdown et pypdf disponibles dans le venv');

  writeEnv({ SMART_CONVERTER_PATH: SMART_CONVERTER });
  log.ok(`SMART_CONVERTER_PATH enregistré : ${SMART_CONVERTER}`);

  // 2. Optional MinerU install — heavy (PyTorch-class deps), only needed for
  // scanned PDFs / images that have no extractable text layer.
  const wantMineru = await confirm(
    'Installer MinerU (OCR pour PDF scannés et images) ? Optionnel, volumineux (plusieurs centaines de Mo à quelques Go de dépendances).',
    false
  );
  let mineruNote = '';
  if (wantMineru) {
    const spin = spinner('Installation de MinerU...');
    const code = await run(vp.python, ['-m', 'pip', 'install', '-U', 'mineru'], {
      onLine: (line) => spin.update(line.slice(0, 100)),
    });
    if (code === 0) spin.succeed('MinerU installé');
    else {
      spin.fail('Échec de l\'installation de MinerU');
      mineruNote = ' MinerU n\'a pas pu être installé automatiquement — consultez sa documentation pour l\'installer manuellement.';
    }
  } else {
    log.info('MinerU non installé — les PDF scannés et images ne pourront pas être convertis (OCR).');
  }

  // 3. Smoke test: convert a throwaway .txt file end-to-end.
  const spin = spinner('Test de conversion (fichier temporaire)...');
  const smoke = await smokeTest(vp.python);
  if (!smoke.ok) {
    spin.fail('Le test de conversion a échoué');
    return {
      status: 'failed',
      note: `smart_converter.py a échoué (code ${smoke.code}) : ${smoke.stderr.slice(0, 200)}`,
    };
  }
  spin.succeed('Conversion de test réussie');

  return {
    status: wantMineru && mineruNote ? 'partial' : 'done',
    note: mineruNote.trim(),
  };
}

export async function check(ctx) {
  if (!fs.existsSync(SMART_CONVERTER)) {
    return { status: 'failed', note: `smart_converter.py introuvable : ${SMART_CONVERTER}` };
  }
  const vp = venvPaths(ctx.config.venvPath);
  if (!vp.exists) {
    return { status: 'failed', note: 'Environnement virtuel introuvable.' };
  }
  const importCheck = checkImports(vp.python);
  if (importCheck.code !== 0) {
    return { status: 'failed', note: 'markitdown ou pypdf non installés.' };
  }
  // MinerU is optional (OCR only) — its absence does not degrade the status.
  const mineruAvailable = runCapture('mineru', ['--version']).code === 0;
  return {
    status: 'done',
    note: mineruAvailable ? '' : 'MinerU non installé (optionnel — nécessaire seulement pour l\'OCR des PDF scannés).',
  };
}

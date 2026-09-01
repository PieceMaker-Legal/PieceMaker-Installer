/**
 * Reprise automatique des étapes d'installation restées incomplètes.
 *
 * `piecemaker update` remet les fichiers du dépôt en place, relance les
 * services, puis délègue ici : les étapes dont le diagnostic n'est pas
 * concluant sont rejouées dans un processus détaché, sans interaction et sans
 * retarder le retour de la commande. La sortie part dans
 * `~/.piecemaker/install-resume.log`, à côté de `server.log` et `litellm.log`.
 *
 * Deux garde-fous structurent la sélection :
 *
 * 1. Une étape marquée « skipped » dans `state.json` n'est jamais ressuscitée.
 *    L'état ne distingue pas un refus explicite de l'utilisateur (« Application
 *    Bureau refusée », clés PISTE non fournies) d'une étape sans objet sur la
 *    machine : dans le doute on respecte la trace laissée par la dernière
 *    exécution. Sans cette règle, l'étape 15 — dont `check()` répond « partial :
 *    Application PieceMaker absente du Bureau » — réinstallerait à chaque mise à
 *    jour un raccourci que l'utilisateur vient de refuser.
 * 2. `03-python-gliner` est exclue d'office : son `install()` exécute
 *    `warmup.py`, qui charge et télécharge les modèles GLiNER. Un seul scan
 *    GLiNER doit tourner à la fois sur la machine ; une reprise en tâche de
 *    fond ne peut pas garantir cette exclusion vis-à-vis d'un scan lancé depuis
 *    l'administration. Cette étape reste à la main de l'utilisateur
 *    (`piecemaker --step 03-python-gliner`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { HOME_DIR, ensureDir } from './platform.mjs';

/** Étapes que la reprise automatique ne joue jamais (voir l'en-tête). */
export const EXCLUDED_STEP_IDS = Object.freeze(['03-python-gliner']);

/** Statuts de `check()` considérés comme concluants : rien à reprendre. */
export const SETTLED_STATUSES = Object.freeze(['done', 'skipped']);

export const RESUME_LOG_FILE = path.join(HOME_DIR, 'install-resume.log');
export const RESUME_PID_FILE = path.join(HOME_DIR, 'install-resume.pid');

function processRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** PID d'une reprise encore vivante, ou `null`. Un fichier périmé est nettoyé. */
export function runningResumePid(pidFile = RESUME_PID_FILE) {
  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch {
    return null;
  }
  if (processRunning(pid)) return pid;
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Déjà disparu : rien à nettoyer.
  }
  return null;
}

/**
 * Étapes à reprendre, dans l'ordre de découverte (donc l'ordre du nom).
 *
 * `steps` vient de `loadSteps()`, `state` de `loadState()` et `ctx` de
 * `buildContext()`. `check()` fait autorité — il ne modifie rien par contrat —
 * mais l'état a le dernier mot sur les étapes délibérément ignorées.
 */
export async function selectStepsToResume({ steps = [], state = {}, ctx = {}, excluded = EXCLUDED_STEP_IDS } = {}) {
  const skip = new Set(excluded);
  const recorded = state.steps || {};
  const pending = [];

  for (const step of steps) {
    if (step.broken || !step.id) continue;
    if (skip.has(step.id)) continue;
    // Refus explicite ou étape sans objet : on ne tranche pas à la place de
    // l'utilisateur, on laisse la trace de la dernière exécution décider.
    if (recorded[step.id]?.status === 'skipped') continue;

    let status;
    let note = '';
    if (typeof step.check === 'function') {
      try {
        const result = (await step.check(ctx)) || {};
        status = result.status;
        note = result.note || '';
      } catch (error) {
        status = 'failed';
        note = error.message;
      }
    } else {
      // Sans diagnostic, seul l'état renseigne : une étape jamais jouée est à
      // reprendre, une étape terminée ne l'est pas.
      status = recorded[step.id]?.status;
      note = recorded[step.id]?.note || '';
    }

    if (SETTLED_STATUSES.includes(status)) continue;
    pending.push({ id: step.id, label: step.label || step.id, status: status || 'inconnu', note });
  }

  return pending;
}

/** Commande détachée qui rejouera les étapes. Isolée pour être testable. */
export function buildResumeCommand({ execPath = process.execPath, cli, ids = [] } = {}) {
  if (!cli) throw new Error('Chemin de la CLI manquant pour la reprise des étapes.');
  return {
    command: execPath,
    args: [cli, '--resume-steps', ids.join(','), '--yes'],
  };
}

/**
 * Lance la reprise en tâche de fond. Ne bloque jamais : le processus enfant est
 * détaché, sa sortie va dans le journal et l'appelant rend la main aussitôt.
 */
export function scheduleStepResume({
  execPath = process.execPath,
  cli,
  ids = [],
  cwd,
  logFile = RESUME_LOG_FILE,
  pidFile = RESUME_PID_FILE,
  spawnFn = spawn,
  env = process.env,
} = {}) {
  if (!ids.length) return { started: false, reason: 'rien-a-reprendre', logFile };

  const already = runningResumePid(pidFile);
  if (already) return { started: false, reason: 'deja-en-cours', pid: already, logFile };

  ensureDir(path.dirname(logFile));
  fs.appendFileSync(
    logFile,
    `\n[${new Date().toISOString()}] Reprise des étapes : ${ids.join(', ')}\n`,
    'utf8'
  );

  const { command, args } = buildResumeCommand({ execPath, cli, ids });
  const handle = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawnFn(command, args, {
      cwd,
      detached: true,
      stdio: ['ignore', handle, handle],
      windowsHide: true,
      // La reprise n'a ni terminal ni utilisateur derrière : les prompts
      // doivent prendre leur valeur par défaut au lieu d'attendre.
      env: { ...env, PIECEMAKER_YES: '1', NO_COLOR: '1' },
    });
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // Le descripteur a déjà été repris par l'enfant.
    }
  }

  if (typeof child?.unref === 'function') child.unref();
  ensureDir(path.dirname(pidFile));
  if (child?.pid) fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

  return { started: true, pid: child?.pid || null, ids: [...ids], logFile, command, args };
}

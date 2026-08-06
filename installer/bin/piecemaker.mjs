#!/usr/bin/env node
/**
 * PieceMaker — installateur terminal.
 *
 * Steps are discovered from installer/steps/*.mjs and run in filename order.
 * Each step module exports { meta, install(ctx), check(ctx) } and returns
 * { status, note } where status is done | partial | failed | skipped.
 *
 * Usage:
 *   piecemaker                 menu interactif
 *   piecemaker --all           installe tout sans menu
 *   piecemaker --check         diagnostic seul, n'installe rien
 *   piecemaker --step <id>     rejoue une étape
 *   piecemaker --dry-run       montre les actions sans les exécuter
 *   piecemaker --yes           accepte les valeurs par défaut (non interactif)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { banner, title, log, write, blank, rule, summary, badge, c } from '../lib/ui.mjs';
import { select, confirm, multiSelect, pause, nonInteractive } from '../lib/prompt.mjs';
import { findPython, REPO_ROOT } from '../lib/platform.mjs';
import { loadConfig, readEnv, markStep, loadState, CONFIG_FILE } from '../lib/state.mjs';

const STEPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'steps');

const STATUS_BADGE = {
  done: badge.done,
  partial: badge.partial,
  failed: badge.failed,
  skipped: badge.skipped,
};

function parseArgs(argv) {
  const flags = { all: false, check: false, dryRun: false, step: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') flags.all = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--step') flags.step = argv[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
  }
  return flags;
}

/**
 * Load every step module. A step that fails to import is surfaced as a broken
 * entry rather than taking the whole installer down.
 */
async function loadSteps() {
  if (!fs.existsSync(STEPS_DIR)) return [];
  const files = fs
    .readdirSync(STEPS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort();

  const steps = [];
  for (const file of files) {
    const full = path.join(STEPS_DIR, file);
    try {
      const mod = await import(pathToFileURL(full).href);
      if (!mod.meta?.id || typeof mod.install !== 'function') {
        steps.push({ broken: `${file} : export meta/install manquant`, file });
        continue;
      }
      steps.push({ ...mod.meta, file, install: mod.install, check: mod.check });
    } catch (error) {
      steps.push({ broken: `${file} : ${error.message}`, file });
    }
  }
  return steps;
}

function buildContext(flags) {
  return {
    config: loadConfig(),
    env: readEnv(),
    python: findPython(),
    dryRun: flags.dryRun,
  };
}

async function runStep(step, ctx, index, total) {
  title(`[${index}/${total}] ${step.label}`);
  if (step.description) write(`  ${c.gray(step.description)}`);
  blank();

  try {
    const result = (await step.install(ctx)) || {};
    const status = result.status || 'done';
    markStep(step.id, status, result.note || '');
    blank();
    if (status === 'done') log.ok(`${step.label} — terminé`);
    else if (status === 'partial') log.warn(`${step.label} — partiel${result.note ? ` : ${result.note}` : ''}`);
    else if (status === 'skipped') log.info(`${step.label} — ignoré`);
    else log.error(`${step.label} — échec${result.note ? ` : ${result.note}` : ''}`);
    return { ...result, status };
  } catch (error) {
    markStep(step.id, 'failed', error.message);
    blank();
    log.error(`${step.label} — échec : ${error.message}`);
    if (process.env.PIECEMAKER_DEBUG) log.detail(error.stack);
    return { status: 'failed', note: error.message };
  }
}

async function runAll(steps, ctx, selectedIds = null) {
  const runnable = steps.filter((s) => !s.broken && (!selectedIds || selectedIds.includes(s.id)));
  const results = [];

  for (const [i, step] of runnable.entries()) {
    const result = await runStep(step, ctx, i + 1, runnable.length);
    results.push([step, result]);

    if (result.status === 'failed' && step.required !== false) {
      blank();
      const keepGoing = await confirm('Cette étape a échoué. Continuer malgré tout ?', true);
      if (!keepGoing) break;
    }
    // Later steps read what earlier ones wrote (.env, config).
    ctx.config = loadConfig();
    ctx.env = readEnv();
  }

  return results;
}

function printSummary(results) {
  title('Résumé');
  if (!results.length) {
    log.info('Aucune étape exécutée.');
    return;
  }
  summary(
    results.map(([step, result]) => [
      step.label,
      STATUS_BADGE[result.status] || result.status,
      result.note || '',
    ])
  );
  blank();

  const failed = results.filter(([, r]) => r.status === 'failed');
  const partial = results.filter(([, r]) => r.status === 'partial');

  if (!failed.length && !partial.length) {
    log.ok('Installation complète.');
    blank();
    write(`  ${c.bold('Pour démarrer :')}`);
    write(`    node websocket-server/server.cjs`);
    write(`  ${c.gray('puis, dans Word, chargez le complément (voir README).')}`);
  } else {
    if (partial.length) log.warn(`${partial.length} étape(s) partielle(s) — relancez avec --step <id> après correction.`);
    if (failed.length) log.error(`${failed.length} étape(s) en échec.`);
    blank();
    write(`  ${c.gray(`État détaillé : ${CONFIG_FILE.replace('config.json', 'state.json')}`)}`);
  }
  blank();
}

async function runCheck(steps, ctx) {
  title('Diagnostic');
  const rows = [];
  for (const step of steps) {
    if (step.broken) {
      rows.push([step.file, badge.failed, step.broken]);
      continue;
    }
    if (typeof step.check !== 'function') {
      const recorded = loadState().steps[step.id];
      rows.push([step.label, recorded ? STATUS_BADGE[recorded.status] : badge.todo, recorded?.note || '']);
      continue;
    }
    try {
      const result = (await step.check(ctx)) || {};
      rows.push([step.label, STATUS_BADGE[result.status] || badge.todo, result.note || '']);
    } catch (error) {
      rows.push([step.label, badge.failed, error.message]);
    }
  }
  summary(rows);
  blank();
}

function printHelp() {
  write(`  ${c.bold('piecemaker')} — installateur PieceMaker`);
  blank();
  write('  --all           installe tout sans menu');
  write('  --check         diagnostic seul, n\'installe rien');
  write('  --step <id>     rejoue une seule étape');
  write('  --dry-run       montre les actions sans les exécuter');
  write('  --yes, -y       accepte les valeurs par défaut (non interactif)');
  write('  --help, -h      cette aide');
  blank();
}

async function menu(steps, ctx) {
  for (;;) {
    const choice = await select('Que voulez-vous faire ?', [
      { value: 'all', label: 'Tout installer', hint: 'recommandé au premier lancement' },
      { value: 'pick', label: 'Choisir les composants' },
      { value: 'check', label: 'Diagnostic', hint: 'vérifie sans rien modifier' },
      { value: 'quit', label: 'Quitter' },
    ]);

    if (choice === 'quit') return;

    if (choice === 'check') {
      await runCheck(steps, ctx);
      await pause();
      continue;
    }

    let selectedIds = null;
    if (choice === 'pick') {
      const available = steps.filter((s) => !s.broken);
      selectedIds = await multiSelect(
        'Composants à installer',
        available.map((s) => ({ value: s.id, label: s.label, hint: s.description })),
        { def: available.map((s) => s.id) }
      );
      if (!selectedIds.length) {
        log.info('Aucun composant sélectionné.');
        continue;
      }
    }

    const results = await runAll(steps, ctx, selectedIds);
    printSummary(results);
    return;
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.yes) process.env.PIECEMAKER_YES = '1';

  if (flags.help) {
    banner();
    printHelp();
    return 0;
  }

  banner();

  const steps = await loadSteps();
  const broken = steps.filter((s) => s.broken);
  if (broken.length) {
    for (const b of broken) log.error(b.broken);
    blank();
  }
  if (!steps.some((s) => !s.broken)) {
    log.error(`Aucune étape exécutable trouvée dans ${STEPS_DIR}`);
    return 1;
  }

  const ctx = buildContext(flags);
  if (flags.dryRun) {
    log.warn('Mode simulation : aucune modification ne sera écrite.');
    blank();
  }

  if (flags.check) {
    await runCheck(steps, ctx);
    return 0;
  }

  if (flags.step) {
    const step = steps.find((s) => s.id === flags.step && !s.broken);
    if (!step) {
      log.error(`Étape inconnue : ${flags.step}`);
      log.detail(`Disponibles : ${steps.filter((s) => !s.broken).map((s) => s.id).join(', ')}`);
      return 1;
    }
    const result = await runStep(step, ctx, 1, 1);
    printSummary([[step, result]]);
    return result.status === 'failed' ? 1 : 0;
  }

  if (flags.all || nonInteractive) {
    const results = await runAll(steps, ctx);
    printSummary(results);
    return results.some(([, r]) => r.status === 'failed') ? 1 : 0;
  }

  await menu(steps, ctx);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    log.error(error.message);
    if (process.env.PIECEMAKER_DEBUG) log.detail(error.stack);
    process.exit(1);
  });

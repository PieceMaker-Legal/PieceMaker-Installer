#!/usr/bin/env node
/**
 * PieceMaker — commande principale et installateur terminal.
 *
 * Steps are discovered from installer/steps/*.mjs and run in filename order.
 * Each step module exports { meta, install(ctx), check(ctx) } and returns
 * { status, note } where status is done | partial | failed | skipped.
 *
 * Usage:
 *   piecemaker                 menu interactif
 *   piecemaker open            démarre le serveur et ouvre l'interface web
 *   piecemaker start|stop      gère le serveur local
 *   piecemaker status|logs     affiche l'état ou les journaux
 *   piecemaker install         ouvre le menu des composants
 *   piecemaker doctor          diagnostic seul
 *   piecemaker update          met à jour le dépôt et les dépendances
 *   piecemaker --all           installe tout sans menu
 *   piecemaker --check         diagnostic seul, n'installe rien
 *   piecemaker --step <id>     rejoue une étape
 *   piecemaker --dry-run       montre les actions sans les exécuter
 *   piecemaker --yes           accepte les valeurs par défaut (non interactif)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { banner, title, log, write, blank, summary, badge, c } from '../lib/ui.mjs';
import { select, confirm, multiSelect, pause, nonInteractive } from '../lib/prompt.mjs';
import { findPython } from '../lib/platform.mjs';
import { loadConfig, readEnv, markStep, loadState, CONFIG_FILE } from '../lib/state.mjs';
import {
  getServerStatus,
  openAdmin,
  readLogs,
  startServer,
  stopServer,
  updateRepository,
} from '../lib/service.mjs';

const STEPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'steps');
const COMMANDS = new Set(['open', 'start', 'stop', 'status', 'logs', 'install', 'doctor', 'check', 'update']);

const STATUS_BADGE = {
  done: badge.done,
  partial: badge.partial,
  failed: badge.failed,
  skipped: badge.skipped,
};

function parseArgs(argv) {
  const flags = { command: null, all: false, check: false, dryRun: false, step: null, yes: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !flags.command && COMMANDS.has(arg)) flags.command = arg;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--check') flags.check = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--step') flags.step = argv[++i];
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else flags.unknown.push(arg);
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
    write(`    piecemaker open`);
    write(`  ${c.gray('Le serveur local démarrera et l’interface web s’ouvrira automatiquement.')}`);
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
  write(`  ${c.bold('piecemaker')} — PieceMaker local`);
  blank();
  write('  open            démarre le serveur et ouvre l’interface web');
  write('  start           démarre le serveur local en arrière-plan');
  write('  stop            arrête le serveur local');
  write('  status          affiche l’état du serveur');
  write('  logs            affiche les dernières lignes du journal');
  write('  install         ouvre le menu d’installation/réparation');
  write('  doctor, check   diagnostic seul, n’installe rien');
  write('  update          met à jour PieceMaker');
  blank();
  write('  --all           installe tout sans menu');
  write('  --check         diagnostic seul, n\'installe rien');
  write('  --step <id>     rejoue une seule étape');
  write('  --dry-run       montre les actions sans les exécuter');
  write('  --yes, -y       accepte les valeurs par défaut (non interactif)');
  write('  --help, -h      cette aide');
  blank();
}

async function installerMenu(steps, ctx, { allowBack = false } = {}) {
  for (;;) {
    const choices = [
      { value: 'all', label: 'Tout installer', hint: 'recommandé au premier lancement' },
      { value: 'pick', label: 'Choisir les composants' },
      { value: 'check', label: 'Diagnostic', hint: 'vérifie sans rien modifier' },
      { value: allowBack ? 'back' : 'quit', label: allowBack ? 'Retour' : 'Quitter' },
    ];
    const choice = await select('Installation et réparation', choices);

    if (choice === 'quit' || choice === 'back') return;

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
    if (!allowBack) return;
    await pause();
  }
}

function printServerStatus(status) {
  title('État local');
  summary([
    ['Serveur HTTPS', status.running ? badge.done : badge.todo, status.running ? `PID ${status.pid || 'externe'}` : 'arrêté'],
    ['Interface web', status.running ? badge.done : badge.todo, status.url],
    ['Journal', badge.todo, status.logFile],
  ]);
  blank();
}

async function runOperationalCommand(command) {
  if (command === 'open') {
    const status = await openAdmin();
    log.ok(`Interface ouverte : ${status.url}`);
    return 0;
  }
  if (command === 'start') {
    const status = await startServer();
    log.ok(status.started ? `Serveur démarré : ${status.url}` : `Serveur déjà actif : ${status.url}`);
    return 0;
  }
  if (command === 'stop') {
    const status = await stopServer();
    if (status.alreadyStopped) log.info('Le serveur est déjà arrêté.');
    else log.ok('Serveur arrêté.');
    return 0;
  }
  if (command === 'status') {
    printServerStatus(await getServerStatus());
    return 0;
  }
  if (command === 'logs') {
    title('Journal du serveur');
    const content = readLogs();
    write(content || '  Aucun journal disponible.');
    blank();
    return 0;
  }
  if (command === 'update') {
    const previous = await getServerStatus();
    if (previous.running && previous.managed) await stopServer();
    try {
      const result = updateRepository();
      log.ok(`PieceMaker mis à jour (${result.ref}).`);
    } finally {
      if (previous.running && previous.managed) {
        const restarted = await startServer();
        log.ok(`Serveur redémarré : ${restarted.url}`);
      } else if (previous.running) {
        log.warn('Le serveur actif n’est pas géré par PieceMaker ; redémarrez-le manuellement.');
      }
    }
    return 0;
  }
  return null;
}

async function mainMenu(steps, ctx) {
  for (;;) {
    const status = await getServerStatus();
    printServerStatus(status);
    const choice = await select('Que voulez-vous faire ?', [
      { value: 'open', label: 'Ouvrir l’interface graphique', hint: 'paramètres, skills et agents' },
      { value: status.running ? 'stop' : 'start', label: status.running ? 'Arrêter le serveur local' : 'Démarrer le serveur local' },
      { value: 'status', label: 'Actualiser l’état' },
      { value: 'install', label: 'Installer ou réparer des composants' },
      { value: 'check', label: 'Diagnostic complet' },
      { value: 'update', label: 'Mettre à jour PieceMaker' },
      { value: 'logs', label: 'Afficher les journaux' },
      { value: 'quit', label: 'Quitter' },
    ]);

    if (choice === 'quit') return;
    if (choice === 'install') {
      await installerMenu(steps, ctx, { allowBack: true });
      continue;
    }
    if (choice === 'check') {
      await runCheck(steps, ctx);
      await pause();
      continue;
    }
    if (choice === 'update' && !(await confirm('Télécharger et appliquer la dernière version ?', true))) continue;

    try {
      await runOperationalCommand(choice);
    } catch (error) {
      log.error(error.message);
    }
    if (choice === 'open') return;
    await pause();
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

  if (flags.unknown.length) {
    banner();
    log.error(`Option ou commande inconnue : ${flags.unknown.join(' ')}`);
    printHelp();
    return 1;
  }

  banner();

  if (flags.command && !['install', 'doctor', 'check'].includes(flags.command)) {
    return runOperationalCommand(flags.command);
  }

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

  if (flags.check || flags.command === 'doctor' || flags.command === 'check') {
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

  if (flags.command === 'install') await installerMenu(steps, ctx);
  else await mainMenu(steps, ctx);
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    log.error(error.message);
    if (process.env.PIECEMAKER_DEBUG) log.detail(error.stack);
    process.exit(1);
  });

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
 *   piecemaker start|stop|restart gère le serveur local
 *   piecemaker status|logs     affiche l'état ou les journaux
 *   piecemaker chronology      affiche la chronologie du dossier courant
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
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { banner, title, log, write, blank, summary, spinner, badge, c } from '../lib/ui.mjs';
import { select, confirm, multiSelect, pause, nonInteractive } from '../lib/prompt.mjs';
import { REPO_ROOT, commandExists, findPython } from '../lib/platform.mjs';
import { loadConfig, readEnv, markStep, loadState, CONFIG_FILE } from '../lib/state.mjs';
import {
  getServerStatus,
  openAdmin,
  readLogs,
  restartTelegramDaemon,
  startServer,
  stopServer,
  checkForUpdate,
  updateRepository,
  depositRootClaudeMd,
} from '../lib/service.mjs';

const require = createRequire(import.meta.url);
const CLAUDE_ASSETS_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/claude-assets.cjs');
const CLAUDE_HOOKS_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/claude-hooks.cjs');
const CENTRAL_HOOK_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/central-hook-install.cjs');
const ASSISTANT_CHRONOLOGY_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/assistant-chronology.cjs');
const CASE_INSTRUCTIONS_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/case-instructions.cjs');

/**
 * The bootstrap/update command is also distributed as an installer-only
 * checkout. Claude integration modules are optional there and must not keep
 * the updater from starting before the first full repository sync.
 */
function loadClaudeIntegrations() {
  const integrations = {};
  if (fs.existsSync(CLAUDE_ASSETS_MODULE)) Object.assign(integrations, require(CLAUDE_ASSETS_MODULE));
  if (fs.existsSync(CLAUDE_HOOKS_MODULE)) Object.assign(integrations, require(CLAUDE_HOOKS_MODULE));
  return typeof integrations.syncClaudeAssets === 'function' && typeof integrations.installClaudeHooks === 'function'
    ? integrations
    : null;
}

/** Le hook central ne dépend ni du plugin ni d'un serveur déjà démarré. Le
 * charger après le reset Git permet à `piecemaker update` d'installer aussitôt
 * la nouvelle version et de migrer ses matchers, même si PieceMaker était
 * arrêté au moment de la mise à jour. */
function loadCentralHookIntegration() {
  if (!fs.existsSync(CENTRAL_HOOK_MODULE)) return null;
  try {
    const integration = require(CENTRAL_HOOK_MODULE);
    return typeof integration.installCentralHook === 'function' ? integration : null;
  } catch {
    return null;
  }
}

function reconcileCentralHook() {
  const integration = loadCentralHookIntegration();
  if (!integration) return false;
  const centralHook = integration.installCentralHook();
  if (centralHook.hook && centralHook.settings?.wired) {
    log.ok('Hook central d’anonymisation mis à jour et matchers réconciliés.');
    return true;
  }
  log.warn('Hook central d’anonymisation non réinstallé ; relancez « piecemaker start ».');
  return false;
}

function reconcileCaseInstructions() {
  if (!fs.existsSync(CASE_INSTRUCTIONS_MODULE)) return false;
  try {
    const { refreshRegisteredCaseRules } = require(CASE_INSTRUCTIONS_MODULE);
    if (typeof refreshRegisteredCaseRules !== 'function') return false;
    const result = refreshRegisteredCaseRules(REPO_ROOT, loadConfig());
    if (result.failed.length) {
      log.warn(`${result.failed.length} règle(s) de dossier n’ont pas pu être actualisées.`);
    }
    if (result.refreshed) log.ok(`${result.refreshed} règle(s) de dossier PieceMaker actualisée(s).`);
    return result.failed.length === 0;
  } catch (error) {
    log.warn(`Règles de dossier non actualisées (${error.message}).`);
    return false;
  }
}

/** Rejoue la partie non interactive de l'étape 15 après une mise à jour, mais
 * seulement pour une application Bureau déjà installée. Le chargement reste
 * dynamique : il intervient après le reset Git et utilise donc la nouvelle
 * version de l'étape qui vient d'être téléchargée. */
async function refreshDesktopApplicationAfterUpdate() {
  const stepPath = path.join(STEPS_DIR, '15-pwa-desktop.mjs');
  if (!fs.existsSync(stepPath)) return false;
  try {
    const step = await import(`${pathToFileURL(stepPath).href}?update=${Date.now()}`);
    if (typeof step.refreshInstalledDesktopApplication !== 'function') return false;
    const result = await step.refreshInstalledDesktopApplication();
    if (result.status !== 'skipped') markStep('15-pwa-desktop', result.status, result.note || '');
    if (result.status === 'done') log.ok('Application PieceMaker sur le Bureau mise à jour.');
    else if (result.status === 'partial') log.warn(`Application Bureau partiellement mise à jour : ${result.note}`);
    else if (result.status === 'failed') log.warn(`Application Bureau non mise à jour : ${result.note}`);
    return result.status === 'done';
  } catch (error) {
    log.warn(`Application Bureau non mise à jour (${error.message}).`);
    return false;
  }
}

const STEPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'steps');
const COMMANDS = new Set(['open', 'start', 'stop', 'restart', 'status', 'logs', 'chronology', 'install', 'doctor', 'check', 'update']);

const STATUS_BADGE = {
  done: badge.done,
  partial: badge.partial,
  failed: badge.failed,
  skipped: badge.skipped,
};

function parseArgs(argv) {
  const flags = {
    command: null,
    all: false,
    caseTarget: null,
    check: false,
    dryRun: false,
    json: false,
    step: null,
    yes: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !flags.command && COMMANDS.has(arg)) flags.command = arg;
    else if (!arg.startsWith('-') && flags.command === 'chronology' && !flags.caseTarget) flags.caseTarget = arg;
    else if (arg === '--all') flags.all = true;
    else if (arg === '--case') flags.caseTarget = argv[++i];
    else if (arg === '--check') flags.check = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--json') flags.json = true;
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
  write('  restart         redémarre le serveur local');
  write('  status          affiche l’état du serveur');
  write('  logs            affiche les dernières lignes du journal');
  write('  chronology      affiche la chronologie pseudonymisée du dossier courant');
  write('  install         ouvre le menu d’installation/réparation');
  write('  doctor, check   diagnostic seul, n’installe rien');
  write('  update          met à jour PieceMaker');
  blank();
  write('  --all           installe tout sans menu');
  write('  --case <chemin> cible un dossier enregistré (chronology)');
  write('  --json          produit un JSON sans décor (chronology)');
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

async function runChronologyCommand(flags) {
  if (!fs.existsSync(ASSISTANT_CHRONOLOGY_MODULE)) {
    throw new Error('Le module de chronologie PieceMaker est introuvable.');
  }
  const { chronologyForTarget, formatAssistantChronology } = require(ASSISTANT_CHRONOLOGY_MODULE);
  const chronology = await chronologyForTarget(loadConfig(), flags.caseTarget || process.cwd());
  const output = flags.json
    ? `${JSON.stringify(chronology, null, 2)}\n`
    : formatAssistantChronology(chronology);
  process.stdout.write(output);
  return 0;
}

async function runOperationalCommand(command, knownUpdate = null, flags = {}) {
  if (command === 'chronology') return runChronologyCommand(flags);
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
  if (command === 'restart') {
    await stopServer();
    const status = await startServer();
    log.ok(`Serveur redémarré : ${status.url}`);
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
    // Look before stopping anything: an up-to-date install must not lose its
    // server for the duration of a no-op npm install.
    const pending = knownUpdate ?? checkForUpdate();
    if (!pending.available) {
      log.ok(`PieceMaker est déjà à jour (${pending.ref}, ${pending.current.slice(0, 7)}).`);
      reconcileCaseInstructions();
      await refreshDesktopApplicationAfterUpdate();
      if (reconcileCentralHook()) {
        log.info('Rouvrez les sessions Claude Code/Codex actives pour charger les hooks et le MCP à jour.');
      }
      return 0;
    }
    if (pending.remoteAvailable) {
      log.info(`Nouvelle version disponible (${pending.changed.length} fichier(s) modifié(s)).`);
    } else {
      log.info(`Restauration de l’installation depuis le dépôt distant (${pending.localChanges} fichier(s) localement modifié(s)).`);
    }

    // A live server on the port is a PieceMaker server (the health probe
    // answered 200), whether we started it or not — e.g. one launched by hand
    // from the dev clone, so with no PID file it comes back unmanaged. We adopt
    // it: stop whatever holds the port and bring a managed server back below,
    // rather than leaving the user to restart it themselves.
    const previous = await getServerStatus();
    if (previous.running) await stopServer();
    try {
      const result = updateRepository(pending);
      log.ok(`PieceMaker mis à jour (${result.ref}, ${result.target.slice(0, 7)}).`);

      // CLAUDE.md racine est gitignoré : « git reset --hard » ci-dessus le
      // supprime dès qu'un clone récupère le commit qui l'a dé-versionné. On
      // redépose donc la persona utilisateur depuis le gabarit (absent → écrit,
      // présent → intact), même source que l'étape d'installation 09.
      if (depositRootClaudeMd().status === 'deposited') {
        log.ok('CLAUDE.md (persona utilisateur) redéposé depuis le gabarit.');
      }
      reconcileCaseInstructions();

      if (result.pythonChanged) {
        log.warn('requirements.txt a changé : relancez « piecemaker install » puis l’étape 03 — Python & GLiNER.');
      }

      // Les composants PieceMaker sont découverts directement dans
      // ~/.claude/{skills,agents}. Les liens symboliques suivent déjà le dépôt ;
      // cet appel rafraîchit aussi le repli par copie sur les plateformes qui ne
      // peuvent pas créer de liens.
      const claudeIntegrations = loadClaudeIntegrations();
      if (commandExists('claude', ['--version']) && claudeIntegrations) {
        const claudeAssets = claudeIntegrations.syncClaudeAssets(REPO_ROOT, os.homedir());
        if (claudeAssets.conflicts.length) {
          log.warn(`${claudeAssets.conflicts.length} skill(s)/agent(s) Claude personnel(s) homonyme(s) conservé(s).`);
        } else {
          log.ok(`${claudeAssets.registered} skill(s)/agent(s) PieceMaker synchronisé(s) pour Claude Code.`);
        }
        const claudeHooks = claudeIntegrations.installClaudeHooks(REPO_ROOT, os.homedir());
        if (!claudeHooks.ok) log.warn(`Hooks Claude Code non synchronisés (${claudeHooks.reason}).`);
        else if (claudeHooks.changed) log.ok(`${claudeHooks.registered} hook(s) PieceMaker synchronisé(s) pour Claude Code.`);
      }

      reconcileCentralHook();
      await refreshDesktopApplicationAfterUpdate();
      log.info('Rouvrez les sessions Claude Code/Codex actives pour charger les hooks et le MCP mis à jour.');
    } finally {
      if (previous.running) {
        const restarted = await startServer();
        log.ok(`Serveur redémarré : ${restarted.url}`);
      }
      const daemon = restartTelegramDaemon();
      if (daemon.restarted) log.ok('Moniteur Telegram redémarré.');
      else if (daemon.reason && daemon.reason !== 'absent' && daemon.reason !== 'unsupported') {
        log.warn(`Le moniteur Telegram n’a pas redémarré : ${daemon.reason}`);
      }
    }
    return 0;
  }
  return null;
}

/**
 * Check once before showing an interactive installer menu. A network or Git
 * failure must never prevent the local installer from opening.
 */
function checkForUpdateOnOpen() {
  const spin = spinner('Vérification des mises à jour...');
  try {
    const pending = checkForUpdate();
    spin.stop();
    if (pending.remoteAvailable) {
      log.warn(`MAJ disponible (${pending.changed.length} fichier(s) modifié(s)) — choisissez « Mettre à jour PieceMaker ».`);
    } else {
      log.ok('PieceMaker est à jour.');
    }
    blank();
    return pending;
  } catch (error) {
    spin.stop();
    log.warn('Vérification des mises à jour impossible ; l’installation locale reste disponible.');
    if (process.env.PIECEMAKER_DEBUG) log.detail(error.message);
    blank();
    return null;
  }
}

/**
 * Bare `piecemaker` should land on a live server. Start it if it is down, but
 * never block the menu on failure: a missing certificate or a boot error is
 * reported and the interactive installer below stays reachable to fix it.
 * The browser is left closed on purpose — the menu's "Ouvrir l'interface"
 * entry is how the admin pane gets opened.
 */
async function ensureServerRunning() {
  let status;
  try {
    status = await getServerStatus();
  } catch {
    return;
  }
  if (status.running) return;

  const spin = spinner('Démarrage du serveur local...');
  try {
    const started = await startServer();
    spin.stop();
    log.ok(`Serveur démarré : ${started.url}`);
  } catch (error) {
    spin.stop();
    log.warn(`Serveur non démarré : ${error.message}`);
    log.detail('Réparez-le via « Installer ou réparer des composants » ci-dessous.');
  }
  blank();
}

async function mainMenu(steps, ctx, knownUpdate = null) {
  for (;;) {
    const status = await getServerStatus();
    printServerStatus(status);
    const choice = await select('Que voulez-vous faire ?', [
      { value: 'open', label: 'Ouvrir l’interface graphique', hint: 'paramètres, skills et agents' },
      { value: status.running ? 'stop' : 'start', label: status.running ? 'Arrêter le serveur local' : 'Démarrer le serveur local' },
      { value: 'status', label: 'Actualiser l’état' },
      { value: 'install', label: 'Installer ou réparer des composants' },
      {
        value: 'update',
        label: knownUpdate?.remoteAvailable ? 'Mettre à jour PieceMaker — MAJ disponible' : 'Mettre à jour PieceMaker',
      },
      { value: 'logs', label: 'Afficher les journaux' },
      { value: 'quit', label: 'Quitter' },
    ]);

    if (choice === 'quit') return;
    if (choice === 'install') {
      await installerMenu(steps, ctx, { allowBack: true });
      continue;
    }
    if (choice === 'update' && !(await confirm('Télécharger et appliquer la dernière version ?', true))) continue;

    try {
      await runOperationalCommand(choice, choice === 'update' ? knownUpdate : null);
      if (choice === 'update') knownUpdate = null;
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

  if (flags.command !== 'chronology' && (flags.caseTarget || flags.json)) {
    banner();
    log.error('Les options --case et --json sont réservées à la commande chronology.');
    return 1;
  }

  // `--json` est consommé directement par les assistants : aucun bandeau ni
  // couleur ne doit précéder le document JSON.
  if (flags.command === 'chronology' && flags.json) {
    return runOperationalCommand(flags.command, null, flags);
  }

  banner();

  const opensInteractiveInstaller =
    (!flags.command || flags.command === 'install') &&
    !flags.all &&
    !flags.check &&
    !flags.step &&
    !nonInteractive;
  const knownUpdate = opensInteractiveInstaller ? checkForUpdateOnOpen() : null;

  if (flags.command && !['install', 'doctor', 'check'].includes(flags.command)) {
    return runOperationalCommand(flags.command, null, flags);
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
  else {
    await ensureServerRunning();
    await mainMenu(steps, ctx, knownUpdate);
  }
  return 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    log.error(error.message);
    if (process.env.PIECEMAKER_DEBUG) log.detail(error.stack);
    process.exit(1);
  });

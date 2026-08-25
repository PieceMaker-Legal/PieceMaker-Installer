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
 *   piecemaker graph build     construit le graphe juridique riche du dossier
 *   piecemaker graph query     interroge le graphe juridique riche du dossier
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
  configureLlmClients,
  getLitellmStatus,
  readLitellmLogs,
  startLitellmProxy,
  stopLitellmProxy,
} from '../lib/litellm-proxy.mjs';
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
const LEGAL_GRAPH_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../websocket-server/legal-graph.cjs');

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
const COMMANDS = new Set(['open', 'start', 'stop', 'restart', 'status', 'logs', 'chronology', 'graph', 'install', 'doctor', 'check', 'update']);
const GRAPH_ACTIONS = new Set(['build', 'query', 'status']);
const GRAPHIFY_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'AWS_ACCESS_KEY_ID', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT',
  'AZURE_OPENAI_ENDPOINT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GOOGLE_API_KEY', 'KIMI_BASE_URL',
  'MOONSHOT_API_KEY', 'OLLAMA_API_KEY', 'OLLAMA_BASE_URL', 'OLLAMA_HOST',
  'OLLAMA_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
]);

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
    backend: null,
    budget: 4000,
    caseTarget: null,
    check: false,
    dryRun: false,
    force: false,
    graphAction: null,
    graphQuestion: [],
    json: false,
    model: null,
    step: null,
    yes: false,
    unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') && !flags.command && COMMANDS.has(arg)) flags.command = arg;
    else if (!arg.startsWith('-') && flags.command === 'chronology' && !flags.caseTarget) flags.caseTarget = arg;
    else if (!arg.startsWith('-') && flags.command === 'graph' && !flags.graphAction && GRAPH_ACTIONS.has(arg)) flags.graphAction = arg;
    else if (!arg.startsWith('-') && flags.command === 'graph' && flags.graphAction === 'query') flags.graphQuestion.push(arg);
    else if (arg === '--all') flags.all = true;
    else if (arg === '--backend') flags.backend = argv[++i];
    else if (arg === '--budget') flags.budget = Number(argv[++i]);
    else if (arg === '--case') flags.caseTarget = argv[++i];
    else if (arg === '--check') flags.check = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--model') flags.model = argv[++i];
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
  write('  graph build     construit ou actualise le graphe juridique riche');
  write('  graph query     interroge les liens de droit du dossier');
  write('  graph status    indique si le graphe juridique est à jour');
  write('  install         ouvre le menu d’installation/réparation');
  write('  doctor, check   diagnostic seul, n’installe rien');
  write('  update          met à jour PieceMaker');
  blank();
  write('  --all           installe tout sans menu');
  write('  --case <chemin> cible un dossier enregistré (chronology/graph)');
  write('  --backend <nom> choisit le backend Graphify (graph build/query)');
  write('  --model <nom>   choisit le modèle d’extraction (graph build/query)');
  write('  --force         reconstruit le graphe même si les pièces sont inchangées');
  write('  --budget <n>    limite le contexte retourné par graph query (défaut 4000)');
  write('  --json          produit une sortie JSON sans décor (chronology/graph)');
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

function printServerStatus(status, proxy = null) {
  title('État local');
  const rows = [
    ['Serveur HTTPS', status.running ? badge.done : badge.todo, status.running ? `PID ${status.pid || 'externe'}` : 'arrêté'],
    ['Interface web', status.running ? badge.done : badge.todo, status.url],
    ['Journal', badge.todo, status.logFile],
  ];
  if (proxy) {
    const routed = Number(Boolean(proxy.routing?.claude)) + Number(Boolean(proxy.routing?.codex));
    rows.splice(1, 0,
      ['Proxy PII LiteLLM', proxy.running ? badge.done : proxy.installed ? badge.todo : badge.failed,
        proxy.running ? `PID ${proxy.pid || 'externe'} · ${proxy.origin}` : proxy.installed ? 'arrêté' : 'non installé'],
      ['Routage IA', routed === 2 ? badge.done : badge.todo, `${routed}/2 · Claude Code + Codex`]);
  }
  summary(rows);
  blank();
}

async function startProxyCompanion() {
  const status = await getLitellmStatus();
  if (!status.installed) return status;
  const clients = configureLlmClients({ config: loadConfig(), userHome: os.homedir() });
  for (const [name, result] of Object.entries(clients)) {
    if (!result.configured) log.warn(`${name === 'claude' ? 'Claude Code' : 'Codex'} non routé : ${result.reason}.`);
  }
  return startLitellmProxy();
}

async function stopProxyCompanion() {
  const status = await getLitellmStatus();
  if (!status.installed || (!status.running && !status.managed)) return status;
  return stopLitellmProxy();
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

async function runGraphCommand(flags) {
  if (!fs.existsSync(LEGAL_GRAPH_MODULE)) throw new Error('Le module de graphe juridique PieceMaker est introuvable.');
  if (!flags.graphAction) throw new Error('Action manquante : utilisez « piecemaker graph build|query|status ».');
  const { locateConfiguredCase } = require('../../piecemaker-plugin/scripts/lib/case-folders.cjs');
  const located = locateConfiguredCase(loadConfig(), flags.caseTarget || process.cwd());
  if (!located) {
    throw new Error('Lancez la commande depuis un dossier juridique enregistré ou passez --case <chemin>.');
  }
  const {
    buildLegalGraph,
    legalGraphStatus,
    queryLegalGraph,
  } = require(LEGAL_GRAPH_MODULE);
  const configuredEnv = Object.fromEntries(Object.entries(readEnv())
    .filter(([key]) => key.startsWith('GRAPHIFY_') || GRAPHIFY_ENV_KEYS.has(key)));
  const options = {
    backend: flags.backend,
    budget: flags.budget,
    env: { ...process.env, ...configuredEnv },
    force: flags.force,
    model: flags.model,
  };

  if (flags.graphAction === 'query') {
    const question = flags.graphQuestion.join(' ').trim();
    const result = await queryLegalGraph(located.caseRoot, question, options);
    process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
    return 0;
  }
  if (flags.graphAction === 'build') {
    const result = await buildLegalGraph(located.caseRoot, options);
    const status = {
      graphFile: result.graphFile,
      generatedAt: result.generatedAt,
      cacheHit: result.cacheHit,
      stats: result.graph.piecemaker,
    };
    if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else log.ok(result.cacheHit ? `Graphe juridique déjà à jour : ${result.graphFile}` : `Graphe juridique construit : ${result.graphFile}`);
    return 0;
  }

  const status = await legalGraphStatus(located.caseRoot);
  if (flags.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else if (!status.exists) log.info(`Aucun graphe juridique : ${status.graphFile}`);
  else if (status.stale) log.warn(`Graphe juridique à actualiser : ${status.graphFile}`);
  else log.ok(`Graphe juridique à jour : ${status.graphFile}`);
  return 0;
}

async function runOperationalCommand(command, knownUpdate = null, flags = {}) {
  if (command === 'chronology') return runChronologyCommand(flags);
  if (command === 'graph') return runGraphCommand(flags);
  if (command === 'open') {
    const proxy = await startProxyCompanion();
    if (proxy.installed) log.ok(proxy.started ? `Proxy PII démarré : ${proxy.origin}` : `Proxy PII actif : ${proxy.origin}`);
    const status = await openAdmin();
    log.ok(`Interface ouverte : ${status.url}`);
    return 0;
  }
  if (command === 'start') {
    const proxy = await startProxyCompanion();
    const status = await startServer();
    if (proxy.installed) log.ok(proxy.started ? `Proxy PII démarré : ${proxy.origin}` : `Proxy PII déjà actif : ${proxy.origin}`);
    else log.warn('Proxy PII LiteLLM non installé — relancez le composant 16.');
    log.ok(status.started ? `Serveur démarré : ${status.url}` : `Serveur déjà actif : ${status.url}`);
    return 0;
  }
  if (command === 'stop') {
    const status = await stopServer();
    const proxy = await stopProxyCompanion();
    if (status.alreadyStopped) log.info('Le serveur est déjà arrêté.');
    else log.ok('Serveur arrêté.');
    if (proxy.stopped) log.ok('Proxy PII LiteLLM arrêté.');
    return 0;
  }
  if (command === 'restart') {
    await stopServer();
    await stopProxyCompanion();
    const proxy = await startProxyCompanion();
    const status = await startServer();
    log.ok(`Serveur redémarré : ${status.url}`);
    if (proxy.installed) log.ok(`Proxy PII redémarré : ${proxy.origin}`);
    return 0;
  }
  if (command === 'status') {
    const [status, proxy] = await Promise.all([getServerStatus(), getLitellmStatus()]);
    printServerStatus(status, proxy);
    return 0;
  }
  if (command === 'logs') {
    title('Journal du serveur HTTPS');
    const content = readLogs();
    write(content || '  Aucun journal disponible.');
    blank();
    title('Journal du proxy PII LiteLLM');
    write(readLitellmLogs() || '  Aucun journal disponible.');
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
      const proxy = await getLitellmStatus();
      if (proxy.installed) configureLlmClients({ config: loadConfig(), userHome: os.homedir() });
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
    const [previous, previousProxy] = await Promise.all([getServerStatus(), getLitellmStatus()]);
    if (previous.running) await stopServer();
    if (previousProxy.running || previousProxy.managed) await stopLitellmProxy();
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
        log.warn('Une dépendance Python a changé : relancez « piecemaker install » (étapes 03 et 16 si elles sont installées).');
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
      if (previousProxy.installed) configureLlmClients({ config: loadConfig(), userHome: os.homedir() });
      await refreshDesktopApplicationAfterUpdate();
      log.info('Rouvrez les sessions Claude Code/Codex actives pour charger les hooks et le MCP mis à jour.');
    } finally {
      if (previous.running) {
        const restarted = await startServer();
        log.ok(`Serveur redémarré : ${restarted.url}`);
      }
      if (previousProxy.running || previousProxy.managed) {
        try {
          const restarted = await startLitellmProxy();
          log.ok(`Proxy PII redémarré : ${restarted.origin}`);
        } catch (error) {
          log.warn(`Proxy PII non redémarré : ${error.message}`);
        }
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
  try {
    await startProxyCompanion();
  } catch (error) {
    log.warn(`Proxy PII non démarré : ${error.message}`);
  }
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
    const [status, proxy] = await Promise.all([getServerStatus(), getLitellmStatus()]);
    printServerStatus(status, proxy);
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

  if (!['chronology', 'graph'].includes(flags.command) && (flags.caseTarget || flags.json)) {
    banner();
    log.error('Les options --case et --json sont réservées aux commandes chronology et graph.');
    return 1;
  }

  if (flags.command === 'graph' && (!Number.isFinite(flags.budget) || flags.budget <= 0)) {
    log.error('L’option --budget doit être un nombre strictement positif.');
    return 1;
  }

  // Les sorties JSON et les sous-graphes sont directement consommés par les
  // assistants : aucun bandeau PieceMaker ne doit les polluer.
  if ((flags.command === 'chronology' && flags.json)
      || (flags.command === 'graph' && (flags.graphAction === 'query' || flags.json))) {
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

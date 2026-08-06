/**
 * Superviseur Telegram PieceMaker.
 *
 * Porté depuis « Lord of the bots » : un daemon Telegram qui lance, arrête et
 * surveille des sessions Claude, une par projet. L'amont codait la liste des
 * projets en dur ; ici elle est déclarée ici, à l'installation.
 *
 * Écrit :
 *   ~/.piecemaker/orchestrator/projects.json        les projets pilotables
 *   ~/.claude/channels/telegram-piecemaker-lord/    token + allowlist du bot
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { log, c } from '../lib/ui.mjs';
import { ask, confirm, secret, nonInteractive } from '../lib/prompt.mjs';
import { REPO_ROOT, HOME_DIR, ensureDir, runCapture } from '../lib/platform.mjs';

const ORCHESTRATOR_SRC = path.join(REPO_ROOT, 'orchestrator');
const ORCHESTRATOR_DIR = path.join(HOME_DIR, 'orchestrator');
const PROJECTS_FILE = path.join(ORCHESTRATOR_DIR, 'projects.json');
const STATE_DIR = path.join(os.homedir(), '.claude', 'channels', 'telegram-piecemaker-lord');

export const meta = {
  id: '10-superviseur',
  label: 'Superviseur Telegram (bots par projet)',
  description: 'Daemon qui lance et surveille une session Claude par projet depuis Telegram',
};

function readProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : parsed.projects;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeProjects(projects) {
  ensureDir(ORCHESTRATOR_DIR);
  fs.writeFileSync(PROJECTS_FILE, `${JSON.stringify({ projects }, null, 2)}\n`, 'utf8');
}

/** Le token vit dans le state-dir du plugin telegram officiel, en 0600. */
function writeToken(token) {
  ensureDir(STATE_DIR);
  const file = path.join(STATE_DIR, '.env');
  fs.writeFileSync(file, `TELEGRAM_BOT_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows : pas de mode POSIX, les ACL du profil utilisateur s'appliquent.
  }
}

function writeAllowlist(ids) {
  ensureDir(STATE_DIR);
  const file = path.join(STATE_DIR, 'access.json');
  fs.writeFileSync(file, `${JSON.stringify({ allowFrom: ids }, null, 2)}\n`, 'utf8');
}

function hasToken() {
  try {
    return /^TELEGRAM_BOT_TOKEN=.+/m.test(fs.readFileSync(path.join(STATE_DIR, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

/** Déclare les projets un par un ; le dossier doit exister. */
async function collectProjects(existing) {
  const projects = [...existing];

  if (projects.length) {
    log.info(`${projects.length} projet(s) déjà déclaré(s) : ${projects.map((p) => p.name).join(', ')}`);
    if (!(await confirm('Ajouter d\'autres projets ?', false))) return projects;
  }

  for (;;) {
    const name = await ask('Nom court du projet (vide pour terminer)', { def: '' });
    if (!name) break;
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      log.warn('Nom invalide : lettres, chiffres, tiret et souligné uniquement.');
      continue;
    }
    if (projects.some((p) => p.name === name)) {
      log.warn(`« ${name} » est déjà déclaré.`);
      continue;
    }

    const workdir = await ask(`Dossier de travail de « ${name} »`, {
      def: name === 'piecemaker' ? REPO_ROOT : '',
      required: true,
    });
    if (!fs.existsSync(workdir)) {
      log.warn(`Dossier introuvable : ${workdir} — projet ignoré.`);
      continue;
    }

    const aliases = (await ask('Alias séparés par des virgules (facultatif)', { def: '' }))
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);

    projects.push({ name, workdir, aliases, permissionMode: 'auto' });
    log.ok(`« ${name} » ajouté`);
  }

  return projects;
}

export async function install(ctx) {
  if (!fs.existsSync(ORCHESTRATOR_SRC)) {
    return { status: 'failed', note: `Dossier orchestrator/ introuvable : ${ORCHESTRATOR_SRC}` };
  }

  // Le superviseur pilote des fenêtres Terminal via osascript.
  if (process.platform !== 'darwin') {
    log.warn('Le superviseur ouvre une fenêtre Terminal macOS par session (osascript).');
    log.detail('Sur Windows, la configuration est écrite mais le lancement de sessions ne fonctionnera pas.');
  }

  if (ctx.dryRun) {
    log.info(`[simulation] Écriture de ${PROJECTS_FILE}`);
    log.info(`[simulation] Écriture du token et de l'allowlist dans ${STATE_DIR}`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (nonInteractive) {
    return {
      status: 'skipped',
      note: 'Mode non interactif : le token du bot et les projets doivent être saisis à la main.',
    };
  }

  log.step('Un bot Telegram dédié au superviseur est nécessaire.');
  log.detail('1. Ouvrez @BotFather sur Telegram, envoyez /newbot et suivez les instructions.');
  log.detail('2. Copiez le token fourni (format 123456789:AA...).');
  log.detail('Ce bot ne pilote pas de session : il lance et arrête celles des projets.');

  if (hasToken()) {
    log.ok('Un token de superviseur est déjà enregistré.');
    if (!(await confirm('Le remplacer ?', false))) log.info('Token conservé.');
    else {
      const token = await secret('Token du bot superviseur');
      if (token) writeToken(token);
      else log.warn('Aucun token saisi — l\'ancien est conservé.');
    }
  } else {
    const token = await secret('Token du bot superviseur');
    if (!token) {
      return { status: 'partial', note: 'Aucun token saisi — le superviseur ne démarrera pas.' };
    }
    writeToken(token);
    log.ok(`Token enregistré (0600) dans ${STATE_DIR}`);
  }

  // Sans allowlist, n'importe qui peut piloter les sessions en écrivant au bot.
  const idsRaw = await ask('Identifiants Telegram autorisés, séparés par des virgules', { def: '' });
  const ids = idsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    writeAllowlist(ids);
    log.ok(`Allowlist enregistrée : ${ids.join(', ')}`);
  } else {
    log.warn('Allowlist vide : le superviseur refusera tous les messages.');
    log.detail(`Complétez-la plus tard dans ${path.join(STATE_DIR, 'access.json')}`);
  }

  const projects = await collectProjects(readProjects());
  writeProjects(projects);

  if (!projects.length) {
    return {
      status: 'partial',
      note: `Aucun projet déclaré — ajoutez-les dans ${PROJECTS_FILE}.`,
    };
  }

  log.ok(`${projects.length} projet(s) déclaré(s) dans ${PROJECTS_FILE}`);
  log.info('Démarrage du superviseur :');
  log.detail(`node ${path.join(ORCHESTRATOR_SRC, 'piecemaker-daemon.mjs')}`);

  return { status: 'done', note: `${projects.length} projet(s), token et allowlist configurés.` };
}

export async function check() {
  if (!fs.existsSync(ORCHESTRATOR_SRC)) {
    return { status: 'failed', note: 'Dossier orchestrator/ absent du dépôt.' };
  }

  const daemon = path.join(ORCHESTRATOR_SRC, 'piecemaker-daemon.mjs');
  const syntax = runCapture(process.execPath, ['--check', daemon]);
  if (syntax.code !== 0) {
    return { status: 'failed', note: `piecemaker-daemon.mjs ne compile pas : ${syntax.stderr.split('\n')[0]}` };
  }

  const projects = readProjects();
  const token = hasToken();

  if (!token && !projects.length) {
    return { status: 'todo', note: 'Superviseur non configuré (ni token ni projet).' };
  }
  if (!token) {
    return { status: 'partial', note: `${projects.length} projet(s) déclaré(s), token du bot absent.` };
  }
  if (!projects.length) {
    return { status: 'partial', note: `Token présent, aucun projet déclaré dans ${PROJECTS_FILE}.` };
  }

  return {
    status: 'done',
    note: `${projects.length} projet(s) : ${projects.map((p) => p.name).join(', ')}`,
  };
}

/**
 * Step 10 — pandoc et typst, moteurs de la voie génération (PDF/DOCX).
 *
 * Distinct du tamponnage (pièces du client, toujours LibreOffice via
 * `10-libreoffice.mjs`) : ici il s'agit d'exporter en PDF/DOCX un HTML que
 * PieceMaker écrit lui-même — la chronologie et l'historique mensuel. pandoc
 * convertit ce HTML en DOCX (et pilote typst pour le PDF), avec de vrais
 * styles Word et une bien meilleure typographie qu'un simple export
 * navigateur.
 *
 * pandoc et typst sont **facultatifs** : sans eux, l'export retombe
 * entièrement sur LibreOffice et reste pleinement fonctionnel, seule la
 * qualité du rendu baisse. Cette étape ne renvoie donc jamais `failed` —
 * même un échec d'installation aboutit à `partial`, avec une note qui
 * explique le repli plutôt que d'alarmer inutilement `piecemaker doctor`.
 */

import { createRequire } from 'node:module';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { commandExists, run, IS_MAC, IS_WINDOWS, REPO_ROOT } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';

const require = createRequire(import.meta.url);
const { findPandoc, findTypst } = require(`${REPO_ROOT}/websocket-server/lib/doc-generate.cjs`);

export const meta = {
  id: '10-pandoc',
  label: 'Génération PDF/DOCX (pandoc + typst)',
  description: "Installe pandoc et typst, utilisés pour l'export de la chronologie et de l'historique",
};

const PANDOC_MANUAL_URL = 'https://pandoc.org/installing.html';
const TYPST_MANUAL_URL = 'https://github.com/typst/typst/releases';

/** Commande d'installation de pandoc adaptée au système, ou null. */
function pandocInstaller() {
  if (IS_MAC) {
    if (commandExists('brew')) return { command: 'brew', args: ['install', 'pandoc'], manager: 'Homebrew' };
    return null;
  }
  if (IS_WINDOWS) {
    if (commandExists('winget', ['--version'])) {
      return {
        command: 'winget',
        args: ['install', '-e', '--id', 'JohnMacFarlane.Pandoc',
          '--accept-package-agreements', '--accept-source-agreements'],
        manager: 'winget',
      };
    }
    return null;
  }
  if (commandExists('apt-get', ['--version'])) {
    return { command: 'sudo', args: ['apt-get', 'install', '-y', 'pandoc'], manager: 'apt' };
  }
  if (commandExists('dnf', ['--version'])) {
    return { command: 'sudo', args: ['dnf', 'install', '-y', 'pandoc'], manager: 'dnf' };
  }
  return null;
}

/**
 * Commande d'installation de typst, ou null.
 * Sur Linux, aucune distribution courante ne le paquette : on ne tente rien,
 * on journalise l'adresse des binaires officiels.
 */
function typstInstaller() {
  if (IS_MAC) {
    if (commandExists('brew')) return { command: 'brew', args: ['install', 'typst'], manager: 'Homebrew' };
    return null;
  }
  if (IS_WINDOWS) {
    if (commandExists('winget', ['--version'])) {
      return {
        command: 'winget',
        args: ['install', '-e', '--id', 'Typst.Typst',
          '--accept-package-agreements', '--accept-source-agreements'],
        manager: 'winget',
      };
    }
    return null;
  }
  return null;
}

/** Enregistre <ENV_KEY> si le binaire n'est pas joignable par son nom seul. */
function recordPath(bareName, resolvedPath, envKey) {
  if (resolvedPath === bareName) return;
  writeEnv({ [envKey]: resolvedPath });
  log.detail(`${envKey} enregistré : ${resolvedPath}`);
}

/**
 * Installe un outil facultatif (pandoc ou typst) si un gestionnaire de
 * paquets est disponible et que l'utilisateur accepte. Ne renvoie jamais
 * d'échec bloquant : au pire, l'outil reste absent et l'appelant le note.
 */
async function ensureTool({ name, find, installer, manualUrl, usage }) {
  if (!installer) {
    log.warn(`${name} introuvable — aucun gestionnaire de paquets reconnu pour l'installer automatiquement.`);
    log.detail(`Binaires officiels : ${manualUrl}`);
    return null;
  }

  log.info(usage);
  const accepted = await confirm(`Installer ${name} via ${installer.manager} ?`, true);
  if (!accepted) {
    log.detail(`${name} non installé — relancez cette étape pour réessayer.`);
    return null;
  }

  const spin = spinner(`Installation de ${name} (${installer.manager})...`);
  const code = await run(installer.command, installer.args, {
    onLine: (line) => spin.update(line.slice(0, 100)),
  });

  const resolved = find();
  if (code === 0 && resolved) {
    spin.succeed(`${name} installé (${resolved})`);
    return resolved;
  }

  spin.fail(`Installation de ${name} échouée`);
  log.detail(`Installez-le manuellement depuis ${manualUrl}, puis relancez cette étape.`);
  return null;
}

export async function install(ctx) {
  log.step('Vérification de pandoc et typst...');

  const existingPandoc = findPandoc();
  const existingTypst = findTypst();

  if (ctx.dryRun) {
    if (!existingPandoc) {
      const installer = pandocInstaller();
      log.info(installer
        ? `[simulation] ${installer.command} ${installer.args.join(' ')}`
        : `[simulation] Installation manuelle de pandoc depuis ${PANDOC_MANUAL_URL}`);
    } else {
      log.info(`[simulation] pandoc déjà présent (${existingPandoc})`);
    }
    if (!existingTypst) {
      const installer = typstInstaller();
      log.info(installer
        ? `[simulation] ${installer.command} ${installer.args.join(' ')}`
        : `[simulation] Installation manuelle de typst depuis ${TYPST_MANUAL_URL}`);
    } else {
      log.info(`[simulation] typst déjà présent (${existingTypst})`);
    }
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  let pandoc = existingPandoc;
  if (pandoc) {
    log.ok(`pandoc déjà installé (${pandoc})`);
  } else {
    pandoc = await ensureTool({
      name: 'pandoc',
      find: findPandoc,
      installer: pandocInstaller(),
      manualUrl: PANDOC_MANUAL_URL,
      usage: "pandoc convertit le HTML de la chronologie et de l'historique en DOCX pour l'export (léger, quelques Mo).",
    });
  }
  if (pandoc) recordPath('pandoc', pandoc, 'PANDOC_PATH');

  let typst = existingTypst;
  if (typst) {
    log.ok(`typst déjà installé (${typst})`);
  } else {
    typst = await ensureTool({
      name: 'typst',
      find: findTypst,
      installer: typstInstaller(),
      manualUrl: TYPST_MANUAL_URL,
      usage: 'typst sert de moteur PDF à pandoc pour un export direct et soigné (léger, un seul binaire).',
    });
  }
  if (typst) recordPath('typst', typst, 'TYPST_PATH');

  if (pandoc && typst) {
    return { status: 'done', note: '' };
  }
  if (pandoc && !typst) {
    return {
      status: 'partial',
      note: "typst absent — ce n'est pas un échec : le PDF de la chronologie et de l'historique passera par pandoc→DOCX puis LibreOffice, ce qui reste pleinement fonctionnel (rendu un peu moins soigné). Réessayer : node installer/bin/piecemaker.mjs --step 10-pandoc",
    };
  }
  return {
    status: 'partial',
    note: "pandoc absent — ce n'est pas un échec : les exports de la chronologie et de l'historique retombent entièrement sur LibreOffice et restent pleinement fonctionnels, avec une qualité de rendu moindre. Réessayer : node installer/bin/piecemaker.mjs --step 10-pandoc",
  };
}

export async function check() {
  const pandoc = findPandoc();
  const typst = findTypst();

  if (pandoc && typst) return { status: 'done', note: '' };
  if (pandoc && !typst) {
    return {
      status: 'partial',
      note: "typst absent — ce n'est pas un échec : le PDF de la chronologie et de l'historique passera par pandoc→DOCX puis LibreOffice, ce qui reste pleinement fonctionnel.",
    };
  }
  return {
    status: 'partial',
    note: "pandoc absent — ce n'est pas un échec : les exports de la chronologie et de l'historique retombent entièrement sur LibreOffice et restent pleinement fonctionnels.",
  };
}

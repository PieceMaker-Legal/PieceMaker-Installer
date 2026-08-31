/**
 * Étape 11 — outil `.docx` : le plugin `docx-cli` (kklimuk/docx-cli).
 *
 * PieceMaker manipule des documents Word de bout en bout : les pièces d'un
 * dossier, et les actes rédigés pour le cabinet. `docx-cli` remplace le skill
 * `document-skills:docx` d'Anthropic : au lieu de dépaqueter l'OOXML à la main
 * (`unzip`/`zip` + `pandoc`), il expose un binaire `docx` qui mute le XML
 * **en place** — les styles maison, les couleurs de thème et les objets
 * embarqués survivent — et adresse le contenu par localisateurs stables. Le
 * mode « modifications suivies » (`docx track-changes`), requis pour un acte
 * juridique qu'un tiers doit relire, est un verbe de premier plan.
 *
 * Il travaille entièrement par Bash. C'est pour cela que le garde-fou
 * `protect-originals.mjs` inspecte les commandes shell : sans cela, un
 * `docx read pièce.docx` contournerait la protection des pièces.
 *
 * Trois choses, toutes idempotentes :
 *   1. enregistrer le marketplace `kklimuk/docx-cli` ;
 *   2. installer `docx-cli@docx-cli` ;
 *   3. l'activer — une installation antérieure a pu le laisser désactivé dans
 *      ~/.claude/settings.json, et `install` ne réactive pas tout seul.
 *
 * Le binaire `docx` lui-même n'est pas installé ici : le skill embarque son
 * `scripts/bootstrap.sh`, qui résout la dernière version publiée, la télécharge
 * épinglée au tag et vérifie son SHA-256 avant de la poser sur le PATH. On se
 * contente de signaler son absence.
 */

import { log, spinner } from '../lib/ui.mjs';
import { commandExists, run, runCapture } from '../lib/platform.mjs';

export const meta = {
  id: '11-docx-cli',
  label: 'Outil docx-cli (documents Word)',
  description: 'Installe et active le plugin docx-cli, qui pilote les .docx via le binaire « docx »',
};

const MARKETPLACE_NAME = 'docx-cli';
const MARKETPLACE_REPO = 'kklimuk/docx-cli';
const PLUGIN_NAME = 'docx-cli';
const PLUGIN_SPEC = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;

function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function listMarketplaces() {
  const result = runCapture('claude', ['plugin', 'marketplace', 'list', '--json']);
  return result.code === 0 ? parseJson(result.stdout) : null;
}

function findPlugin(plugins) {
  if (!Array.isArray(plugins)) return null;
  return plugins.find((plugin) => plugin.id === PLUGIN_SPEC || plugin.name === PLUGIN_NAME) || null;
}

function pluginState() {
  const result = runCapture('claude', ['plugin', 'list', '--json']);
  if (result.code !== 0) return { installed: false, enabled: false, known: false };
  const plugin = findPlugin(parseJson(result.stdout));
  return { installed: Boolean(plugin), enabled: Boolean(plugin) && plugin.enabled !== false, known: true };
}

function binaryPresent() {
  return commandExists('docx', ['--version']);
}

export async function install() {
  if (!commandExists('claude', ['--version'])) {
    log.warn('CLI « claude » introuvable : docx-cli ne peut pas être installé.');
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }

  const marketplaces = listMarketplaces();
  const registered = Array.isArray(marketplaces)
    && marketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME);

  if (!registered) {
    const spin = spinner(`Enregistrement du marketplace ${MARKETPLACE_REPO}...`);
    const code = await run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
    if (code !== 0) {
      spin.fail('Échec de l\'enregistrement du marketplace docx-cli.');
      return { status: 'failed', note: `Impossible d'enregistrer ${MARKETPLACE_REPO}.` };
    }
    spin.succeed('Marketplace docx-cli enregistré.');
  } else {
    log.ok(`Marketplace « ${MARKETPLACE_NAME} » déjà enregistré.`);
  }

  let state = pluginState();
  if (!state.installed) {
    const spin = spinner(`Installation du plugin ${PLUGIN_SPEC}...`);
    const code = await run('claude', ['plugin', 'install', PLUGIN_SPEC]);
    if (code !== 0) {
      spin.fail('Échec de l\'installation du plugin docx-cli.');
      return { status: 'failed', note: `Impossible d'installer ${PLUGIN_SPEC}.` };
    }
    spin.succeed('Plugin docx-cli installé.');
    state = pluginState();
  } else {
    log.ok(`Plugin « ${PLUGIN_SPEC} » déjà installé.`);
  }

  // Un plugin installé puis désactivé reste dans `enabledPlugins` à `false` :
  // `install` ne le rallume pas, seul `enable` le fait.
  if (!state.enabled) {
    const spin = spinner('Activation du plugin docx-cli...');
    const code = await run('claude', ['plugin', 'enable', PLUGIN_SPEC]);
    if (code !== 0) {
      spin.fail('Le plugin est installé mais n\'a pas pu être activé.');
      return { status: 'partial', note: `Activez-le à la main : claude plugin enable ${PLUGIN_SPEC}` };
    }
    spin.succeed('Plugin docx-cli activé.');
  } else {
    log.ok('Plugin docx-cli déjà activé.');
  }

  if (binaryPresent()) {
    log.ok('Binaire « docx » présent sur le PATH.');
  } else {
    log.info('Binaire « docx » absent : le skill l\'installera (SHA-256 vérifié) à sa première activation.');
  }

  log.info('Le skill « docx-cli » sera disponible à la prochaine session Claude Code.');
  return { status: 'done', note: '' };
}

export async function check() {
  if (!commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }
  const state = pluginState();
  if (!state.known) return { status: 'failed', note: 'La CLI claude n\'a pas pu lister les plugins.' };
  if (!state.installed) return { status: 'failed', note: `Plugin ${PLUGIN_SPEC} non installé.` };
  if (!state.enabled) return { status: 'partial', note: `Plugin installé mais désactivé (claude plugin enable ${PLUGIN_SPEC}).` };
  if (!binaryPresent()) {
    return { status: 'done', note: 'Binaire « docx » pas encore posé : le skill l\'installe à sa première activation.' };
  }
  return { status: 'done', note: '' };
}

/**
 * Étape 11 — skill `docx` officiel (plugin `document-skills`).
 *
 * PieceMaker manipule des documents Word de bout en bout : les pièces d'un
 * dossier, et les actes rédigés pour le cabinet. Le skill `docx` d'Anthropic
 * est ce qui donne à Claude Code une prise réelle dessus — extraction par
 * pandoc, dépaquetage OOXML, et surtout le mode « redlining » (modifications
 * suivies), requis pour un acte juridique qu'un tiers doit relire.
 *
 * Il travaille entièrement par Bash. C'est pour cela que le garde-fou
 * `protect-originals.mjs` inspecte les commandes shell : sans cela, un
 * `pandoc pièce.pdf` ou un `python ooxml/scripts/unpack.py pièce.docx`
 * contournerait la protection des pièces.
 *
 * Trois choses, toutes idempotentes :
 *   1. enregistrer le marketplace `anthropics/skills` (nom : anthropic-agent-skills) ;
 *   2. installer `document-skills` ;
 *   3. l'activer — une installation antérieure a pu le laisser désactivé dans
 *      ~/.claude/settings.json, et `install` ne réactive pas tout seul.
 */

import { log, spinner } from '../lib/ui.mjs';
import { commandExists, run, runCapture } from '../lib/platform.mjs';

export const meta = {
  id: '11-document-skills',
  label: 'Skill docx (documents Word)',
  description: 'Installe et active le plugin officiel document-skills, qui porte le skill docx',
};

const MARKETPLACE_NAME = 'anthropic-agent-skills';
const MARKETPLACE_REPO = 'anthropics/skills';
const PLUGIN_NAME = 'document-skills';
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

export async function install() {
  if (!commandExists('claude', ['--version'])) {
    log.warn('CLI « claude » introuvable : le skill docx ne peut pas être installé.');
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }

  const marketplaces = listMarketplaces();
  const registered = Array.isArray(marketplaces)
    && marketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME);

  if (!registered) {
    const spin = spinner(`Enregistrement du marketplace ${MARKETPLACE_REPO}...`);
    const code = await run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_REPO]);
    if (code !== 0) {
      spin.fail('Échec de l\'enregistrement du marketplace des skills Anthropic.');
      return { status: 'failed', note: `Impossible d'enregistrer ${MARKETPLACE_REPO}.` };
    }
    spin.succeed('Marketplace des skills Anthropic enregistré.');
  } else {
    log.ok(`Marketplace « ${MARKETPLACE_NAME} » déjà enregistré.`);
  }

  let state = pluginState();
  if (!state.installed) {
    const spin = spinner(`Installation du plugin ${PLUGIN_SPEC}...`);
    const code = await run('claude', ['plugin', 'install', PLUGIN_SPEC]);
    if (code !== 0) {
      spin.fail('Échec de l\'installation du plugin document-skills.');
      return { status: 'failed', note: `Impossible d'installer ${PLUGIN_SPEC}.` };
    }
    spin.succeed('Plugin document-skills installé.');
    state = pluginState();
  } else {
    log.ok(`Plugin « ${PLUGIN_SPEC} » déjà installé.`);
  }

  // Un plugin installé puis désactivé reste dans `enabledPlugins` à `false` :
  // `install` ne le rallume pas, seul `enable` le fait.
  if (!state.enabled) {
    const spin = spinner('Activation du plugin document-skills...');
    const code = await run('claude', ['plugin', 'enable', PLUGIN_SPEC]);
    if (code !== 0) {
      spin.fail('Le plugin est installé mais n\'a pas pu être activé.');
      return { status: 'partial', note: `Activez-le à la main : claude plugin enable ${PLUGIN_SPEC}` };
    }
    spin.succeed('Plugin document-skills activé.');
  } else {
    log.ok('Plugin document-skills déjà activé.');
  }

  log.info('Le skill « docx » sera disponible à la prochaine session Claude Code.');
  return { status: 'done', note: '' };
}

export async function check() {
  if (!commandExists('claude', ['--version'])) {
    return { status: 'skipped', note: 'CLI "claude" introuvable.' };
  }
  const state = pluginState();
  if (!state.known) return { status: 'failed', note: 'La CLI claude n\'a pas pu lister les plugins.' };
  if (state.enabled) return { status: 'done', note: '' };
  if (state.installed) return { status: 'partial', note: `Plugin installé mais désactivé (claude plugin enable ${PLUGIN_SPEC}).` };
  return { status: 'failed', note: `Plugin ${PLUGIN_SPEC} non installé.` };
}

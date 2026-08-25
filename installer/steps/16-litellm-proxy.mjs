/** Étape 16 — passerelle LiteLLM et mapping réseau pour Claude Code/Codex. */

import os from 'node:os';

import {
  configureLlmClients,
  getLitellmStatus,
  installLitellmDependencies,
  installLitellmLaunchAgent,
  litellmDependenciesStatus,
  llmClientProxyStatus,
  startLitellmProxy,
} from '../lib/litellm-proxy.mjs';
import { IS_MAC } from '../lib/platform.mjs';
import { log, spinner } from '../lib/ui.mjs';

export const meta = {
  id: '16-litellm-proxy',
  label: 'Proxy PII LiteLLM — Claude Code & Codex',
  description: 'Installe la passerelle locale, applique le mapping central et route automatiquement les clients IA',
};

function clientIssues(clients) {
  return Object.entries(clients)
    .filter(([, result]) => !result.configured)
    .map(([name, result]) => `${name === 'claude' ? 'Claude Code' : 'Codex'} (${result.reason || 'configuration impossible'})`);
}

export async function install(ctx) {
  if (ctx.dryRun) {
    log.info('[simulation] création du venv LiteLLM dans ~/.piecemaker/litellm-venv');
    log.info('[simulation] routage Claude Code et Codex vers le proxy local PieceMaker');
    if (IS_MAC) log.info('[simulation] installation du service de session macOS com.piecemaker.litellm');
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  const dependencySpin = spinner('Installation de LiteLLM et de son proxy...');
  let dependencies;
  try {
    dependencies = await installLitellmDependencies({
      config: ctx.config,
      onLine: (line) => dependencySpin.update(String(line).replace(/\s+/g, ' ').slice(0, 110)),
    });
    dependencySpin.stop();
    log.ok(`LiteLLM ${dependencies.version} ${dependencies.changed ? 'installé' : 'déjà installé'}.`);
  } catch (error) {
    dependencySpin.stop();
    return { status: 'failed', note: error.message };
  }

  const clients = configureLlmClients({ config: ctx.config, userHome: os.homedir() });
  for (const [name, result] of Object.entries(clients)) {
    const label = name === 'claude' ? 'Claude Code' : 'Codex';
    if (result.configured) log.ok(`${label} ${result.changed ? 'routé' : 'déjà routé'} via LiteLLM.`);
    else log.warn(`${label} non modifié : ${result.reason}.`);
  }

  try {
    if (IS_MAC) installLitellmLaunchAgent({ config: ctx.config, userHome: os.homedir() });
    const service = await startLitellmProxy({ config: ctx.config });
    log.ok(`Proxy LiteLLM ${service.started ? 'démarré' : 'déjà actif'} : ${service.origin}`);
  } catch (error) {
    return { status: 'failed', note: error.message };
  }

  const issues = clientIssues(clients);
  if (issues.length) {
    return { status: 'partial', note: `Proxy actif ; configuration à vérifier : ${issues.join(', ')}.` };
  }
  return {
    status: 'done',
    note: `LiteLLM ${dependencies.version} actif ; Claude Code et Codex passent automatiquement par le mapping PieceMaker.`,
  };
}

export async function check(ctx) {
  const dependencies = litellmDependenciesStatus({ config: ctx.config });
  const clients = llmClientProxyStatus({ config: ctx.config, userHome: os.homedir() });
  const service = await getLitellmStatus({ config: ctx.config });
  if (!dependencies.installed) return { status: 'failed', note: 'LiteLLM absent ou incompatible.' };
  const missing = [!clients.claude && 'Claude Code', !clients.codex && 'Codex'].filter(Boolean);
  if (!service.running || missing.length) {
    const notes = [!service.running && 'proxy arrêté', missing.length && `${missing.join(' et ')} non routé(s)`].filter(Boolean);
    return { status: 'partial', note: notes.join(' ; ') };
  }
  return {
    status: 'done',
    note: `LiteLLM ${dependencies.version} actif${service.autoStart ? ' au démarrage de session' : ''}.`,
  };
}

/**
 * Step 00 — identify the user responsible for PieceMaker tasks.
 *
 * The identity is stored in the global, permission-restricted .env and is
 * written into every legal-case Git commit as both author and committer.
 */

import os from 'node:os';
import { createRequire } from 'node:module';

import { ask } from '../lib/prompt.mjs';
import { runCapture } from '../lib/platform.mjs';
import { writeEnv } from '../lib/state.mjs';
import { log } from '../lib/ui.mjs';

const require = createRequire(import.meta.url);
const {
  COMMIT_USER_NAME_KEY,
  resolveCommitIdentity,
} = require('../../piecemaker-plugin/scripts/lib/commits.cjs');

export const meta = {
  id: '00-identite',
  label: 'Identification de l’utilisateur',
  description: 'Signe chaque tâche enregistrée dans l’historique avec votre nom',
};

function gitConfig(key) {
  const result = runCapture('git', ['config', '--global', '--get', key]);
  return result.code === 0 ? result.stdout : '';
}

function defaults(ctx) {
  const username = os.userInfo().username || 'utilisateur';
  return ctx.env?.[COMMIT_USER_NAME_KEY]
    || process.env[COMMIT_USER_NAME_KEY]
    || gitConfig('user.name')
    || username;
}

export async function install(ctx) {
  const current = defaults(ctx);
  const name = await ask('Votre nom (signature des tâches)', { def: current, required: true });
  const identity = resolveCommitIdentity({ identity: { name } });

  if (ctx.dryRun) {
    log.info(`[simulation] identité des commits : ${identity.name}`);
    return { status: 'skipped', note: identity.name };
  }

  writeEnv({
    [COMMIT_USER_NAME_KEY]: identity.name,
  });
  log.ok(`Identité enregistrée : ${identity.name}`);
  log.detail('Elle sera appliquée comme auteur et validateur de chaque commit PieceMaker.');
  return { status: 'done', note: identity.name };
}

export async function check(ctx) {
  try {
    const identity = resolveCommitIdentity({ identity: {
      name: ctx.env?.[COMMIT_USER_NAME_KEY],
    } });
    return { status: 'done', note: identity.name };
  } catch {
    return {
      status: 'partial',
      note: 'Identité absente ou invalide — relancez cette étape ou renseignez-la dans les paramètres administrateur.',
    };
  }
}

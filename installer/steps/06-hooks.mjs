/**
 * Étape 06 — hooks Claude Code (protection, mapping, commits, facturation).
 *
 * Écrit la configuration d'exécution des hooks dans ~/.piecemaker/config.json,
 * puis prouve que chaque script tourne proprement en lui envoyant une charge
 * utile synthétique sur stdin — le contrat exact qu'utilise Claude Code (voir
 * piecemaker-plugin/scripts/lib/hook-io.mjs).
 *
 * Les hooks ne scannent plus les données personnelles : ni GLiNER, ni
 * heuristiques. Ils appliquent le mapping du dossier à ce que l'IA lit et le
 * rétablissent sur ce qu'elle produit. Le scan reste dans le pipeline de
 * l'administration, seul endroit où les modèles NER sont chargés — les charger
 * à chaque lecture rendrait la session inutilisable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { REPO_ROOT, HOME_DIR, runCapture, ensureDir } from '../lib/platform.mjs';
import { updateConfig } from '../lib/state.mjs';

export const meta = {
  id: '06-hooks',
  label: 'Hooks Claude Code (anonymisation, commits & facturation)',
  description: 'Configure les garde-fous, les commits PostToolUse et le suivi de facturation',
};

const PLUGIN_ROOT = path.join(REPO_ROOT, 'piecemaker-plugin');
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
const HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const BILLING_DIR = path.join(HOME_DIR, 'billing');
const SYNTHESE_DIR = path.join(BILLING_DIR, 'synthese');

const HOOK_SCRIPTS = {
  protect: path.join(SCRIPTS_DIR, 'protect-originals.mjs'),
  anonymize: path.join(SCRIPTS_DIR, 'anonymize-read.mjs'),
  deanonymize: path.join(SCRIPTS_DIR, 'deanonymize-write.mjs'),
  commit: path.join(SCRIPTS_DIR, 'commit-track.mjs'),
  billing: path.join(SCRIPTS_DIR, 'billing-track.mjs'),
};

/** Run one hook script exactly like Claude Code would: JSON payload on stdin, JSON (or nothing) on stdout, exit 0 expected. */
function runHookSelfTest(label, scriptPath, payload) {
  if (!fs.existsSync(scriptPath)) {
    return { label, ok: false, note: `script manquant : ${scriptPath}` };
  }

  const result = runCapture('node', [scriptPath], {
    input: JSON.stringify(payload),
    cwd: REPO_ROOT,
    timeout: 15000,
  });

  if (result.error) {
    return { label, ok: false, note: `échec du lancement : ${result.error.message}` };
  }
  if (result.code !== 0) {
    return { label, ok: false, note: `code de sortie ${result.code}${result.stderr ? ` — ${result.stderr}` : ''}` };
  }
  if (result.stdout) {
    try {
      JSON.parse(result.stdout);
    } catch {
      return { label, ok: false, note: 'sortie stdout non-JSON — contrat de hook invalide' };
    }
  }
  return { label, ok: true, note: result.stdout ? 'sortie JSON valide' : 'exit 0 (aucune sortie)' };
}

export async function install(ctx) {
  const workspacePath = ctx.config?.workspacePath;

  log.step('Répertoires de facturation...');
  if (!ctx.dryRun) {
    ensureDir(BILLING_DIR);
    ensureDir(SYNTHESE_DIR);
  }
  log.ok(`${BILLING_DIR}`);

  // `enabled: false` est la seule sortie de secours : les hooks se taisent
  // alors complètement, et l'IA voit les documents en clair.
  const anonymizationConfig = {
    enabled: true,
    watchPaths: workspacePath ? [workspacePath] : [],
  };

  if (ctx.dryRun) {
    log.info('[simulation] configuration anonymisation/facturation non écrite');
  } else {
    updateConfig({
      anonymization: anonymizationConfig,
      commits: { enabled: true, timeoutMs: 8000 },
      billing: { enabled: true },
    });
    log.ok('Configuration écrite dans ~/.piecemaker/config.json (anonymization, commits, billing)');
  }

  if (ctx.dryRun) {
    return { status: 'skipped', note: 'Mode simulation — hooks non vérifiés.' };
  }

  const spin = spinner('Vérification des hooks (payload synthétique sur stdin)...');
  const testResults = [];
  let testDir = null;

  try {
    // Un vrai dossier juridique factice, sans point de tête : les hooks
    // ignorent les répertoires cachés, un bac de test caché ne prouverait donc
    // rien du garde-fou.
    testDir = path.join(workspacePath || REPO_ROOT, 'piecemaker-hook-selftest');
    ensureDir(testDir);
    fs.writeFileSync(path.join(testDir, 'piece-selftest.pdf'), 'PIECE DE TEST', 'utf8');

    // 1. protect-originals.mjs — une pièce du bac de test : protégée par
    //    défaut, donc la réponse de blocage doit être produite et bien formée.
    const protectedResult = runHookSelfTest('protect-originals.mjs', HOOK_SCRIPTS.protect, {
      hook_event_name: 'PreToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: path.join(testDir, 'piece-selftest.pdf') },
      tool_use_id: 'toolu_installer_originals_selftest',
    });
    testResults.push(protectedResult);

    // 2. anonymize-read.mjs — hors dossier juridique : prouve le chemin rapide
    //    (aucun mapping à résoudre, donc aucune réécriture) sans dépendre d'un
    //    dossier réel du cabinet.
    const readResult = runHookSelfTest('anonymize-read.mjs', HOOK_SCRIPTS.anonymize, {
      hook_event_name: 'PostToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: path.join(REPO_ROOT, 'README.md') },
      tool_response: { file: { content: 'Vérification d\'installation PieceMaker.' } },
      tool_use_id: 'toolu_installer_read_selftest',
    });
    testResults.push(readResult);

    // 3. deanonymize-write.mjs — même logique dans l'autre sens : un Write hors
    //    dossier ne doit produire aucune réécriture.
    const writeResult = runHookSelfTest('deanonymize-write.mjs', HOOK_SCRIPTS.deanonymize, {
      hook_event_name: 'PreToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Write',
      tool_input: { file_path: path.join(testDir, 'note-selftest.md'), content: 'PERSONNE_PHYSIQUE_01' },
      tool_use_id: 'toolu_installer_write_selftest',
    });
    testResults.push(writeResult);

    // 4. commit-track.mjs — réponse d'outil en échec : exerce le contrat
    //    d'entrée/sortie sans créer de vrai commit pendant l'installation.
    const commitResult = runHookSelfTest('commit-track.mjs', HOOK_SCRIPTS.commit, {
      hook_event_name: 'PostToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(REPO_ROOT, 'README.md') },
      tool_response: { success: false },
      tool_use_id: 'toolu_installer_commit_selftest',
    });
    testResults.push(commitResult);

    // 5. billing-track.mjs — une vraie charge utile Stop : ajoute une ligne
    //    (clairement identifiée) au registre du mois et écrit une synthèse,
    //    ce qui prouve le chemin d'écriture de bout en bout.
    const billingResult = runHookSelfTest('billing-track.mjs', HOOK_SCRIPTS.billing, {
      hook_event_name: 'Stop',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: path.join(testDir, 'transcript-selftest.jsonl'),
      permission_mode: 'default',
      last_assistant_message: 'Test d\'installation PieceMaker — vérification du hook de facturation.',
      stop_reason: 'end_turn',
    });
    testResults.push(billingResult);
  } finally {
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  }

  const allOk = testResults.every((r) => r.ok);
  if (allOk) spin.succeed('Hooks vérifiés — les cinq scripts répondent au contrat stdin/stdout');

  else spin.fail('Échec de vérification d\'au moins un hook');

  for (const r of testResults) {
    if (r.ok) log.ok(`${r.label} : ${r.note}`);
    else log.error(`${r.label} : ${r.note}`);
  }
  log.detail(`Une ligne de test a été ajoutée à ${path.join(BILLING_DIR, `${new Date().toISOString().slice(0, 7)}.jsonl`)} (session "installer-selftest") — supprimez-la si besoin.`);
  if (!fs.existsSync(HOOKS_JSON)) {
    log.warn(`hooks/hooks.json introuvable dans le plugin : ${HOOKS_JSON}`);
  }

  if (!allOk) {
    const failed = testResults.filter((r) => !r.ok).map((r) => r.label).join(', ');
    return { status: 'failed', note: `Échec de la vérification : ${failed}. Corrigez puis relancez cette étape.` };
  }
  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const scriptsExist = Object.values(HOOK_SCRIPTS).every((p) => fs.existsSync(p));
  const hooksJsonExists = fs.existsSync(HOOKS_JSON);
  const dirsExist = fs.existsSync(BILLING_DIR) && fs.existsSync(SYNTHESE_DIR);
  const cfg = ctx.config || {};
  const configOk = Boolean(cfg.anonymization && cfg.commits && cfg.billing);

  if (!scriptsExist || !hooksJsonExists) {
    return { status: 'failed', note: 'Fichiers du plugin manquants (scripts ou hooks.json) — réinstallez piecemaker-plugin/.' };
  }
  if (!dirsExist || !configOk) {
    return { status: 'partial', note: 'Scripts présents mais configuration ou répertoires de facturation incomplets — relancez cette étape.' };
  }
  return { status: 'done', note: '' };
}

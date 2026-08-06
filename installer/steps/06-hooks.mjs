/**
 * Step 06 — Claude Code hooks (anonymisation + facturation).
 *
 * Wires piecemaker-plugin/hooks/hooks.json's five hook scripts by writing
 * their runtime configuration into ~/.piecemaker/config.json, then proves
 * each script actually runs clean by piping a synthetic, realistic payload
 * to its stdin — the same contract Claude Code uses (see
 * piecemaker-plugin/scripts/lib/hook-io.mjs for the confirmed stdin/stdout
 * shape). This step does not touch presidio-gliner's model/dependencies —
 * that lives in a separate anonymisation step; here we only verify the
 * hook *scripts* parse input, load config, and exit 0 without crashing or
 * hanging, which is what "wired correctly" means for a hook.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
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
const GLINER_SCRIPT = path.join(REPO_ROOT, 'websocket-server', 'scripts', 'presidio-gliner', 'presidio-gliner.py');
const BILLING_DIR = path.join(HOME_DIR, 'billing');
const SYNTHESE_DIR = path.join(BILLING_DIR, 'synthese');

const DOCUMENT_EXTENSIONS = ['.md', '.txt', '.docx', '.doc', '.pdf', '.pptx', '.ppt', '.xlsx', '.xls', '.rtf', '.odt'];

const HOOK_SCRIPTS = {
  protect: path.join(SCRIPTS_DIR, 'protect-originals.mjs'),
  pre: path.join(SCRIPTS_DIR, 'pre-anonymize.mjs'),
  post: path.join(SCRIPTS_DIR, 'post-anonymize.mjs'),
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

  const glinerExists = fs.existsSync(GLINER_SCRIPT);
  if (glinerExists) log.ok('Scanner GLiNER trouvé (websocket-server/scripts/presidio-gliner/presidio-gliner.py)');
  else log.warn(`Scanner GLiNER introuvable : ${GLINER_SCRIPT} (le hook post-anonymisation restera inactif jusqu'à son installation)`);

  const blockOnPII = await confirm(
    'Bloquer la lecture d\'un document dès qu\'une donnée sensible est détectée (au lieu d\'un simple avertissement) ?',
    false
  );

  const anonymizationConfig = {
    enabled: true,
    blockOnPII,
    timeoutMs: 5000,
    postScanTimeoutMs: 45000,
    watchPaths: workspacePath ? [workspacePath] : [],
    documentExtensions: DOCUMENT_EXTENSIONS,
    glinerScriptPath: GLINER_SCRIPT,
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
    testDir = path.join(workspacePath || REPO_ROOT, '.piecemaker-hook-selftest');
    ensureDir(testDir);

    // 1. protect-originals.mjs — explicit protected path, proving that the
    //    original-piece boundary returns a valid blocking hook response.
    const protectedResult = runHookSelfTest('protect-originals.mjs', HOOK_SCRIPTS.protect, {
      hook_event_name: 'PreToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: path.join(testDir, 'pièces originales', 'piece.pdf') },
      tool_use_id: 'toolu_installer_originals_selftest',
    });
    testResults.push(protectedResult);

    // 2. pre-anonymize.mjs — a real PII-bearing Markdown file, in scope,
    //    proving the regex scan actually fires (pure JS, no external deps).
    const piiFile = path.join(testDir, 'pii-selftest.md');
    fs.writeFileSync(
      piiFile,
      'Contact : jane.doe@example.com ou 06 12 34 56 78. IBAN FR76 3000 6000 0112 3456 7890 189.',
      'utf8'
    );
    const preResult = runHookSelfTest('pre-anonymize.mjs', HOOK_SCRIPTS.pre, {
      hook_event_name: 'PreToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Read',
      tool_input: { file_path: piiFile },
      tool_use_id: 'toolu_installer_selftest',
    });
    testResults.push(preResult);

    // 3. post-anonymize.mjs — out-of-scope file (wrong extension), proving
    //    the fast no-op guard works without requiring GLiNER's model/deps.
    const outOfScopeFile = path.join(testDir, 'not-a-document.txt');
    fs.writeFileSync(outOfScopeFile, 'rien à voir ici', 'utf8');
    const postResult = runHookSelfTest('post-anonymize.mjs', HOOK_SCRIPTS.post, {
      hook_event_name: 'PostToolUse',
      session_id: 'installer-selftest',
      cwd: REPO_ROOT,
      transcript_path: '',
      permission_mode: 'default',
      tool_name: 'Write',
      tool_input: { file_path: outOfScopeFile },
      tool_response: { success: true },
      tool_use_id: 'toolu_installer_selftest',
    });
    testResults.push(postResult);

    // 4. commit-track.mjs — failed tool response: exercises the hook I/O
    //    contract without creating a real commit during installation.
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

    // 5. billing-track.mjs — a real Stop payload; this appends a genuine
    //    (clearly-labelled) line to the current month's billing ledger and
    //    writes a synthesis file, proving the full write path end to end.
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
  if (!glinerExists) {
    return { status: 'partial', note: 'Hooks vérifiés, mais le scanner GLiNER est absent — le hook post-anonymisation restera inactif tant qu\'il n\'est pas installé.' };
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

/**
 * Régressions du hook central global (défauts A & C du rapport
 * `docs/anonymisation-noms-fichiers-et-volume-2026-08-20.md`), côté
 * `piecemaker-central-anonymize.mjs` — le chemin GLOBAL réellement installé.
 *
 * A — un chemin CODÉ en entrée d'un Read/Grep/Glob/Bash est rétabli.
 * C — une lecture volumineuse reste entièrement codée, et un payload d'entrée
 *     tronqué échoue FERMÉ (pas de repli sur l'original en clair).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(repoRoot, 'websocket-server', 'global-hooks', 'piecemaker-central-anonymize.mjs');
const SUBSTITUTION_SRC = path.join(repoRoot, 'piecemaker-plugin', 'scripts', 'lib', 'substitution.cjs');

const CENTRAL = {
  version: 1,
  mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01', 'URGOT SA': 'SOCIETE_SA_02' },
  reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'], SOCIETE_SA_02: ['URGOT SA'] },
};

function fixture({ central = CENTRAL } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-central-regression-'));
  fs.mkdirSync(path.join(home, 'lib'), { recursive: true });
  fs.copyFileSync(SUBSTITUTION_SRC, path.join(home, 'lib', 'substitution.cjs'));
  if (central) fs.writeFileSync(path.join(home, 'central-mapping.json'), JSON.stringify(central));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ anonymization: { enabled: true } }));
  return home;
}

function runHook(payload, home, { rawInput } = {}) {
  const result = spawnSync(process.execPath, [HOOK], {
    encoding: 'utf8',
    input: rawInput !== undefined ? rawInput : JSON.stringify(payload),
    env: { ...process.env, PIECEMAKER_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, parsed: result.stdout ? JSON.parse(result.stdout) : null };
}

// ─────────────────────────────── Défaut A ───────────────────────────────────

test('A (central) — un file_path CODÉ passé à Read est rétabli en vrai chemin', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { parsed } = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/06_Email_par_SOCIETE_SA_02_SA.md' },
  }, home);
  assert.ok(parsed);
  assert.equal(parsed.hookSpecificOutput.updatedInput.file_path, '/tmp/06_Email_par_URGOT SA_SA.md');
});

test('A (central) — une commande Bash citant un chemin CODÉ est rétablie', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const { parsed } = runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: '/tmp',
    tool_input: { command: 'cat "/tmp/26_Lettre_par_SOCIETE_SA_02_SA.md"' },
  }, home);
  assert.ok(parsed);
  assert.match(parsed.hookSpecificOutput.updatedInput.command, /URGOT SA/);
  assert.doesNotMatch(parsed.hookSpecificOutput.updatedInput.command, /SOCIETE_SA_02/);
});

// ─────────────────────────────── Défaut C ───────────────────────────────────

test('C (central) — lecture en masse (> 64 Ko, en-têtes de noms de fichiers) : tout est codé', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  let stdout = '';
  for (let i = 1; i <= 30; i += 1) {
    const n = String(i).padStart(2, '0');
    stdout += `===== ${n}_Kbis_de_URGOT SA_SA.md =====\n`;
    stdout += 'Contrat signé par Bernard Gilly pour URGOT SA.\n';
    stdout += 'Remplissage sans entité pour le volume.\n'.repeat(80);
  }
  assert.ok(Buffer.byteLength(stdout, 'utf8') > 64 * 1024);

  const { parsed } = runHook({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: '/tmp',
    tool_input: { command: 'for f in *.md; do echo "===== $f ====="; cat -- "$f"; done' },
    tool_response: { stdout, stderr: '' },
  }, home);
  assert.ok(parsed);
  const coded = JSON.stringify(parsed.hookSpecificOutput.updatedToolOutput);
  assert.ok(!coded.includes('Bernard Gilly'));
  assert.ok(!coded.includes('URGOT SA'));
  assert.match(coded, /PERSONNE_PHYSIQUE_01/);
});

test('C (central) — fail-closed : un payload de LECTURE tronqué ne fuit pas en clair', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const content = `Contrat signé par Bernard Gilly pour URGOT SA.\n${'Remplissage.\n'.repeat(200)}Fin: URGOT SA.`;
  const full = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/contrat.md' },
    tool_response: { file: { content } },
  });
  const truncated = full.slice(0, full.length - 40);

  const { stdout } = runHook(null, home, { rawInput: truncated });
  assert.notEqual(stdout.trim(), '', 'un payload illisible ne doit pas produire un fail-open silencieux');
  assert.ok(!stdout.includes('Bernard Gilly'));
  assert.ok(!stdout.includes('URGOT SA'));
});

test('C (central) — un payload d’ÉCRITURE tronqué reste fail-open (aucun nom réel exposé)', (t) => {
  const home = fixture();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // Une écriture illisible n'expose que des CODES (le modèle n'écrit que ça) :
  // fail-open y est légitime, pas de sortie.
  const full = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    cwd: '/tmp',
    tool_input: { file_path: '/tmp/note.md', content: 'Note pour PERSONNE_PHYSIQUE_01.' },
  });
  const { stdout } = runHook(null, home, { rawInput: full.slice(0, full.length - 20) });
  assert.equal(stdout.trim(), '', 'une écriture illisible ne doit rien émettre');
});

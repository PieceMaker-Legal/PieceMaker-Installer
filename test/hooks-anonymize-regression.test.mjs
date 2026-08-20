/**
 * Régressions issues de `docs/anonymisation-noms-fichiers-et-volume-2026-08-20.md`.
 *
 * Trois défauts observés en session sur le dossier « REAL TEST » :
 *   A — un chemin CODÉ passé en entrée d'un Read/Grep/Glob/Bash n'est pas
 *       ramené au vrai chemin, donc « file does not exist ».
 *   C — une lecture volumineuse (multi-fichiers concaténés, > 64 Ko) ou un
 *       payload d'entrée tronqué laisse des noms réels parvenir au modèle :
 *       la frontière RGPD ne doit JAMAIS dépendre de la taille du flux, et un
 *       payload illisible doit échouer FERMÉ (pas de repli sur l'original clair).
 *
 * (Le défaut B — l'aperçu client d'un Write/Edit affiche les vrais noms — est
 *  couvert à part : voir la note dans le rapport et le test dédié s'il existe.)
 *
 * Ces tests pilotent directement les scripts de hook du plugin, comme le fait
 * Claude Code : une charge utile JSON sur stdin, la sortie JSON sur stdout.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'piecemaker-plugin', 'scripts');
const ANONYMIZE = path.join(scripts, 'anonymize-read.mjs');
const DEANONYMIZE = path.join(scripts, 'deanonymize-write.mjs');

// Entités RÉELLES (côté cabinet) → CODES (seuls vus par le modèle).
const MAPPING = {
  mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01', 'URGOT SA': 'SOCIETE_SA_02' },
  reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'], SOCIETE_SA_02: ['URGOT SA'] },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-regression-'));
  const home = path.join(root, 'home');
  const caseRoot = path.join(root, 'PieceMaker', 'Dossier Alpha', 'Fichiers convertis PieceMaker');
  fs.mkdirSync(path.join(home, '.piecemaker'), { recursive: true });
  fs.mkdirSync(caseRoot, { recursive: true });
  // caseFolders pointe sur le dossier juridique (le parent du sous-dossier de conversion).
  const legalRoot = path.dirname(caseRoot);
  fs.writeFileSync(path.join(home, '.piecemaker', 'config.json'), JSON.stringify({ caseFolders: [legalRoot] }));
  fs.writeFileSync(path.join(legalRoot, 'mapping_dossier.json'), JSON.stringify(MAPPING));
  return { root, home, legalRoot, caseRoot };
}

/** Lance un hook comme Claude Code : payload JSON sur stdin, JSON sur stdout. */
function runHook(script, payload, data, { rawInput } = {}) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: rawInput !== undefined ? rawInput : JSON.stringify(payload),
    env: { ...process.env, HOME: data.home },
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, parsed: result.stdout ? JSON.parse(result.stdout) : null };
}

// ─────────────────────────────── Défaut A ───────────────────────────────────

test('A — un file_path CODÉ passé à Read est ramené au vrai chemin sur disque', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Le vrai fichier sur disque porte l'entité réelle dans son nom.
  const realName = '06_Email_explication_du_retard_par_URGOT SA_SA.md';
  const codedName = '06_Email_explication_du_retard_par_SOCIETE_SA_02_SA.md';
  fs.writeFileSync(path.join(data.caseRoot, realName), 'Corps de la pièce.\n');

  // Le modèle a vu le nom CODÉ dans un listing et fait Read dessus.
  const { parsed } = runHook(DEANONYMIZE, {
    tool_name: 'Read',
    cwd: data.legalRoot,
    tool_input: { file_path: path.join(data.caseRoot, codedName) },
  }, data);

  assert.ok(parsed, 'le hook doit réécrire le chemin codé');
  assert.equal(parsed.hookSpecificOutput.updatedInput.file_path, path.join(data.caseRoot, realName));
  assert.ok(fs.existsSync(parsed.hookSpecificOutput.updatedInput.file_path), 'le chemin rétabli doit exister');
});

test('A — un path CODÉ de Grep/Glob est rétabli', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const { parsed } = runHook(DEANONYMIZE, {
    tool_name: 'Grep',
    cwd: data.legalRoot,
    tool_input: { pattern: 'retard', path: path.join(data.caseRoot, '08_Note_SOCIETE_SA_02.md') },
  }, data);
  assert.ok(parsed);
  assert.equal(parsed.hookSpecificOutput.updatedInput.path, path.join(data.caseRoot, '08_Note_URGOT SA.md'));
});

test('A — une commande Bash citant un chemin CODÉ est rétablie', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const codedPath = path.join(data.caseRoot, '26_Lettre_par_SOCIETE_SA_02_SA.md');
  const { parsed } = runHook(DEANONYMIZE, {
    tool_name: 'Bash',
    cwd: data.legalRoot,
    tool_input: { command: `cat ${JSON.stringify(codedPath)}` },
  }, data);
  assert.ok(parsed);
  assert.match(parsed.hookSpecificOutput.updatedInput.command, /URGOT SA/);
  assert.doesNotMatch(parsed.hookSpecificOutput.updatedInput.command, /SOCIETE_SA_02/);
});

// ─────────────────────────────── Défaut C ───────────────────────────────────

test('C — lecture en masse (multi-fichiers concaténés, > 64 Ko) : en-têtes ET corps codés', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Reproduit `for f in *.md; do echo "===== $f ====="; cat "$f"; done` : les
  // NOMS DE FICHIERS dans les en-têtes portent l'entité, comme les corps.
  let stdout = '';
  for (let i = 1; i <= 30; i += 1) {
    const n = String(i).padStart(2, '0');
    stdout += `===== ${n}_Kbis_de_URGOT SA_SA.md =====\n`;
    stdout += 'Contrat signé par Bernard Gilly pour URGOT SA.\n';
    stdout += 'Paragraphe de remplissage sans entité, répété pour le volume.\n'.repeat(80);
    stdout += '\n';
  }
  assert.ok(Buffer.byteLength(stdout, 'utf8') > 64 * 1024, 'le flux doit dépasser 64 Ko');

  const { parsed } = runHook(ANONYMIZE, {
    tool_name: 'Bash',
    cwd: data.legalRoot,
    tool_input: { command: 'for f in *.md; do echo "===== $f ====="; cat -- "$f"; done' },
    tool_response: { stdout, stderr: '' },
  }, data);

  assert.ok(parsed, 'le hook doit renvoyer une sortie codée');
  const coded = JSON.stringify(parsed.hookSpecificOutput.updatedToolOutput);
  assert.ok(!coded.includes('Bernard Gilly'), 'aucun nom de personne ne doit survivre');
  assert.ok(!coded.includes('URGOT SA'), 'aucune société (corps NI en-tête de nom de fichier) ne doit survivre');
  assert.match(coded, /PERSONNE_PHYSIQUE_01/);
  assert.match(coded, /SOCIETE_SA_02/);
});

test('C — fail-closed : un payload d’entrée tronqué ne retombe PAS sur l’original en clair', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Payload d'un Read PostToolUse, valide puis COUPÉ en fin (troncature de tube).
  const content = `Contrat signé par Bernard Gilly pour URGOT SA.\n${'Remplissage.\n'.repeat(200)}Fin: URGOT SA.`;
  const full = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    cwd: data.legalRoot,
    tool_input: { file_path: path.join(data.caseRoot, 'contrat.md') },
    tool_response: { file: { content } },
  });
  const truncated = full.slice(0, full.length - 40); // JSON désormais inparseable

  const { stdout } = runHook(ANONYMIZE, null, data, { rawInput: truncated });

  // Fail-OPEN interdit : sortie 0 + stdout vide ferait retomber le harnais sur
  // le résultat d'outil ORIGINAL, en clair. Le hook doit émettre quelque chose,
  // et ce quelque chose ne doit contenir AUCUN nom réel.
  assert.notEqual(stdout.trim(), '', 'un payload illisible ne doit pas produire un fail-open silencieux');
  assert.ok(!stdout.includes('Bernard Gilly'), 'aucun nom de personne ne doit fuiter via un payload tronqué');
  assert.ok(!stdout.includes('URGOT SA'), 'aucune société ne doit fuiter via un payload tronqué');
});

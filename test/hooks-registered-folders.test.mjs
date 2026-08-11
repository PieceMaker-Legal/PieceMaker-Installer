import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'piecemaker-plugin', 'scripts');

function runHook(script, payload, home) {
  const result = spawnSync(process.execPath, [path.join(scripts, script)], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('les hooks PieceMaker couvrent un dossier enregistré hors de la racine historique', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-registered-hook-'));
  const home = path.join(root, 'home');
  const legalCase = path.join(root, 'clients', 'Martin');
  fs.mkdirSync(path.join(home, '.piecemaker'), { recursive: true });
  fs.mkdirSync(legalCase, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(home, '.piecemaker', 'config.json'), JSON.stringify({ caseFolders: [legalCase] }));
  fs.writeFileSync(path.join(legalCase, 'contrat.pdf'), 'ORIGINAL SECRET');
  fs.writeFileSync(path.join(legalCase, 'contrat.md'), 'Contrat signé par Bernard Gilly.');
  fs.writeFileSync(path.join(legalCase, 'mapping_dossier.json'), JSON.stringify({
    mapping: { 'Bernard Gilly': 'PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Bernard Gilly'] },
  }));

  const denied = runHook('protect-originals.mjs', {
    tool_name: 'Read',
    cwd: legalCase,
    tool_input: { file_path: path.join(legalCase, 'contrat.pdf') },
  }, home);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');

  const anonymized = runHook('anonymize-read.mjs', {
    tool_name: 'Read',
    cwd: legalCase,
    tool_input: { file_path: path.join(legalCase, 'contrat.md') },
    tool_response: { content: 'Contrat signé par Bernard Gilly.' },
  }, home);
  assert.deepEqual(anonymized.hookSpecificOutput.updatedToolOutput, { content: 'Contrat signé par PERSONNE_PHYSIQUE_01.' });

  const restored = runHook('deanonymize-write.mjs', {
    tool_name: 'Write',
    cwd: legalCase,
    tool_input: {
      file_path: path.join(legalCase, 'projet.md'),
      content: 'Pour PERSONNE_PHYSIQUE_01.',
    },
  }, home);
  assert.equal(restored.hookSpecificOutput.updatedInput.content, 'Pour Bernard Gilly.');
});

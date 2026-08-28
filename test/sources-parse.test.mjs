import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVES = [/(^|\/)node_modules\//, /(^|\/)admin\.backup-/, /(^|\/)_mxc_hooktest\//];

function sourcesSuivies() {
  const sortie = execFileSync('git', ['ls-files', '*.mjs', '*.cjs', '*.js'], {
    cwd: RACINE,
    encoding: 'utf8',
  });
  return sortie.split('\n').filter((f) => f && !ARCHIVES.some((motif) => motif.test(f)));
}

// Régression : des apostrophes typographiques (‘ ’) utilisées comme délimiteurs
// de chaîne ont déjà cassé deux fois le parsing de litellm-proxy.mjs.
test('toutes les sources JS suivies sont analysables par Node', () => {
  const fichiers = sourcesSuivies();
  assert.ok(fichiers.length > 0, 'aucune source JS trouvée');

  const cassees = [];
  for (const fichier of fichiers) {
    try {
      execFileSync(process.execPath, ['--check', path.join(RACINE, fichier)], { stdio: 'pipe' });
    } catch (error) {
      const detail = String(error.stderr || error.message).split('\n').find((l) => l.includes('Error')) || '';
      cassees.push(`${fichier} — ${detail.trim()}`);
    }
  }

  assert.deepEqual(cassees, [], `sources non analysables :\n${cassees.join('\n')}`);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  blocklistTargetPath,
  denyRuleFor,
  hookAssetPath,
  hookCommand,
  hookTargetPath,
  installHookScript,
  mergeSettings,
  seedBlocklist,
  settingsPath,
} from '../installer/lib/secrets-guard.mjs';

/**
 * Unit tests for the merge logic behind the global secret-file guard (see
 * installer/lib/secrets-guard.mjs and installer/steps/13-garde-secrets.mjs).
 * Fully hermetic: repoRoot and userHome are both temp directories with a
 * synthetic hook/template — the real repo assets and the real ~/.claude are
 * never touched here (see secrets-guard-step.test.mjs for that end-to-end
 * check against the actual versioned assets).
 */

function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-secrets-guard-'));
  const repoRoot = path.join(root, 'repo');
  const userHome = path.join(root, 'home');
  fs.mkdirSync(path.join(repoRoot, 'installer', 'assets', 'claude-hooks'), { recursive: true });
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(hookAssetPath(repoRoot), '// hook v1\n');
  fs.writeFileSync(
    path.join(repoRoot, 'installer', 'assets', 'claude-hooks', 'piecemaker-secret-paths.default.json'),
    '[]\n',
  );
  return { root, repoRoot, userHome };
}

test('installHookScript copie le hook et devient un no-op idempotent', (t) => {
  const { root, repoRoot, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = installHookScript({ repoRoot, userHome });
  assert.equal(first.changed, true);
  assert.equal(first.created, true);
  assert.equal(fs.readFileSync(hookTargetPath(userHome), 'utf8'), '// hook v1\n');

  const second = installHookScript({ repoRoot, userHome });
  assert.equal(second.changed, false, 'rien à refaire une fois convergé');

  fs.writeFileSync(hookAssetPath(repoRoot), '// hook v2\n');
  const third = installHookScript({ repoRoot, userHome });
  assert.equal(third.changed, true);
  assert.equal(third.created, false, 'mise à jour, pas une création');
  assert.equal(fs.readFileSync(hookTargetPath(userHome), 'utf8'), '// hook v2\n');
});

test('seedBlocklist crée le fichier depuis le gabarit puis n’ajoute qu’une fois', (t) => {
  const { root, repoRoot, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, 'server', '.env');

  const first = seedBlocklist({ repoRoot, userHome, envPaths: [envPath] });
  assert.equal(first.created, true);
  assert.deepEqual(first.added, [envPath]);
  assert.deepEqual(JSON.parse(fs.readFileSync(blocklistTargetPath(userHome), 'utf8')), [envPath]);

  const second = seedBlocklist({ repoRoot, userHome, envPaths: [envPath] });
  assert.equal(second.created, false);
  assert.deepEqual(second.added, [], 'pas de doublon au second passage');
  assert.deepEqual(JSON.parse(fs.readFileSync(blocklistTargetPath(userHome), 'utf8')), [envPath]);
});

test('seedBlocklist préserve les entrées ajoutées à la main', (t) => {
  const { root, repoRoot, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(blocklistTargetPath(userHome)), { recursive: true });
  fs.writeFileSync(blocklistTargetPath(userHome), `${JSON.stringify(['/tmp/perso/.env'], null, 2)}\n`);

  const envPath = path.join(root, 'server', '.env');
  const result = seedBlocklist({ repoRoot, userHome, envPaths: [envPath] });
  assert.equal(result.created, false);
  const list = JSON.parse(fs.readFileSync(blocklistTargetPath(userHome), 'utf8'));
  assert.deepEqual(list, ['/tmp/perso/.env', envPath]);
});

test('mergeSettings crée settings.json avec le hook et la règle deny', (t) => {
  const { root, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, 'server', '.env');

  const result = mergeSettings({ userHome, envPaths: [envPath] });
  assert.equal(result.created, true);
  assert.equal(result.hookAdded, true);
  assert.deepEqual(result.denyAdded, [denyRuleFor(envPath)]);

  const settings = JSON.parse(fs.readFileSync(settingsPath(userHome), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, hookCommand());
  assert.deepEqual(settings.permissions.deny, [denyRuleFor(envPath)]);
});

test('mergeSettings est idempotent — pas de doublon au second passage', (t) => {
  const { root, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, 'server', '.env');

  mergeSettings({ userHome, envPaths: [envPath] });
  const second = mergeSettings({ userHome, envPaths: [envPath] });
  assert.equal(second.hookAdded, false);
  assert.deepEqual(second.denyAdded, []);

  const settings = JSON.parse(fs.readFileSync(settingsPath(userHome), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.permissions.deny.length, 1);
});

test('mergeSettings préserve le reste de settings.json (model, autres hooks, enabledPlugins, deny existants)', (t) => {
  const { root, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  const existing = {
    permissions: { defaultMode: 'auto', deny: ['Read(//tmp/autre/.env)'] },
    model: 'claude-opus-4-8',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/filter-test-output.sh' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node "/some/other/report.mjs"' }] }],
    },
    enabledPlugins: { 'piecemaker@piecemaker': true },
  };
  fs.writeFileSync(settingsPath(userHome), `${JSON.stringify(existing, null, 2)}\n`);

  const envPath = path.join(root, 'server', '.env');
  const result = mergeSettings({ userHome, envPaths: [envPath] });
  assert.equal(result.created, false);
  assert.equal(result.hookAdded, true);

  const settings = JSON.parse(fs.readFileSync(settingsPath(userHome), 'utf8'));
  assert.equal(settings.model, 'claude-opus-4-8');
  assert.deepEqual(settings.enabledPlugins, { 'piecemaker@piecemaker': true });
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node "/some/other/report.mjs"');
  assert.equal(settings.hooks.PreToolUse.length, 2, 'le matcher Bash existant est conservé, le garde est ajouté à côté');
  assert.ok(settings.hooks.PreToolUse.some((g) => g.matcher === 'Bash'));
  assert.ok(settings.hooks.PreToolUse.some((g) => g.hooks.some((h) => h.command.includes('piecemaker-guard-secrets.mjs'))));
  assert.deepEqual(
    settings.permissions.deny,
    ['Read(//tmp/autre/.env)', denyRuleFor(envPath)],
    'règle deny existante conservée, la nouvelle ajoutée',
  );
});

test('mergeSettings reconnaît une entrée hook écrite à la main et ne duplique pas', (t) => {
  const { root, userHome } = scenario();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  const handWritten = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Bash',
          hooks: [{ type: 'command', command: `node "${path.join(userHome, '.claude', 'hooks', 'piecemaker-guard-secrets.mjs')}"` }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath(userHome), `${JSON.stringify(handWritten, null, 2)}\n`);

  const result = mergeSettings({ userHome, envPaths: [path.join(root, '.env')] });
  assert.equal(result.hookAdded, false, 'la commande différait (chemin absolu, guillemets) mais le basename du script suffit à la reconnaître');
  const settings = JSON.parse(fs.readFileSync(settingsPath(userHome), 'utf8'));
  assert.equal(settings.hooks.PreToolUse.length, 1, 'pas de doublon avec une entrée écrite à la main');
});

test('denyRuleFor produit le format Read(//abs/path)', () => {
  assert.equal(denyRuleFor('/Users/x/PieceMaker/.env'), 'Read(//Users/x/PieceMaker/.env)');
});

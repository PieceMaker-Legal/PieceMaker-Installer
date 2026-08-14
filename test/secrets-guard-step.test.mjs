import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, install, meta } from '../installer/steps/13-garde-secrets.mjs';
import { blocklistTargetPath, hookTargetPath, settingsPath } from '../installer/lib/secrets-guard.mjs';

/**
 * End-to-end tests for installer step 13 against the REAL versioned assets
 * (installer/assets/claude-hooks/…), but against a fake $HOME so nothing
 * here ever touches the developer's actual ~/.claude. See
 * test/secrets-guard.test.mjs for the hermetic unit tests of the merge
 * logic itself (installer/lib/secrets-guard.mjs).
 */

async function withTempHome(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-secrets-guard-step-'));
  const previousHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    await run(tmp);
  } finally {
    process.env.HOME = previousHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('meta est correctement déclarée', () => {
  assert.equal(meta.id, '13-garde-secrets');
  assert.ok(meta.label);
  assert.ok(meta.description);
});

test('install() installe le hook, seed la liste noire et câble settings.json — check() rapporte alors "done"', async () => {
  await withTempHome(async (tmp) => {
    const result = await install({ dryRun: false });
    assert.equal(result.status, 'done');

    assert.ok(fs.existsSync(hookTargetPath(tmp)), 'hook copié dans ~/.claude/hooks');
    assert.ok(
      fs.readFileSync(hookTargetPath(tmp), 'utf8').includes('PreToolUse hook'),
      'le hook installé est bien la copie versionnée (pas un stub de test)',
    );

    const blocklist = JSON.parse(fs.readFileSync(blocklistTargetPath(tmp), 'utf8'));
    assert.ok(Array.isArray(blocklist) && blocklist.length >= 1, 'la liste noire est seedée');

    const settings = JSON.parse(fs.readFileSync(settingsPath(tmp), 'utf8'));
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.permissions.deny.length, 1);

    const status = await check({});
    assert.equal(status.status, 'done');
  });
});

test('une seconde exécution est idempotente — aucun doublon dans settings.json ni dans la liste noire', async () => {
  await withTempHome(async (tmp) => {
    await install({ dryRun: false });
    const before = fs.readFileSync(settingsPath(tmp), 'utf8');
    await install({ dryRun: false });
    const after = fs.readFileSync(settingsPath(tmp), 'utf8');
    assert.equal(after, before, 'un second passage convergé ne réécrit même pas le fichier');

    const settings = JSON.parse(after);
    assert.equal(settings.hooks.PreToolUse.length, 1, 'pas de second groupe PreToolUse');
    assert.equal(settings.permissions.deny.length, 1, 'pas de règle deny dupliquée');

    const blocklist = JSON.parse(fs.readFileSync(blocklistTargetPath(tmp), 'utf8'));
    const resolved = blocklist.map((entry) => path.resolve(entry));
    assert.equal(new Set(resolved).size, resolved.length, 'aucune entrée en double dans la liste noire');
  });
});

test('install() préserve un settings.json préexistant (model, autre hook, enabledPlugins, deny existant)', async () => {
  await withTempHome(async (tmp) => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    const existing = {
      model: 'claude-opus-4-8',
      enabledPlugins: { 'telegram@claude-plugins-official': true },
      permissions: { defaultMode: 'auto', deny: ['Read(//tmp/autre-secret/.env)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/filter-test-output.sh' }] }],
      },
    };
    fs.writeFileSync(settingsPath(tmp), `${JSON.stringify(existing, null, 2)}\n`);

    await install({ dryRun: false });

    const settings = JSON.parse(fs.readFileSync(settingsPath(tmp), 'utf8'));
    assert.equal(settings.model, 'claude-opus-4-8');
    assert.deepEqual(settings.enabledPlugins, { 'telegram@claude-plugins-official': true });
    assert.equal(settings.hooks.PreToolUse.length, 2, 'le groupe Bash existant est conservé, le garde ajouté à côté');
    assert.ok(settings.hooks.PreToolUse.some((g) => g.matcher === 'Bash'));
    assert.ok(settings.permissions.deny.includes('Read(//tmp/autre-secret/.env)'), 'règle deny préexistante conservée');
  });
});

test('dry-run n’écrit rien', async () => {
  await withTempHome(async (tmp) => {
    const result = await install({ dryRun: true });
    assert.equal(result.status, 'skipped');
    assert.equal(fs.existsSync(hookTargetPath(tmp)), false);
    assert.equal(fs.existsSync(settingsPath(tmp)), false);
    assert.equal(fs.existsSync(blocklistTargetPath(tmp)), false);
  });
});

test('check() rapporte "failed" quand rien n’est installé', async () => {
  await withTempHome(async () => {
    const result = await check({});
    assert.equal(result.status, 'failed');
  });
});

test('check() rapporte "partial" quand seul le hook est copié à la main, sans le câblage settings.json', async () => {
  await withTempHome(async (tmp) => {
    fs.mkdirSync(path.dirname(hookTargetPath(tmp)), { recursive: true });
    fs.writeFileSync(hookTargetPath(tmp), '// hook copié à la main\n');
    const result = await check({});
    assert.equal(result.status, 'partial');
  });
});

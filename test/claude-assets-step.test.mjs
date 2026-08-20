import assert from 'node:assert/strict';
import test from 'node:test';

import { check, install } from '../installer/steps/09-claude-assets.mjs';

function dependencies(overrides = {}) {
  return {
    existsSync: () => true,
    commandExists: () => true,
    userHome: '/tmp/piecemaker-claude-test-home',
    repositoryAssets: () => [
      'piecemaker-plugin/agents/analyse.md',
      'piecemaker-plugin/skills/redaction/SKILL.md',
    ],
    syncClaudeAssets: () => ({ registered: 2, conflicts: [] }),
    installClaudeHooks: () => ({ ok: true, registered: 5, changed: false }),
    claudeHooksStatus: () => ({ ok: true }),
    claudeAssetStatus: () => ({ state: 'linked' }),
    depositRootClaudeMd: () => ({ status: 'kept' }),
    log: { info() {}, detail() {}, warn() {} },
    ...overrides,
  };
}

test('l’étape Claude enregistre directement skills et agents sans marketplace', async () => {
  const calls = [];
  let synced = false;
  const result = await install({ dryRun: false }, dependencies({
    commandExists(command, args) {
      calls.push([command, ...args]);
      return true;
    },
    syncClaudeAssets() {
      synced = true;
      return { registered: 2, conflicts: [] };
    },
  }));

  assert.equal(result.status, 'done');
  assert.equal(synced, true);
  assert.deepEqual(calls, [['claude', '--version']]);
});

test('l’étape Claude ne crée rien quand la CLI est absente', async () => {
  let synced = false;
  const result = await install({ dryRun: false }, dependencies({
    commandExists: () => false,
    syncClaudeAssets() { synced = true; return { registered: 2, conflicts: [] }; },
  }));

  assert.equal(result.status, 'skipped');
  assert.equal(synced, false);
});

test('le mode simulation Claude ne synchronise aucun fichier', async () => {
  let synced = false;
  let deposited = false;
  let hooksInstalled = false;
  const result = await install({ dryRun: true }, dependencies({
    syncClaudeAssets() { synced = true; return { registered: 2, conflicts: [] }; },
    installClaudeHooks() { hooksInstalled = true; return { ok: true, registered: 5 }; },
    depositRootClaudeMd() { deposited = true; return { status: 'deposited' }; },
  }));

  assert.equal(result.status, 'skipped');
  assert.equal(synced, false);
  assert.equal(deposited, false);
  assert.equal(hooksInstalled, false);
});

test('les composants personnels homonymes sont conservés et signalés', async () => {
  const result = await install({ dryRun: false }, dependencies({
    syncClaudeAssets: () => ({
      registered: 1,
      conflicts: [{ slug: 'redaction', state: 'conflict' }],
    }),
  }));

  assert.equal(result.status, 'partial');
  assert.match(result.note, /1 skill\(s\)\/agent\(s\)/);
});

test('le diagnostic Claude vérifie les liens directs et CLAUDE.md', async () => {
  const result = await check({}, dependencies({
    claudeAssetStatus(_repoRoot, _userHome, asset) {
      return { state: asset.includes('redaction') ? 'missing' : 'linked' };
    },
  }));

  assert.equal(result.status, 'partial');
  assert.match(result.note, /1 skill\(s\)\/agent\(s\)/);
});

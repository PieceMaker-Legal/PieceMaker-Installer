const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claudeHooksStatus,
  installClaudeHooks,
  settingsPath,
} = require('../websocket-server/claude-hooks.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-claude-hooks-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const hooks = path.join(repo, 'piecemaker-plugin', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'hooks.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/protect-originals.mjs"' }],
      }],
      Stop: [{
        matcher: '*',
        hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/billing-track.mjs"' }],
      }],
    },
  }, null, 2)}\n`);
  return { root, repo, home };
}

test('les hooks sont fusionnés directement dans settings.json sans manifest', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = settingsPath(data.home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    theme: 'dark',
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node personnel.mjs' }] }] },
  }, null, 2)}\n`);

  const first = installClaudeHooks(data.repo, data.home);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.registered, 2);
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.ok(JSON.stringify(settings).includes('node personnel.mjs'));
  assert.ok(JSON.stringify(settings).includes(path.join(data.repo, 'piecemaker-plugin', 'scripts', 'protect-originals.mjs')));
  assert.equal(claudeHooksStatus(data.repo, data.home).ok, true);
  assert.equal(fs.existsSync(path.join(data.repo, '.claude-plugin')), false);

  const second = installClaudeHooks(data.repo, data.home);
  assert.equal(second.changed, false);
});

test('un lien direct provenant d’un autre clone est mis à jour sans doublon', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = settingsPath(data.home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node "/ancien/piecemaker-plugin/scripts/protect-originals.mjs"' }],
      }],
    },
  }, null, 2)}\n`);

  const result = installClaudeHooks(data.repo, data.home);
  assert.equal(result.ok, true);
  const settings = JSON.parse(fs.readFileSync(target, 'utf8'));
  const serialized = JSON.stringify(settings);
  assert.doesNotMatch(serialized, /\/ancien\//);
  assert.equal(serialized.match(/protect-originals\.mjs/g)?.length, 1);
});

test('les anciens hooks de mapping et leur script global sont retirés', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = settingsPath(data.home);
  const globalHook = path.join(data.home, '.claude', 'hooks', 'piecemaker-central-anonymize.mjs');
  fs.mkdirSync(path.dirname(globalHook), { recursive: true });
  fs.writeFileSync(globalHook, 'ancien hook\n');
  fs.writeFileSync(target, `${JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node personnel.mjs' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node /ancien/deanonymize-write.mjs' }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/piecemaker-central-anonymize.mjs' }] },
      ],
      PostToolUse: [
        { matcher: 'Read', hooks: [{ type: 'command', command: 'node /ancien/anonymize-read.mjs' }] },
      ],
    },
  }, null, 2)}\n`);

  assert.equal(claudeHooksStatus(data.repo, data.home).ok, false);
  const result = installClaudeHooks(data.repo, data.home);
  assert.equal(result.ok, true);
  assert.equal(result.cleanup.removed, 3);
  assert.equal(result.cleanup.deletedFile, true);

  const serialized = fs.readFileSync(target, 'utf8');
  assert.doesNotMatch(serialized, /anonymize-read|deanonymize-write|piecemaker-central-anonymize/);
  assert.match(serialized, /personnel\.mjs/);
  assert.equal(fs.existsSync(globalHook), false);
  assert.equal(claudeHooksStatus(data.repo, data.home).ok, true);
});

test('un settings.json invalide n’est jamais écrasé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const target = settingsPath(data.home);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{ invalide');

  const result = installClaudeHooks(data.repo, data.home);
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(target, 'utf8'), '{ invalide');
});

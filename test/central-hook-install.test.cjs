const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// HOME hermétique AVANT de require le module (il fige les chemins ~/.claude).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-install-home-'));
process.env.HOME = TMP_HOME;
process.env.PIECEMAKER_HOME = path.join(TMP_HOME, '.piecemaker');

const {
  CLAUDE_SETTINGS,
  HOOK_TARGET,
  SECRET_PATHS_FILE,
  installHookFile,
  registerCentralAsSecret,
  wireSettings,
} = require('../websocket-server/central-hook-install.cjs');
const { CENTRAL_FILE } = require('../piecemaker-plugin/scripts/lib/central-mapping.cjs');

test('installHookFile copie le hook, exécutable', () => {
  const target = installHookFile();
  assert.equal(target, HOOK_TARGET);
  assert.ok(fs.existsSync(HOOK_TARGET));
  assert.equal(fs.statSync(HOOK_TARGET).mode & 0o111 ? true : false, true);
});

test('wireSettings ajoute les deux événements puis est idempotent', () => {
  // Un settings.json préexistant, avec un hook tiers à préserver.
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({
    model: 'claude-opus-4-8',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node autre.mjs' }] }] },
  }, null, 2));

  const first = wireSettings();
  assert.equal(first.wired, true);
  assert.equal(first.changed, true);

  const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  // Le hook tiers est préservé.
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'node autre.mjs');
  // Nos deux événements sont câblés.
  const post = JSON.stringify(settings.hooks.PostToolUse);
  const pre = JSON.stringify(settings.hooks.PreToolUse);
  assert.match(post, /piecemaker-central-anonymize\.mjs/);
  assert.match(post, /Write\|Edit/);
  assert.match(post, /open_doc\|read_doc\|edit_doc/);
  assert.match(pre, /piecemaker-central-anonymize\.mjs/);
  assert.match(pre, /Read\|Grep\|Glob/);
  assert.match(pre, /[Pp].*iece.*[Mm].*aker.*open_doc/);

  // Deuxième passage : rien ajouté.
  const second = wireSettings();
  assert.equal(second.changed, false);
  const after = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.equal(after.hooks.PreToolUse.length, 1);
});

test('wireSettings migre les anciens matchers du hook central', () => {
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: 'Read|Grep|Glob|Bash',
        hooks: [{ type: 'command', command: 'node ~/.claude/hooks/piecemaker-central-anonymize.mjs' }],
      }],
      PreToolUse: [{
        matcher: 'Write|Edit|mcp__.*telegram.*__(reply|edit_message)',
        hooks: [{ type: 'command', command: 'node ~/.claude/hooks/piecemaker-central-anonymize.mjs' }],
      }],
    },
  }, null, 2));

  const result = wireSettings();
  assert.equal(result.changed, true);
  const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  assert.equal(settings.hooks.PostToolUse.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PostToolUse[0].matcher, /Write\|Edit/);
  assert.match(settings.hooks.PostToolUse[0].matcher, /open_doc\|read_doc\|edit_doc/);
  assert.match(settings.hooks.PreToolUse[0].matcher, /Read\|Grep\|Glob/);
  assert.match(settings.hooks.PreToolUse[0].matcher, /open_doc/);
});

test('registerCentralAsSecret ajoute le fichier central, idempotent', () => {
  const first = registerCentralAsSecret();
  assert.equal(first.changed, true);
  const list = JSON.parse(fs.readFileSync(SECRET_PATHS_FILE, 'utf8'));
  assert.equal(list.includes(CENTRAL_FILE), true);

  const second = registerCentralAsSecret();
  assert.equal(second.changed, false);
  const after = JSON.parse(fs.readFileSync(SECRET_PATHS_FILE, 'utf8'));
  assert.equal(after.filter((entry) => entry === CENTRAL_FILE).length, 1);
});

test('wireSettings ne touche pas un settings.json illisible', () => {
  fs.writeFileSync(CLAUDE_SETTINGS, '{ this is not json');
  const result = wireSettings();
  assert.equal(result.wired, false);
  // Le fichier reste tel quel.
  assert.equal(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'), '{ this is not json');
});

test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

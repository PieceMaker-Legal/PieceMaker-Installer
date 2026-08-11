const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  getTelegramState,
  readToken,
  saveDossierBot,
  saveTelegramConfig,
  validateToken,
} = require('../websocket-server/telegram-admin.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-telegram-test-'));
  const repoRoot = path.join(root, 'repo');
  const userHome = path.join(root, 'user');
  const homeDir = path.join(userHome, '.piecemaker');
  fs.mkdirSync(path.join(repoRoot, 'orchestrator'), { recursive: true });
  return { root, repoRoot, userHome, homeDir };
}

test('les deux tokens Telegram sont enregistrés en 0600 mais jamais renvoyés', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const assistantToken = `123456:${'A'.repeat(30)}`;
  const monitorToken = `654321:${'B'.repeat(30)}`;
  const state = saveTelegramConfig(data, {
    assistantName: 'Mon Assistant',
    assistantToken,
    monitorName: 'La Vigie',
    monitorToken,
  });
  assert.equal(state.assistant.name, 'Mon Assistant');
  assert.equal(state.monitor.name, 'La Vigie');
  assert.equal(state.assistant.token.configured, true);
  assert.equal(JSON.stringify(state).includes(assistantToken), false);
  const assistantEnv = path.join(data.userHome, '.claude', 'channels', 'telegram-piecemaker', '.env');
  assert.equal(readToken(path.dirname(assistantEnv)), assistantToken);
  if (process.platform !== 'win32') assert.equal(fs.statSync(assistantEnv).mode & 0o777, 0o600);
});

test('un champ token vide conserve le secret et les tokens identiques sont refusés', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const assistantToken = `123456:${'A'.repeat(30)}`;
  const monitorToken = `654321:${'B'.repeat(30)}`;
  saveTelegramConfig(data, { assistantToken, monitorToken });
  saveTelegramConfig(data, { assistantName: 'Nouveau nom', assistantToken: '', monitorToken: '' });
  assert.equal(getTelegramState(data).assistant.name, 'Nouveau nom');
  const stateDir = path.join(data.userHome, '.claude', 'channels', 'telegram-piecemaker');
  assert.equal(readToken(stateDir), assistantToken);
  assert.throws(() => saveTelegramConfig(data, { monitorToken: assistantToken }), /tokens différents/);
  assert.throws(() => validateToken('pas-un-token'), /BotFather/);
});

test('un ancien token du bot de surveillance est migré sans être exposé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const legacy = path.join(data.userHome, '.claude', 'channels', 'telegram-lord');
  const token = `888888:${'D'.repeat(30)}`;
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`);
  fs.writeFileSync(path.join(legacy, 'access.json'), '{"allowFrom":["84"]}\n');
  const state = saveTelegramConfig(data, { monitorName: 'Vigie migrée' });
  const current = path.join(data.userHome, '.claude', 'channels', 'telegram-piecemaker-lord');
  assert.equal(readToken(current), token);
  assert.equal(state.monitor.token.hint, '••••DDDD');
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(current, 'access.json'), 'utf8')).allowFrom, ['84']);
});

test('chaque sous-dossier peut être lié et ne publie que des noms originaux filtrés par mapping', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const dossiersRoot = path.join(data.root, 'dossiers');
  const dossier = path.join(dossiersRoot, 'Dossier Martin');
  fs.mkdirSync(path.join(dossier, 'pièces originales'), { recursive: true });
  fs.mkdirSync(path.join(dossier, 'documents-convertis'), { recursive: true });
  fs.mkdirSync(path.join(dossiersRoot, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dossier, 'pièces originales', 'secret-original.pdf'), 'secret');
  fs.writeFileSync(path.join(dossier, 'pièces originales', 'Courrier Martin.docx'), 'secret');
  fs.writeFileSync(path.join(dossier, 'documents-convertis', 'piece-1.md'), '# Pièce convertie\n');
  fs.writeFileSync(path.join(dossier, 'mapping_dossier.json'), `${JSON.stringify({ mapping: { Martin: 'PERSONNE_01' } })}\n`);
  fs.mkdirSync(data.homeDir, { recursive: true });
  fs.writeFileSync(path.join(data.homeDir, 'config.json'), `${JSON.stringify({ caseFolders: [dossier] })}\n`);
  const generalState = path.join(data.userHome, '.claude', 'channels', 'telegram-piecemaker');
  fs.mkdirSync(generalState, { recursive: true });
  fs.writeFileSync(path.join(generalState, 'access.json'), '{"allowFrom":["42"]}\n');

  let state = getTelegramState(data);
  assert.equal(state.dossiers.length, 1);
  assert.equal(state.dossiers[0].directoryName, 'Dossier Martin');
  assert.equal(state.dossiers[0].mappingConfigured, true);
  assert.equal(state.dossiers[0].originalsProtected, true);
  assert.equal(state.dossiers[0].originalFiles, 2);
  assert.equal(state.dossiers[0].markdownFiles, 1);
  assert.equal(JSON.stringify(state).includes('secret-original.pdf'), false);
  assert.equal(JSON.stringify(state).includes('Courrier Martin.docx'), false);
  assert.deepEqual(state.dossiers[0].mappedOriginalNames, [
    'Courrier PERSONNE_01.docx',
    'Pièce originale 2.pdf',
  ]);

  const token = `777777:${'C'.repeat(30)}`;
  const linked = saveDossierBot(data, state.dossiers[0].id, { name: 'Assistant Martin', token });
  assert.equal(linked.linked, true);
  assert.equal(linked.name, 'Assistant Martin');
  const projectState = path.join(data.userHome, '.claude', 'channels', `telegram-${linked.id}`);
  assert.equal(readToken(projectState), token);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(projectState, 'access.json'), 'utf8')).allowFrom, ['42']);
  state = getTelegramState(data);
  assert.equal(state.dossiers[0].token.hint, '••••CCCC');
});

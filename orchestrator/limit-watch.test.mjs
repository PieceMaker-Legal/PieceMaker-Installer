// Tests de limit-watch.mjs — fixtures au FORMAT RÉEL observé dans
// ~/.claude/projects (89 événements de limite inspectés, rien deviné).
// Lancer : node --test  (depuis « 00 - Lord of the bots »)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ledger isolé AVANT import du module (LEDGER est capturé au chargement).
const TMP = mkdtempSync(join(tmpdir(), 'limitwatch-'));
process.env.LIMIT_LEDGER = join(TMP, 'ledger.json');

const {
  isLimitEntry, entryText, detectPausedLimit, readTail,
  alreadyAlerted, markAlerted, readLedger, checkLimits,
} = await import('./limit-watch.mjs');

// --- fabriques de lignes au format réel ------------------------------------
const assistant = (text, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  sessionId: 'sess-1', cwd: '/work/trading', ...extra,
});
const limitLine = (text = "You've hit your session limit · resets 7pm (Europe/Paris)", extra = {}) =>
  assistant(text, { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, ...extra });
const serverErr = () =>
  assistant('Overloaded', { isApiErrorMessage: true, error: 'server_error', apiErrorStatus: 500 });
const userLine = (text) => ({ type: 'user', message: { role: 'user', content: text }, cwd: '/work/trading', sessionId: 'sess-1' });
const jsonl = (arr) => arr.map((o) => JSON.stringify(o)).join('\n') + '\n';

// --- isLimitEntry -----------------------------------------------------------
test('isLimitEntry : 429/rate_limit → true', () => {
  assert.equal(isLimitEntry(limitLine()), true);
});
test('isLimitEntry : weekly limit → true', () => {
  assert.equal(isLimitEntry(limitLine("You've hit your weekly limit · resets Jul 25 at 7am (Europe/Paris)")), true);
});
test('isLimitEntry : 500 server_error → false (transitoire, pas une limite)', () => {
  assert.equal(isLimitEntry(serverErr()), false);
});
test('isLimitEntry : erreur auth → false', () => {
  assert.equal(isLimitEntry(assistant('bad key', { isApiErrorMessage: true, error: 'authentication_failed' })), false);
});
test('isLimitEntry : limite crédits Fable via texte → true', () => {
  const e = assistant("You've reached your Fable 5 limit. Run /usage-credits to continue or switch mode",
    { isApiErrorMessage: true, error: 'unknown' });
  assert.equal(isLimitEntry(e), true);
});
test('isLimitEntry : tour assistant normal → false', () => {
  assert.equal(isLimitEntry(assistant('bonjour')), false);
});

// --- entryText --------------------------------------------------------------
test('entryText : concatène les parts text', () => {
  assert.equal(entryText(limitLine('abc')), 'abc');
});

// --- detectPausedLimit ------------------------------------------------------
test('detectPausedLimit : limite en dernier tour assistant → active', () => {
  const t = jsonl([assistant('travail'), userLine('go'), limitLine()]);
  const r = detectPausedLimit(t);
  assert.equal(r.active, true);
  assert.match(r.text, /resets 7pm/);
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.cwd, '/work/trading');
});
test('detectPausedLimit : lignes user/system APRÈS la limite → toujours active', () => {
  const t = jsonl([limitLine(), userLine('encore ?'), { type: 'system', content: 'x' }]);
  assert.equal(detectPausedLimit(t).active, true);
});
test('detectPausedLimit : tour assistant normal APRÈS la limite → session reprise, inactive', () => {
  const t = jsonl([limitLine(), userLine('reprends'), assistant('je reprends')]);
  assert.equal(detectPausedLimit(t).active, false);
});
test('detectPausedLimit : aucune limite → inactive', () => {
  assert.equal(detectPausedLimit(jsonl([assistant('a'), assistant('b')])).active, false);
});
test('detectPausedLimit : 500 en dernier → inactive (pas une limite)', () => {
  assert.equal(detectPausedLimit(jsonl([assistant('a'), serverErr()])).active, false);
});

// --- readTail ---------------------------------------------------------------
test('readTail : gros fichier, dernière ligne préservée et parsable', () => {
  const p = join(TMP, 'big.jsonl');
  const filler = Array.from({ length: 5000 }, (_, i) => assistant('x'.repeat(200) + i));
  writeFileSync(p, jsonl([...filler, limitLine()]));
  const tail = readTail(p, 64 * 1024); // < taille fichier → coupe le début
  const r = detectPausedLimit(tail);
  assert.equal(r.active, true, 'la limite finale doit survivre à la troncature');
});

// --- ledger -----------------------------------------------------------------
test('ledger : markAlerted puis alreadyAlerted → true, texte différent → false', () => {
  markAlerted('sess-X', 'resets 9pm');
  assert.equal(alreadyAlerted(readLedger(), 'sess-X', 'resets 9pm'), true);
  assert.equal(alreadyAlerted(readLedger(), 'sess-X', 'resets 10pm'), false);
});

// --- checkLimits (bout-en-bout, root de projets temporaire) -----------------
test('checkLimits : alerte 1× par limite, mappée par cwd, gate isActive, dédupliquée', async () => {
  const root = join(TMP, 'projects');
  const dir = join(root, 'enc-trading');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, 's.jsonl'),
    jsonl([assistant('bosse', { cwd: '/work/trading', sessionId: 'sess-T' }),
           limitLine("You've hit your session limit · resets 3pm (Europe/Paris)",
             { cwd: '/work/trading', sessionId: 'sess-T' })]));

  const sent = [];
  const opts = {
    send: (p, txt) => sent.push([p, txt]),
    isActive: (p) => p === 'trading',
    workdirs: { trading: '/work/trading' },
    root, now,
  };

  const a1 = await checkLimits(opts);
  assert.equal(a1.length, 1);
  assert.equal(a1[0].project, 'trading');
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /limite atteinte/);
  assert.match(sent[0][1], /resets 3pm/);

  // 2e passage : même limite → dédupliquée, aucun nouvel envoi.
  const a2 = await checkLimits(opts);
  assert.equal(a2.length, 0);
  assert.equal(sent.length, 1);
});

test('checkLimits : projet inactif (isActive=false) → aucune alerte', async () => {
  const root = join(TMP, 'projects2');
  const dir = join(root, 'enc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'),
    jsonl([limitLine('resets 1am', { cwd: '/work/trading', sessionId: 'sess-Z' })]));
  const sent = [];
  const a = await checkLimits({
    send: (p, txt) => sent.push([p, txt]),
    isActive: () => false,
    workdirs: { trading: '/work/trading' },
    root, now: Date.now(),
  });
  assert.equal(a.length, 0);
  assert.equal(sent.length, 0);
});

test('checkLimits : cwd hors périmètre (pas une session Lord) → ignoré', async () => {
  const root = join(TMP, 'projects3');
  const dir = join(root, 'enc');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'),
    jsonl([limitLine('resets 2am', { cwd: '/some/other/repo', sessionId: 'sess-O' })]));
  const sent = [];
  const a = await checkLimits({
    send: (p, txt) => sent.push([p, txt]),
    isActive: () => true,
    workdirs: { trading: '/work/trading' },
    root, now: Date.now(),
  });
  assert.equal(a.length, 0);
});

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

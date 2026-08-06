/**
 * Interactive prompts built on node:readline — no dependencies.
 *
 * Every prompt honours PIECEMAKER_YES=1 (accept defaults, never block), which
 * is what the non-interactive install path and CI use.
 */

import readline from 'node:readline';
import { c, write, blank } from './ui.mjs';

const AUTO = process.env.PIECEMAKER_YES === '1' || !process.stdin.isTTY;

export const nonInteractive = AUTO;

function createInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

/** Free-text question with an optional default. */
export async function ask(question, { def = '', required = false } = {}) {
  if (AUTO) return def;
  const suffix = def ? c.gray(` [${def}]`) : '';
  for (;;) {
    const rl = createInterface();
    const answer = await new Promise((resolve) =>
      rl.question(`  ${c.cyan('?')} ${question}${suffix} `, (a) => {
        rl.close();
        resolve(a.trim());
      })
    );
    const value = answer || def;
    if (value || !required) return value;
    write(`  ${c.yellow('!')} Une valeur est requise.`);
  }
}

/** Yes/no question. Default is applied on an empty answer. */
export async function confirm(question, def = true) {
  if (AUTO) return def;
  const hint = def ? 'O/n' : 'o/N';
  const rl = createInterface();
  const answer = await new Promise((resolve) =>
    rl.question(`  ${c.cyan('?')} ${question} ${c.gray(`[${hint}]`)} `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    })
  );
  if (!answer) return def;
  return answer === 'o' || answer === 'oui' || answer === 'y' || answer === 'yes';
}

/**
 * Secret input. Echo is suppressed on a TTY; on a non-TTY the value can only
 * come from the environment, which is the documented CI path.
 */
export async function secret(question) {
  if (AUTO) return '';
  return new Promise((resolve) => {
    const rl = createInterface();
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '') {
        process.stdin.removeListener('data', onData);
        return;
      }
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`  ${c.cyan('?')} ${question} `);
    };
    process.stdin.on('data', onData);
    rl.question(`  ${c.cyan('?')} ${question} `, (value) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      blank();
      resolve(value.trim());
    });
  });
}

/**
 * Single-choice menu.
 * `choices` is an array of { value, label, hint }. Returns the chosen value.
 */
export async function select(question, choices, { def = 0 } = {}) {
  if (AUTO) return choices[def].value;
  blank();
  write(`  ${c.bold(question)}`);
  blank();
  choices.forEach((choice, i) => {
    const num = c.cyan(String(i + 1).padStart(2));
    const hint = choice.hint ? c.gray(`  ${choice.hint}`) : '';
    write(`  ${num}. ${choice.label}${hint}`);
  });
  blank();
  for (;;) {
    const answer = await ask('Votre choix', { def: String(def + 1) });
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && index >= 0 && index < choices.length) {
      return choices[index].value;
    }
    write(`  ${c.yellow('!')} Choix invalide.`);
  }
}

/**
 * Multi-choice menu. Accepts "1,3,5", "1 3 5", "tout" or "aucun".
 * Returns an array of values.
 */
export async function multiSelect(question, choices, { def = [] } = {}) {
  if (AUTO) return def;
  blank();
  write(`  ${c.bold(question)}`);
  write(`  ${c.gray('Numéros séparés par des virgules, "tout", ou Entrée pour la sélection par défaut.')}`);
  blank();
  choices.forEach((choice, i) => {
    const mark = def.includes(choice.value) ? c.green('•') : ' ';
    const num = c.cyan(String(i + 1).padStart(2));
    const hint = choice.hint ? c.gray(`  ${choice.hint}`) : '';
    write(`  ${mark} ${num}. ${choice.label}${hint}`);
  });
  blank();
  const answer = await ask('Votre sélection', { def: 'tout' });
  const normalized = answer.toLowerCase();
  if (normalized === 'tout' || normalized === 'all') return choices.map((ch) => ch.value);
  if (normalized === 'aucun' || normalized === 'none') return [];
  const picked = normalized
    .split(/[,\s]+/)
    .map((n) => Number.parseInt(n, 10) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < choices.length)
    .map((i) => choices[i].value);
  return picked.length ? picked : def;
}

/** Wait for Enter. No-op when non-interactive. */
export async function pause(message = 'Appuyez sur Entrée pour continuer') {
  if (AUTO) return;
  await ask(message);
}

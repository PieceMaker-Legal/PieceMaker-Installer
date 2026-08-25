/**
 * Terminal UI primitives — zero dependencies, ANSI only.
 *
 * Colour is disabled automatically when stdout is not a TTY, when NO_COLOR is
 * set, or when TERM is "dumb", so piping the installer into a log file yields
 * clean text.
 */

import { renderBanner } from './banner.mjs';

const COLOR_ENABLED =
  process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb';

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function wrap(code, text) {
  return COLOR_ENABLED ? `${CODES[code]}${text}${CODES.reset}` : String(text);
}

export const c = Object.fromEntries(
  Object.keys(CODES).map((k) => [k, (text) => wrap(k, text)])
);

/** Clickable OSC 8 link on compatible terminals; plain text everywhere else. */
export function link(label, url) {
  const text = String(label);
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return text;
  const safeUrl = String(url).replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]8;;${safeUrl}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function columns() {
  return process.stdout.columns || 80;
}

/** Visible width, ignoring ANSI escapes. */
export function visibleWidth(text) {
  return String(text)
    .replace(/\x1b]8;;[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .length;
}

export function write(text = '') {
  process.stdout.write(`${text}\n`);
}

export function blank() {
  write('');
}

/** Full-width horizontal rule. */
export function rule(char = '─') {
  write(c.gray(char.repeat(Math.min(columns(), 78))));
}

/** The PIECEMAKER banner plus a tagline. */
export function banner(subtitle = 'Installateur — anonymisation & assistance juridique') {
  blank();
  for (const line of renderBanner(columns())) write(c.white(line));
  blank();
  write(`  ${c.dim(subtitle)}`);
  blank();
}

export function title(text) {
  blank();
  write(c.bold(text));
  rule();
}

export const log = {
  info: (m) => write(`  ${c.blue('·')} ${m}`),
  step: (m) => write(`  ${c.cyan('▸')} ${m}`),
  ok: (m) => write(`  ${c.green('✓')} ${m}`),
  warn: (m) => write(`  ${c.yellow('!')} ${m}`),
  error: (m) => write(`  ${c.red('✗')} ${m}`),
  detail: (m) => write(`    ${c.gray(m)}`),
};

/**
 * Indeterminate spinner. Degrades to a single static line when stdout is not a
 * TTY, so CI logs do not fill with control characters.
 */
export function spinner(label) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let timer = null;
  let current = label;

  if (!process.stdout.isTTY) {
    write(`  · ${label}`);
    return {
      update: () => {},
      succeed: (m) => log.ok(m || current),
      fail: (m) => log.error(m || current),
      stop: () => {},
    };
  }

  const paint = () => {
    const frame = frames[(i = (i + 1) % frames.length)];
    process.stdout.write(`\r\x1b[2K  ${c.cyan(frame)} ${current}`);
  };
  timer = setInterval(paint, 80);
  paint();

  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
    process.stdout.write('\r\x1b[2K');
  };

  return {
    update: (m) => {
      current = m;
    },
    succeed: (m) => {
      clear();
      log.ok(m || current);
    },
    fail: (m) => {
      clear();
      log.error(m || current);
    },
    stop: clear,
  };
}

/** Render a summary table of [label, status] pairs. */
export function summary(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, status, note] of rows) {
    const padded = label.padEnd(width);
    write(`  ${padded}  ${status}${note ? `  ${c.gray(note)}` : ''}`);
  }
}

export const badge = {
  done: c.green('installé'),
  partial: c.yellow('partiel'),
  todo: c.gray('à faire'),
  failed: c.red('échec'),
  skipped: c.gray('ignoré'),
};

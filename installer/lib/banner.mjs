/**
 * LITELLM ASCII banner.
 *
 * The full banner fits an 80-column terminal. Narrower terminals fall back to
 * a compact wordmark rather than wrapping into soup.
 */

const WORD = 'LITELLM';
const LINES = [
  '██╗     ██╗████████╗███████╗██╗     ██╗     ███╗   ███╗',
  '██║     ██║╚══██╔══╝██╔════╝██║     ██║     ████╗ ████║',
  '██║     ██║   ██║   █████╗  ██║     ██║     ██╔████╔██║',
  '██║     ██║   ██║   ██╔══╝  ██║     ██║     ██║╚██╔╝██║',
  '███████╗██║   ██║   ███████╗███████╗███████╗██║ ╚═╝ ██║',
  '╚══════╝╚═╝   ╚═╝   ╚══════╝╚══════╝╚══════╝╚═╝     ╚═╝',
];

/** Width of the full banner in columns. */
export function bannerWidth() {
  return Math.max(...LINES.map((line) => line.length));
}

/** Render the full block-letter banner as an array of lines. */
export function bannerLines() {
  return [...LINES];
}

/**
 * Render the banner sized for the given terminal width.
 * Falls back to a single-line wordmark when the block art would wrap.
 */
export function renderBanner(columns = process.stdout.columns || 80) {
  if (columns >= bannerWidth() + 2) return bannerLines();
  return [[...WORD].join(' ')];
}

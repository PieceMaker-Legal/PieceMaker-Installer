/**
 * PIECEMAKER ASCII banner.
 *
 * Glyphs are 5 rows tall and joined with a single space column. The full
 * banner is 77 columns wide, so it fits an 80-column terminal. Narrower
 * terminals fall back to a compact wordmark rather than wrapping into soup.
 */

const GLYPHS = {
  P: ['██████ ', '██   ██', '██████ ', '██     ', '██     '],
  I: ['██', '██', '██', '██', '██'],
  E: ['███████', '██     ', '█████  ', '██     ', '███████'],
  C: [' ██████', '██     ', '██     ', '██     ', ' ██████'],
  M: ['███    ███', '████  ████', '██ ████ ██', '██  ██  ██', '██      ██'],
  A: [' █████ ', '██   ██', '███████', '██   ██', '██   ██'],
  K: ['██   ██', '██  ██ ', '█████  ', '██  ██ ', '██   ██'],
  R: ['██████ ', '██   ██', '██████ ', '██  ██ ', '██   ██'],
};

const WORD = 'PIECEMAKER';
const ROWS = 5;

/** Width of the full banner in columns. */
export function bannerWidth() {
  const letters = [...WORD].reduce((acc, ch) => acc + GLYPHS[ch][0].length, 0);
  return letters + (WORD.length - 1);
}

/** Render the full block-letter banner as an array of lines. */
export function bannerLines() {
  const lines = [];
  for (let row = 0; row < ROWS; row++) {
    lines.push([...WORD].map((ch) => GLYPHS[ch][row]).join(' '));
  }
  return lines;
}

/**
 * Render the banner sized for the given terminal width.
 * Falls back to a single-line wordmark when the block art would wrap.
 */
export function renderBanner(columns = process.stdout.columns || 80) {
  if (columns >= bannerWidth() + 2) return bannerLines();
  return ['P I E C E M A K E R'];
}

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const taskpaneDir = path.resolve(scriptDir, '..');

await build({
  entryPoints: [path.join(taskpaneDir, 'modules', 'markdown-footnotes-source.mjs')],
  outfile: path.join(taskpaneDir, 'modules', 'markdown-footnotes.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  legalComments: 'none',
  sourcemap: false
});

console.log('Bundle Markdown footnotes généré.');

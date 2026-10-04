// Bundles the game into ONE self-contained index.html (JS, CSS, fonts and logo
// inlined) so it runs from GitHub Pages, any static host, or a double-click.

import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const result = await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  loader: { '.png': 'dataurl' },
  legalComments: 'eof',
});

const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = read('src/index.template.html')
  .replace('/*FONTS*/', () => read('assets/fonts.css'))
  .replace('/*CSS*/', () => read('src/style.css'))
  .replace('/*JS*/', () => js);

const out = path.resolve(root, process.argv[2] || 'index.html');
fs.writeFileSync(out, html);
console.log(`${path.relative(root, out)}  ${(html.length / 1024).toFixed(0)} KB  (js ${(js.length / 1024).toFixed(0)} KB)`);

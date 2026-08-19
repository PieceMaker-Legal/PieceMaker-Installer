import assert from 'node:assert/strict';
import test from 'node:test';

import {
  joinMarkdownDocument,
  markdownToHtml,
  splitMarkdownDocument,
} from '../admin/markdown.mjs';

test('le front matter des skills est séparé du contenu visuel puis préservé', () => {
  const source = '---\nname: exemple\ndescription: Démonstration\ncustom: conservé\n---\n\n# Titre\n\nTexte **important**.\n';
  const parts = splitMarkdownDocument(source);
  assert.equal(parts.metadata.name, 'exemple');
  assert.equal(parts.body.startsWith('# Titre'), true);
  const rebuilt = joinMarkdownDocument(parts.frontMatter, { description: 'Nouvelle description : précise' }, parts.body);
  assert.match(rebuilt, /custom: conservé/);
  assert.match(rebuilt, /description: "Nouvelle description : précise"/);
  assert.equal(splitMarkdownDocument(rebuilt).metadata.description, 'Nouvelle description : précise');
});

test('le rendu visuel transforme les marqueurs Markdown et échappe le HTML actif', () => {
  const html = markdownToHtml('# Titre\n\n- Un\n- Deux\n\n<script>alert(1)</script> **gras**');
  assert.match(html, /<h1>Titre<\/h1>/);
  assert.match(html, /<ul><li>Un<\/li><li>Deux<\/li><\/ul>/);
  assert.match(html, /<strong>gras<\/strong>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('les liens relatifs vers les fichiers annexes d’un skill survivent, les schémas dangereux non', () => {
  // Un asset/script référencé par son chemin relatif dans le SKILL.md reste tel quel.
  assert.match(markdownToHtml('[script](analyse.py)'), /href="analyse\.py"/);
  assert.match(markdownToHtml('[sous](scripts/run.py)'), /href="scripts\/run\.py"/);
  // Toujours bloqués : schéma actif et remontée de dossier.
  assert.match(markdownToHtml('[x](javascript:alert)'), /href="#"/);
  assert.match(markdownToHtml('[z](../secret)'), /href="#"/);
});

test('les tableaux Markdown sont rendus avec un en-tête et des cellules éditables', () => {
  const html = markdownToHtml('| Nom | Statut |\n| --- | --- |\n| Contrat | Signé |');

  assert.match(html, /<table><thead><tr><th>Nom<\/th><th>Statut<\/th><\/tr><\/thead>/);
  assert.match(html, /<tbody><tr><td>Contrat<\/td><td>Signé<\/td><\/tr><\/tbody><\/table>/);
});

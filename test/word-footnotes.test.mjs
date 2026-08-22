import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareMarkdownFootnotes } from '../taskpane/modules/markdown-footnotes-source.mjs';
import { footnoteOoxmlToMarkdownBlocks } from '../taskpane/modules/word-footnotes.js';

// Le bundle destiné au navigateur sélectionne volontairement le décodeur DOM
// de micromark. Ce DOM minimal suffit aux tests Node, qui n'emploient aucune
// entité HTML dans leurs fixtures.
globalThis.document = {
  createElement() {
    return {
      set innerHTML(value) { this.textContent = value; },
      textContent: ''
    };
  }
};
const { __footnoteTestUtils } = await import('../taskpane/modules/doc-tools.js');

const {
  decodeMarkdownComment,
  encodeMarkdownComment,
  formatIndexedEntries,
  formatParagraphRange,
  insertFootnoteReferences,
  insertInlineAnnotations,
  markdownLineToWordFormat
} = __footnoteTestUtils;

test('analyse les références et définitions GitHub/Pandoc avant le découpage en lignes', () => {
  const parsed = prepareMarkdownFootnotes([
    'Texte[^simple] et note longue[^longue].',
    '',
    '[^simple]: Note avec **gras** et *italique*.',
    '',
    '[^longue]: Premier paragraphe.',
    '',
    '    Deuxième paragraphe.'
  ].join('\n'));

  assert.equal(parsed.legacySyntaxUsed, false);
  assert.doesNotMatch(parsed.markdown, /^\[\^[^\]]+\]:/m);
  assert.equal(parsed.footnotes.length, 2);
  assert.deepEqual(parsed.footnotes[0].blocks, ['Note avec **gras** et *italique*.']);
  assert.deepEqual(parsed.footnotes[1].blocks, ['Premier paragraphe.', 'Deuxième paragraphe.']);
});

test('une référence répétée produit deux occurrences Word comme Pandoc', () => {
  const parsed = prepareMarkdownFootnotes('Un[^x], puis deux[^x].\n\n[^x]: Même source.');

  assert.equal(parsed.footnotes.length, 2);
  assert.deepEqual(parsed.footnotes[0].blocks, ['Même source.']);
  assert.deepEqual(parsed.footnotes[1].blocks, ['Même source.']);
});

test('accepte l’ancienne syntaxe seulement comme migration en entrée', () => {
  const parsed = prepareMarkdownFootnotes('Texte[^footnote: Source historique].');

  assert.equal(parsed.legacySyntaxUsed, true);
  assert.equal(parsed.footnotes.length, 1);
  assert.deepEqual(parsed.footnotes[0].blocks, ['Source historique']);
});

test('refuse les notes invalides avant toute mutation Word', () => {
  assert.throws(
    () => prepareMarkdownFootnotes('Texte[^absente].'),
    /Définition de note manquante/
  );
  assert.throws(
    () => prepareMarkdownFootnotes('[^orpheline]: Source sans appel.'),
    /Définition de note sans référence/
  );
  assert.throws(
    () => prepareMarkdownFootnotes('Texte[^x].\n\n[^x]: Un.\n\n[^x]: Deux.'),
    /Définitions contradictoires/
  );
  assert.throws(
    () => prepareMarkdownFootnotes('Texte[^x].\n\n[^x]: Note imbriquée[^y].\n\n[^y]: Autre.'),
    /notes imbriquées/
  );
});

test('convertit la note préparée en segments Word et conserve ses paragraphes', () => {
  const parsed = prepareMarkdownFootnotes('Texte[^n].\n\n[^n]: **Premier**.\n\n    Second [lien](https://example.com).');
  const wordParagraph = markdownLineToWordFormat(parsed.markdown, parsed.footnotes);
  const marker = wordParagraph.segments.find((segment) => segment.isFootnote);
  const footnote = wordParagraph.footnotes[marker.footnoteIndex];

  assert.equal(footnote.paragraphs.length, 2);
  assert.equal(footnote.paragraphs[0].segments[0].text, 'Premier');
  assert.equal(footnote.paragraphs[0].segments[0].bold, true);
  assert.equal(footnote.paragraphs[1].segments[0].text, 'Second ');
  assert.equal(footnote.paragraphs[1].segments[1].text, 'lien');
  assert.equal(footnote.paragraphs[1].segments[1].hyperlink, 'https://example.com');
});

test('insère une vraie note même quand son appel est dans un formatage inline', () => {
  const cases = [
    {
      source: '**Avant[^x] après**\n\n[^x]: Note.',
      assertFormatting: (segments) => assert.ok(segments.every((segment) => segment.bold))
    },
    {
      source: '*Avant[^x] après*\n\n[^x]: Note.',
      assertFormatting: (segments) => assert.ok(segments.every((segment) => segment.italic))
    },
    {
      source: '<u>Avant[^x] après</u>\n\n[^x]: Note.',
      assertFormatting: (segments) => assert.ok(segments.every((segment) => segment.underline))
    },
    {
      source: '[Avant[^x] après](https://example.com)\n\n[^x]: Note.',
      assertFormatting: (segments) => assert.ok(
        segments.every((segment) => segment.hyperlink === 'https://example.com')
      )
    }
  ];

  for (const { source, assertFormatting } of cases) {
    const parsed = prepareMarkdownFootnotes(source);
    const wordParagraph = markdownLineToWordFormat(parsed.markdown, parsed.footnotes);
    const markers = wordParagraph.segments.filter((segment) => segment.isFootnote);
    const textSegments = wordParagraph.segments.filter((segment) => segment.text);

    assert.equal(markers.length, 1);
    assert.equal(wordParagraph.footnotes[markers[0].footnoteIndex].paragraphs[0].segments[0].text, 'Note.');
    assert.ok(wordParagraph.segments.every((segment) => !segment.text.includes('__FOOTNOTE_')));
    assertFormatting(textSegments);
  }
});

test('reconstruit les blocs Markdown depuis les runs OOXML de la note Word', () => {
  const ooxml = [
    '<pkg:package>',
    '<w:footnote>',
    '<w:p>',
    '<w:r><w:footnoteRef/></w:r>',
    '<w:r><w:t>Note </w:t></w:r>',
    '<w:r><w:rPr><w:b/></w:rPr><w:t>forte</w:t></w:r>',
    '<w:r><w:t> et </w:t></w:r>',
    '<w:r><w:rPr><w:i/></w:rPr><w:t>italique</w:t></w:r>',
    '</w:p>',
    '<w:p><w:hyperlink r:id="rId7"><w:r><w:t>Lien</w:t></w:r></w:hyperlink></w:p>',
    '</w:footnote>',
    '<Relationship Id="rId7" Target="https://example.com?a=1&amp;b=2"/>',
    '</pkg:package>'
  ].join('');

  assert.deepEqual(footnoteOoxmlToMarkdownBlocks(ooxml), [
    'Note **forte** et *italique*',
    '[Lien](https://example.com?a=1&b=2)'
  ]);
});

test('place les appels à leur offset exact sans modifier les index', () => {
  assert.equal(
    insertFootnoteReferences('Alpha puis bêta.', [
      { offset: 5, number: 1 },
      { offset: 16, number: 2 }
    ]),
    'Alpha[^1] puis bêta.[^2]'
  );

  const output = formatParagraphRange([
    { index: 0, text: 'Avant', style: 'Normal', footnotes: [] },
    {
      index: 1,
      text: 'Avec une note[^1].',
      style: 'Normal',
      footnotes: [{ number: 1, blocks: ['Source.'] }]
    },
    { index: 2, text: 'Après', style: 'Normal', footnotes: [] }
  ], { maxChars: 1000 });

  assert.match(output, /^0 -> Avant$/m);
  assert.match(output, /^1 -> Avec une note\[\^1\]\.$/m);
  assert.match(output, /^\[\^1\]: Source\.$/m);
  assert.match(output, /^2 -> Après$/m);
  assert.doesNotMatch(output, /^\d+ -> \[\^1\]:/m);
});

test('convertit les commentaires Word sans perdre tirets, balises ou retours de ligne', () => {
  const comment = 'Avis - A --> B\n<à revoir> & suite';
  const encoded = encodeMarkdownComment(comment);

  assert.equal(decodeMarkdownComment(encoded), comment);
  assert.doesNotMatch(encoded, /-->/);

  const markdown = insertInlineAnnotations('Alpha\u200BBêta', [], [{
    offset: 5,
    text: comment,
    removeLength: 1
  }]);
  const wordParagraph = markdownLineToWordFormat(markdown);

  assert.equal(markdown.includes('\u200B'), false);
  assert.equal(wordParagraph.comments[0].text, comment);
  assert.equal(
    wordParagraph.segments.filter((segment) => segment.text).map((segment) => segment.text).join(''),
    'AlphaBêta'
  );
});

test('accepte aussi les commentaires Markdown ordinaires contenant des tirets', () => {
  const wordParagraph = markdownLineToWordFormat('Texte<!-- commentaire - avec tiret --> suite');

  assert.equal(wordParagraph.comments[0].text, 'commentaire - avec tiret');
  assert.equal(wordParagraph.segments.some((segment) => segment.isComment), true);
});

test('préserve une note et un commentaire placés au même offset', () => {
  assert.equal(
    insertInlineAnnotations('A\u200BB', [{ offset: 1, number: 1 }], [{
      offset: 1,
      text: 'Commentaire',
      removeLength: 1
    }]),
    'A[^1]<!-- Commentaire -->B'
  );
});

test('la pagination ne sépare jamais un appel de sa définition', () => {
  const atomicContent = `Paragraphe[^1].\n\n[^1]: ${'s'.repeat(430)}`;
  const page = formatIndexedEntries([
    { index: 0, content: 'Court' },
    { index: 1, content: atomicContent, atomic: true },
    { index: 2, content: 'Après' }
  ], { maxChars: 500 });

  assert.match(page, /^0 -> Court$/m);
  assert.match(page, /\[TRUNCATED\].*"from_index":1/);
  assert.doesNotMatch(page, /\[\^1\]/);

  const resumed = formatIndexedEntries([
    { index: 1, content: atomicContent, atomic: true },
    { index: 2, content: 'Après' }
  ], { fromIndex: 1, maxChars: 700 });
  assert.match(resumed, /^1 -> Paragraphe\[\^1\]\.$/m);
  assert.match(resumed, /^\[\^1\]: s+$/m);
  assert.match(resumed, /^2 -> Après$/m);

  assert.match(
    formatIndexedEntries(
      [{ index: 1, content: atomicContent, atomic: true }],
      { fromIndex: 1, fromOffset: 2, maxChars: 700 }
    ),
    /from_offset cannot resume inside paragraph 1/
  );
});

test('une note atomique dépassant seule le plafond produit une erreur explicite', () => {
  const result = formatIndexedEntries([
    { index: 7, content: `Texte[^1].\n\n[^1]: ${'x'.repeat(600)}`, atomic: true }
  ], { maxChars: 500 });

  assert.match(result, /Paragraph 7 and its footnotes exceed max_chars/);
  assert.doesNotMatch(result, /\[TRUNCATED\]/);
});

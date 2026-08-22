import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { prepareMarkdownFootnotes } from '../taskpane/modules/markdown-footnotes-source.mjs';

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
  applyRunFormatting,
  characterRangesToRuns,
  convertParagraphToMarkdown,
  decodeMarkdownComment,
  encodeMarkdownComment,
  formatIndexedEntries,
  formatWordFootnoteParagraph,
  formatParagraphRange,
  insertAnnotationsIntoRuns,
  insertFootnoteReferences,
  insertInlineAnnotations,
  loadDetailedParagraphRanges,
  markdownLineToWordFormat,
  normalizeAnnotationsForRuns
} = __footnoteTestUtils;

test('fusionne les caractères Word API contigus et restitue leur formatage mixte', () => {
  const character = (text, font = {}, hyperlink = '') => ({ text, font, hyperlink });
  const runs = characterRangesToRuns({ items: [
    character('N', { bold: false, italic: false, underline: 'None' }),
    character('o', { bold: false, italic: false, underline: 'None' }),
    character('G', { bold: true, italic: false, underline: 'None' }),
    character('I', { bold: false, italic: true, underline: 'None' }),
    character('S', { bold: false, italic: false, underline: 'Single' }),
    character('L', { bold: true, italic: false, underline: 'None' }, 'https://example.com')
  ] });

  assert.equal(applyRunFormatting(runs), 'No**G***I*<u>S</u>[**L**](https://example.com)');
  assert.equal(convertParagraphToMarkdown({
    text: 'NoGISL', style: 'Heading 1', runs
  }), '## No**G***I*<u>S</u>[**L**](https://example.com)');

  const reparsed = markdownLineToWordFormat(applyRunFormatting(runs));
  assert.ok(reparsed.segments.some((segment) => segment.text === 'G' && segment.bold));
  assert.ok(reparsed.segments.some((segment) => segment.text === 'I' && segment.italic));
  assert.ok(reparsed.segments.some((segment) => segment.text === 'S' && segment.underline));
  assert.ok(reparsed.segments.some((segment) => (
    segment.text === 'L' && segment.bold && segment.hyperlink === 'https://example.com'
  )));
});

test('aligne notes et commentaires sur les plages Word privées de U+0002', () => {
  const paragraphText = 'Avant\u0002 après suite';
  const runs = [{ text: 'Avant après suite', font: { bold: true } }];
  const reference = { offset: paragraphText.indexOf('\u0002'), number: 1, removeLength: 1 };

  for (const [comment, expected] of [
    [
      { offset: reference.offset, text: 'même', removeLength: 0 },
      '**Avant**<!-- même -->[^1]** après suite**'
    ],
    [
      { offset: paragraphText.indexOf('suite'), text: 'après', removeLength: 0 },
      '**Avant**[^1]** après **<!-- après -->**suite**'
    ]
  ]) {
    const normalized = normalizeAnnotationsForRuns(paragraphText, [reference], [comment]);
    assert.equal(
      applyRunFormatting(insertAnnotationsIntoRuns(runs, normalized.references, normalized.comments)),
      expected
    );
  }
});

test('ne ré-échappe pas les annotations déjà injectées d’un paragraphe uniforme', () => {
  assert.equal(convertParagraphToMarkdown({
    text: 'Avant[^1]<!-- avis --> après',
    style: 'Normal',
    runs: [{
      text: 'Avant[^1]<!-- avis --> après',
      markdown: true,
      font: { bold: true, italic: false, underline: 'None' }
    }]
  }), '**Avant[^1]<!-- avis --> après**');
});

test('borne la recherche par caractère au nombre de paragraphes réellement mixtes', () => {
  let calls = 0;
  const loads = [];
  const paragraph = (font) => ({
    font,
    search(query, options) {
      calls += 1;
      assert.equal(query, '?');
      assert.deepEqual(options, { matchWildcards: true });
      return { items: [], load(value) { loads.push(value); } };
    }
  });
  const paragraphs = [
    ...Array.from({ length: 1000 }, () => paragraph({ bold: false, italic: false, underline: 'None' })),
    paragraph({ bold: null, italic: false, underline: 'None' }),
    paragraph({ bold: false, italic: 'Mixed', underline: 'None' })
  ];

  const results = loadDetailedParagraphRanges(paragraphs, null, true);
  assert.equal(calls, 2);
  assert.equal(results.filter(Boolean).length, 2);
  for (const value of loads) {
    assert.deepEqual(value, {
      text: true,
      font: { bold: true, italic: true, underline: true },
      hyperlink: true
    });
  }
  const linked = paragraph({ bold: false, italic: false, underline: 'None' });
  assert.ok(loadDetailedParagraphRanges(
    [linked], false, true, ['https://example.com']
  )[0], 'un lien uniforme exige aussi les plages détaillées');
  assert.equal(calls, 3);
  loadDetailedParagraphRanges(paragraphs, true, true);
  assert.equal(calls, 3, 'une vue de révision conserve le mécanisme agrégé historique');
});

test('retombe explicitement sur le format agrégé sans Paragraph.search', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(' '));
  try {
    const results = loadDetailedParagraphRanges([
      { font: { bold: null, italic: false, underline: 'None' } },
      {
        font: { bold: false, italic: 'Mixed', underline: 'None' },
        search() { throw new Error('indisponible'); }
      }
    ]);
    assert.deepEqual(results, [null, null]);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => warning.includes('format agrégé utilisé')));
  } finally {
    console.warn = originalWarn;
  }
});

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

test('reconstruit un paragraphe de note depuis ses plages Word API', () => {
  const ranges = { items: [
    { text: 'Note ', font: { bold: false, italic: false, underline: 'None' }, hyperlink: '' },
    { text: 'forte', font: { bold: true, italic: false, underline: 'None' }, hyperlink: '' },
    { text: ' et ', font: { bold: false, italic: false, underline: 'None' }, hyperlink: '' },
    { text: 'lien', font: { bold: false, italic: true, underline: 'None' }, hyperlink: 'https://example.com' }
  ] };
  const markdown = formatWordFootnoteParagraph({ text: 'Note forte et lien', font: {} }, ranges);
  assert.equal(markdown, 'Note **forte** et [*lien*](https://example.com)');
  const reparsed = markdownLineToWordFormat(markdown);
  assert.ok(reparsed.segments.some((segment) => segment.text === 'forte' && segment.bold));
  assert.ok(reparsed.segments.some((segment) => (
    segment.text === 'lien' && segment.italic && segment.hyperlink === 'https://example.com'
  )));
});

test('read_doc et edit_doc ne lisent jamais le contenu Word en OOXML', () => {
  const source = fs.readFileSync(new URL('../taskpane/modules/doc-tools.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /getOoxml\s*\(/i);
  assert.doesNotMatch(source, /footnoteOoxmlToMarkdownBlocks/);
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

test('remplace le marqueur Word U+0002 par l’appel Markdown de la note', () => {
  assert.equal(
    insertFootnoteReferences('note\u0002', [
      { offset: 4, number: 1, removeLength: 1 }
    ]),
    'note[^1]'
  );

  // Les offsets proviennent du texte Word brut : le commentaire situé après
  // la note compte donc encore U+0002 lorsqu'il est inséré en premier.
  assert.equal(
    insertInlineAnnotations('note\u0002\u200Bsuite', [
      { offset: 4, number: 1, removeLength: 1 }
    ], [{
      offset: 5,
      text: 'Commentaire',
      removeLength: 1
    }]),
    'note[^1]<!-- Commentaire -->suite'
  );
});

test('ne supprime aucun caractère sans référence Word structurée correspondante', () => {
  assert.equal(
    insertFootnoteReferences('littéral\u0002 et appel', [
      { offset: 18, number: 1 }
    ]),
    'littéral\u0002 et appel[^1]'
  );

  const parsed = prepareMarkdownFootnotes('note[^n].\n\n[^n]: Source Luna.');
  assert.equal(parsed.footnotes.length, 1);
  assert.deepEqual(parsed.footnotes[0].blocks, ['Source Luna.']);
});

test('convertit les commentaires Word sans perdre tirets, balises ou retours de ligne', () => {
  const comment = 'Avis - A --> B\n<à revoir> & suite';
  const encoded = encodeMarkdownComment(comment);

  assert.equal(decodeMarkdownComment(encoded), comment);
  assert.doesNotMatch(encoded, /-->/);
  assert.match(encoded, /Avis - A/);

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

test('expose les tirets simples tels quels dans les commentaires Markdown', () => {
  assert.equal(
    insertInlineAnnotations('Texte', [], [{ offset: 5, text: 'commentaire - tiret' }]),
    'Texte<!-- commentaire - tiret -->'
  );
});

test('échappe seulement les séquences interdites et les décode sans ambiguïté', () => {
  const comments = [
    'double -- tiret',
    'fermeture --> prématurée',
    'triple --- tiret',
    'littéral &#45; et &amp;',
    '<balise attr="a&b">\nseconde ligne\r\nfin'
  ];

  for (const comment of comments) {
    const encoded = encodeMarkdownComment(comment);
    assert.equal(decodeMarkdownComment(encoded), comment);
    assert.doesNotMatch(encoded, /--/);

    const markdown = insertInlineAnnotations('AB', [], [{ offset: 1, text: comment }]);
    const parsed = markdownLineToWordFormat(markdown);
    assert.equal(parsed.comments[0].text, comment);
    assert.equal(
      parsed.segments.filter((segment) => segment.text).map((segment) => segment.text).join(''),
      'AB'
    );
  }
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

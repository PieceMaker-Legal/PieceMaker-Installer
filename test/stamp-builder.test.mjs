import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_STAMP_CONFIG,
  fitFontSize,
  normalizeStampConfig,
} from '../admin/stamp-builder.mjs';

test('le générateur normalise ses options sans laisser entrer de valeurs CSS arbitraires', () => {
  assert.deepEqual(normalizeStampConfig({}), DEFAULT_STAMP_CONFIG);
  assert.deepEqual(normalizeStampConfig({
    topText: '  PIÈCE    N°  ',
    bottomText: ' Cabinet '.repeat(10),
    shape: 'triangle',
    border: 'triple',
    font: 'fantasy',
    color: 'red; background: url(x)',
    lineWidth: 99,
  }), {
    topText: 'PIÈCE N°',
    bottomText: 'Cabinet Cabinet Cabinet Cabinet Cabinet ',
    shape: 'circle',
    border: 'double',
    font: 'sans',
    color: '#1f4f45',
    lineWidth: 20,
  });
});

test('le texte long est réduit jusqu’à tenir dans le tampon', () => {
  const context = {
    __stampFontFamily: 'Arial',
    font: '',
    measureText(text) {
      const size = Number(this.font.match(/(\d+)px/)?.[1] || 0);
      return { width: text.length * size };
    },
  };
  const size = fitFontSize(context, '1234567890', 300, 60, 18);
  assert.equal(size, 30);
});

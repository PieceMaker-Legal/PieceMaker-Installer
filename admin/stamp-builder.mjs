export const DEFAULT_STAMP_CONFIG = Object.freeze({
  topText: 'PIÈCE N°',
  bottomText: '',
  shape: 'circle',
  border: 'double',
  font: 'sans',
  color: '#1f4f45',
  lineWidth: 10,
});

const FONT_FAMILIES = Object.freeze({
  sans: 'Arial, Helvetica, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", Courier, monospace',
});

const SHAPES = new Set(['circle', 'oval', 'rounded', 'rect']);
const BORDERS = new Set(['single', 'double']);

function cleanText(value, fallback = '') {
  return String(value ?? fallback).replace(/\s+/g, ' ').trim().slice(0, 40);
}

export function normalizeStampConfig(config = {}) {
  const lineWidth = Number(config.lineWidth);
  return {
    topText: cleanText(config.topText, DEFAULT_STAMP_CONFIG.topText),
    bottomText: cleanText(config.bottomText),
    shape: SHAPES.has(config.shape) ? config.shape : DEFAULT_STAMP_CONFIG.shape,
    border: BORDERS.has(config.border) ? config.border : DEFAULT_STAMP_CONFIG.border,
    font: FONT_FAMILIES[config.font] ? config.font : DEFAULT_STAMP_CONFIG.font,
    color: /^#[0-9a-f]{6}$/i.test(String(config.color || ''))
      ? String(config.color)
      : DEFAULT_STAMP_CONFIG.color,
    lineWidth: Number.isFinite(lineWidth) ? Math.min(20, Math.max(4, lineWidth)) : DEFAULT_STAMP_CONFIG.lineWidth,
  };
}

export function fitFontSize(context, text, maxWidth, preferredSize, minimumSize = 18) {
  const family = context.__stampFontFamily || FONT_FAMILIES.sans;
  let size = preferredSize;
  do {
    context.font = `700 ${size}px ${family}`;
    if (context.measureText(text).width <= maxWidth) return size;
    size -= 1;
  } while (size > minimumSize);
  return minimumSize;
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function traceBorder(context, shape, inset) {
  const center = 300;
  const radius = 276 - inset;
  context.beginPath();
  if (shape === 'circle') {
    context.arc(center, center, radius, 0, Math.PI * 2);
  } else if (shape === 'oval') {
    context.ellipse(center, center, radius, radius * 0.72, 0, 0, Math.PI * 2);
  } else if (shape === 'rounded') {
    roundedRect(context, 24 + inset, 90 + inset, 552 - (inset * 2), 420 - (inset * 2), 58);
  } else {
    context.rect(24 + inset, 90 + inset, 552 - (inset * 2), 420 - (inset * 2));
  }
  context.stroke();
}

function curvedText(context, text, { centerX, centerY, radius, centerAngle, direction, maxArc }) {
  if (!text) return;
  const family = context.__stampFontFamily;
  let fontSize = 58;
  let widths;
  let totalWidth;
  do {
    context.font = `700 ${fontSize}px ${family}`;
    widths = [...text].map((character) => context.measureText(character).width + (fontSize * 0.06));
    totalWidth = widths.reduce((sum, width) => sum + width, 0);
    fontSize -= 1;
  } while (totalWidth / radius > maxArc && fontSize > 24);

  const totalAngle = totalWidth / radius;
  let angle = centerAngle - (direction * totalAngle / 2);
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  [...text].forEach((character, index) => {
    const characterAngle = widths[index] / radius;
    angle += direction * characterAngle / 2;
    context.save();
    context.translate(
      centerX + (Math.cos(angle) * radius),
      centerY + (Math.sin(angle) * radius),
    );
    context.rotate(angle + (direction === 1 ? Math.PI / 2 : -Math.PI / 2));
    context.fillText(character, 0, 0);
    context.restore();
    angle += direction * characterAngle / 2;
  });
}

function straightText(context, text, y, maxWidth, preferredSize) {
  if (!text) return;
  const size = fitFontSize(context, text, maxWidth, preferredSize);
  context.font = `700 ${size}px ${context.__stampFontFamily}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 300, y);
}

/**
 * Dessine uniquement la matrice du tampon. Le numéro reste volontairement
 * absent : `/api/stamping` l'ajoute ensuite au centre pour chaque pièce.
 */
export function drawStamp(canvas, rawConfig = {}) {
  const config = normalizeStampConfig(rawConfig);
  canvas.width = 600;
  canvas.height = 600;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D indisponible.');

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = config.color;
  context.fillStyle = config.color;
  context.lineWidth = config.lineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.__stampFontFamily = FONT_FAMILIES[config.font];

  traceBorder(context, config.shape, 0);
  if (config.border === 'double') traceBorder(context, config.shape, 24);

  if (config.shape === 'circle' || config.shape === 'oval') {
    const radius = config.shape === 'circle' ? 205 : 185;
    const verticalScale = config.shape === 'circle' ? 1 : 0.76;
    context.save();
    context.translate(300, 300);
    context.scale(1, verticalScale);
    context.translate(-300, -300);
    curvedText(context, config.topText, {
      centerX: 300,
      centerY: 300,
      radius,
      centerAngle: -Math.PI / 2,
      direction: 1,
      maxArc: Math.PI * 1.25,
    });
    curvedText(context, config.bottomText, {
      centerX: 300,
      centerY: 300,
      radius,
      centerAngle: Math.PI / 2,
      direction: -1,
      maxArc: Math.PI * 1.25,
    });
    context.restore();

    // Deux repères latéraux donnent au tampon circulaire une lecture nette,
    // même quand la ligne basse est vide.
    context.beginPath();
    context.arc(96, 300, 7, 0, Math.PI * 2);
    context.arc(504, 300, 7, 0, Math.PI * 2);
    context.fill();
  } else {
    straightText(context, config.topText, 205, 470, 72);
    straightText(context, config.bottomText, 405, 470, 52);
  }

  return config;
}

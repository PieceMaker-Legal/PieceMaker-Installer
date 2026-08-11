/** Normalisation du texte OOXML hors de la boucle d'événements du serveur. */
const { parentPort, workerData } = require('node:worker_threads');

function decodeXmlText(value) {
  return String(value || '').replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hexadecimal) => {
    const codePoint = decimal ? Number(decimal) : Number.parseInt(hexadecimal, 16);
    if ((decimal || hexadecimal) && Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      return String.fromCodePoint(codePoint);
    }
    if (decimal || hexadecimal) return entity;
    return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity.toLowerCase()] || entity;
  });
}

function wordXmlToText(xml) {
  const source = String(xml || '')
    .replace(/<w:(?:del|moveFrom)\b[^>]*>[\s\S]*?<\/w:(?:del|moveFrom)>/gi, '');
  const tokens = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<\/w:p\s*>|<\/w:tc\s*>/gi;
  let text = '';
  let match;
  while ((match = tokens.exec(source))) {
    if (match[1] !== undefined) text += decodeXmlText(match[1].replace(/<[^>]+>/g, ''));
    else if (/^<\/w:p/i.test(match[0])) text += '\n';
    else if (/^<\/w:tc/i.test(match[0]) || /^<w:tab/i.test(match[0])) text += '\t';
    else text += '\n';
  }
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .trim();
}

const sections = (Array.isArray(workerData) ? workerData : [])
  .map(({ title, xml }) => ({ title: String(title || ''), content: wordXmlToText(xml) }))
  .filter((section) => section.content);
const text = sections.length === 1 && sections[0].title === 'Corps du document'
  ? sections[0].content
  : sections.map((section) => `〔${section.title}〕\n${section.content}`).join('\n\n');

parentPort.postMessage(text);

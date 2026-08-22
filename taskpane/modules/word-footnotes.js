function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeMarkdownText(value) {
  return value.replace(/([\\*_[\]])/g, '\\$1');
}

function toggleEnabled(properties, tagName) {
  const match = properties.match(new RegExp(`<w:${tagName}\\b([^>]*)/?>`, 'i'));
  if (!match) return false;
  const value = match[1].match(/w:val=["']([^"']+)["']/i)?.[1]?.toLowerCase();
  return !['0', 'false', 'off', 'none'].includes(value);
}

function renderRun(runXml) {
  if (/<w:footnoteRef\b/i.test(runXml)) return '';
  const properties = runXml.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i)?.[1] || '';
  let text = '';
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<w:cr\b[^>]*\/?\s*>|<w:noBreakHyphen\b[^>]*\/?\s*>|<w:softHyphen\b[^>]*\/?\s*>/gi;
  let token;
  while ((token = tokenPattern.exec(runXml)) !== null) {
    if (token[1] !== undefined) text += escapeMarkdownText(decodeXml(token[1]));
    else if (/^<w:tab/i.test(token[0])) text += '\t';
    else if (/^<w:(?:br|cr)/i.test(token[0])) text += '  \n';
    else if (/^<w:noBreakHyphen/i.test(token[0])) text += '‑';
    else if (/^<w:softHyphen/i.test(token[0])) text += '\u00AD';
  }
  if (!text) return '';

  const bold = toggleEnabled(properties, 'b');
  const italic = toggleEnabled(properties, 'i');
  const underline = toggleEnabled(properties, 'u');
  if (bold && italic) text = `***${text}***`;
  else if (bold) text = `**${text}**`;
  else if (italic) text = `*${text}*`;
  if (underline) text = `<u>${text}</u>`;
  return text;
}

function relationshipTargets(ooxml) {
  const targets = new Map();
  const pattern = /<Relationship\b([^>]*)\/?\s*>/gi;
  let match;
  while ((match = pattern.exec(ooxml)) !== null) {
    const id = match[1].match(/\bId=["']([^"']+)["']/i)?.[1];
    const target = match[1].match(/\bTarget=["']([^"']+)["']/i)?.[1];
    if (id && target) targets.set(id, decodeXml(target));
  }
  return targets;
}

function renderParagraph(paragraphXml, targets) {
  const withoutDeletedText = paragraphXml.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gi, '');
  const pattern = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/gi;
  let output = '';
  let match;
  while ((match = pattern.exec(withoutDeletedText)) !== null) {
    if (match[2] !== undefined) {
      const id = match[1].match(/r:id=["']([^"']+)["']/i)?.[1];
      const label = [...match[2].matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/gi)]
        .map((run) => renderRun(run[0]))
        .join('');
      const target = id ? targets.get(id) : null;
      output += target && label ? `[${label}](${target})` : label;
    } else {
      output += renderRun(match[0]);
    }
  }
  return output.trim();
}

/**
 * Convertit le fragment OOXML d'un corps de note Word en blocs Markdown. Le
 * parseur reste volontairement limité aux éléments que edit_doc sait recréer :
 * paragraphes, gras, italique, souligné, liens, tabulations et sauts de ligne.
 */
export function footnoteOoxmlToMarkdownBlocks(value) {
  const ooxml = String(value || '');
  if (!ooxml) return [];
  const targets = relationshipTargets(ooxml);
  const blocks = [];
  const paragraphPattern = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi;
  let match;
  while ((match = paragraphPattern.exec(ooxml)) !== null) {
    const block = renderParagraph(match[0], targets);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Read-doc and Edit-doc MCP Tools (ES6 Module)
 *
 * These tools provide LLM access to Word documents with:
 * - Markdown conversion for better readability
 * - Index-based paragraph targeting
 * - Placeholder management with guidelines
 * - Track changes support
 */

import { FOOTNOTE_TOKEN_PATTERN, prepareMarkdownFootnotes } from './markdown-footnotes.js';
import { footnoteOoxmlToMarkdownBlocks } from './word-footnotes.js';
import { readRevisions, reviewRevisions } from './word-revisions.js';

let deps = null;

export function initDocToolsDependencies(dependencies) {
    deps = dependencies;
}

// State for tracking if doc was read (replaces window.__doc_read_before_edit)
let docReadBeforeEdit = false;

/**
 * Validate placeholder content against its validation rules
 * @param {string} placeholderName - Name of placeholder (without {{  }})
 * @param {string} content - Content to validate
 * @returns {Promise<{valid: boolean, message: string}>}
 */
export async function validatePlaceholderContent(placeholderName, content) {
  const draftState = deps?.draftConclusionsState;
  
  try {
    let guidelinesFileName = 'placeholders_guidelines.json';
    if (draftState &&
        draftState.templateInjected &&
        draftState.templateName) {
      guidelinesFileName = draftState.templateName.replace('.docx', '.json');
    }

    const response = await fetch(`https://localhost:43098/api/resources/${encodeURIComponent(guidelinesFileName)}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      return { valid: true, message: '' };
    }

    const result = await response.json();
    const library = result.content ? JSON.parse(result.content) : result;
    const placeholder = library.placeholders[placeholderName];

    if (!placeholder || !placeholder.validation || !placeholder.validation.enabled) {
      return { valid: true, message: '' };
    }

    const rules = placeholder.validation.rules || [];

    for (const rule of rules) {
      if (rule.type === 'footnote') {
        try {
          const parsed = prepareMarkdownFootnotes(content, { acceptLegacy: false });
          if (parsed.footnotes.length === 0) {
            return {
              valid: false,
              message: rule.message || 'Le contenu doit comporter une référence [^id] et sa définition [^id]: source.'
            };
          }
        } catch (error) {
          return {
            valid: false,
            message: rule.message || `Note de bas de page invalide : ${error.message}`
          };
        }
        continue;
      }

      if (rule.type === 'contains') {
        const patterns = rule.patterns || [];
        const operator = rule.operator || 'OR';

        if (operator === 'OR') {
          const found = patterns.some(pattern => content.includes(pattern));
          if (!found) {
            return {
              valid: false,
              message: rule.message || `Content must contain one of: ${patterns.join(', ')}`
            };
          }
        } else if (operator === 'AND') {
          const allFound = patterns.every(pattern => content.includes(pattern));
          if (!allFound) {
            return {
              valid: false,
              message: rule.message || `Content must contain all of: ${patterns.join(', ')}`
            };
          }
        }
      }
    }

    return { valid: true, message: '' };
  } catch (error) {
    console.error('Validation error:', error);
    return { valid: true, message: '' };
  }
}

/**
 * Parse index range string to array of integers
 * @param {string} rangeStr - Range string like "3-15"
 * @returns {number[]} - Array of index numbers [3,4,5,...,15]
 */
function parseIndexRange(rangeStr) {
  const cleaned = rangeStr.replace(/\s/g, '');
  const rangeMatch = cleaned.match(/^(\d+)-(\d+)$/);

  if (rangeMatch) {
    const start = parseInt(rangeMatch[1]);
    const end = parseInt(rangeMatch[2]);

    if (start > end) {
      throw new Error(`Invalid range: start (${start}) must be <= end (${end})`);
    }

    const result = [];
    for (let i = start; i <= end; i++) {
      result.push(i);
    }
    return result;
  }

  const singleNum = parseInt(cleaned);
  if (!isNaN(singleNum)) {
    return [singleNum];
  }

  throw new Error(`Invalid index format: "${rangeStr}". Use "3-15" for range or "5" for single index.`);
}

/**
 * TOOL: read-doc
 *
 * Read Word document content with Markdown formatting
 *
 * Modes:
 * 1. Full document read
 * 2. List headings only (structure view)
 * 3. Fetch specific heading and its content
 * 4. Fetch specific indexes (supports array [1,2,3] or range "3-15")
 *
 * @param {Object} params - Tool parameters
 * @returns {string} - Formatted document content (NOT JSON)
 */
export async function readDoc(params = {}) {
  if (params.revisions && typeof params.revisions === 'object') {
    return readRevisions(params.revisions, params.max_chars);
  }

  const {
    list_headings = false,
    heading = null,
    indexes = null,
    include_track_changes = false,
    revision_view = null,
    from_index = 0,
    from_offset = 0,
    max_chars = 100000
  } = params;

  const readOptions = {
    fromIndex: Number.isInteger(from_index) && from_index >= 0 ? from_index : 0,
    fromOffset: Number.isInteger(from_offset) && from_offset >= 0 ? from_offset : 0,
    maxChars: Math.min(100000, Math.max(500, Number.isFinite(max_chars) ? Math.floor(max_chars) : 100000))
  };
  const reviewedVersion = revision_view === 'original'
    ? Word.ChangeTrackingVersion.original
    : revision_view === 'current' || !include_track_changes
      ? Word.ChangeTrackingVersion.current
      : null;

  return await Word.run(async (context) => {
    try {
      let parsedIndexes = null;
      if (indexes) {
        try {
          if (Array.isArray(indexes)) {
            parsedIndexes = indexes;
          } else if (typeof indexes === 'string') {
            parsedIndexes = parseIndexRange(indexes);
          } else {
            return `❌ Invalid indexes parameter. Use array [1,2,3] or range string "3-15"`;
          }
        } catch (e) {
          return `❌ ${e.message}`;
        }
      }

      const body = context.document.body;
      const paragraphs = body.paragraphs;

      paragraphs.load('items');

      let comments = null;
      try {
        comments = body.getComments();
        comments.load('items');
      } catch (e) {
        console.warn('Comments not supported on this platform');
      }

      await context.sync();

      const reviewedTextResults = [];
      const paragraphFootnotesData = [];
      const paragraphFootnotePrefixes = [];
      const paragraphFootnoteOoxmlResults = [];
      const paragraphFootnoteOriginalTextResults = [];
      const paragraphFootnoteOriginalReferenceResults = [];
      const canMapComments = Boolean(
        comments
        && globalThis.Office?.context?.requirements?.isSetSupported?.('WordApi', '1.6')
      );
      const commentRangeData = [];
      const paragraphCommentPrefixes = Array.from(
        { length: paragraphs.items.length },
        () => []
      );

      for (const p of paragraphs.items) {
        p.load(canMapComments
          ? 'text,style,font,listString,leftIndent,uniqueLocalId'
          : 'text,style,font,listString,leftIndent');
        p.font.load('bold,italic,underline');

        if (reviewedVersion) {
          const reviewedText = p.getReviewedText(reviewedVersion);
          reviewedTextResults.push(reviewedText);
        } else {
          reviewedTextResults.push(null);
        }

        try {
          const pFootnotes = p.footnotes;
          pFootnotes.load('items/reference,items/body/paragraphs');
          paragraphFootnotesData.push(pFootnotes);
          paragraphFootnotePrefixes.push([]);
          paragraphFootnoteOoxmlResults.push([]);
          paragraphFootnoteOriginalTextResults.push([]);
          paragraphFootnoteOriginalReferenceResults.push([]);
        } catch (e) {
          paragraphFootnotesData.push(null);
          paragraphFootnotePrefixes.push([]);
          paragraphFootnoteOoxmlResults.push([]);
          paragraphFootnoteOriginalTextResults.push([]);
          paragraphFootnoteOriginalReferenceResults.push([]);
        }
      }

      if (canMapComments && comments.items.length > 0) {
        for (const comment of comments.items) {
          comment.load('content');
          const range = comment.getRange();
          range.load('text');
          const paragraph = range.paragraphs.getFirst();
          paragraph.load('uniqueLocalId');
          const reviewedRangeText = reviewedVersion
            ? range.getReviewedText(reviewedVersion)
            : null;
          commentRangeData.push({ comment, range, paragraph, reviewedRangeText });
        }
      }

      await context.sync();

      if (commentRangeData.length > 0) {
        const paragraphIndexes = new Map(
          paragraphs.items.map((paragraph, index) => [paragraph.uniqueLocalId, index])
        );
        for (const data of commentRangeData) {
          const paragraphIndex = paragraphIndexes.get(data.paragraph.uniqueLocalId);
          if (paragraphIndex === undefined) continue;

          const commentStart = data.range.getRange('Start');
          const prefixRange = paragraphs.items[paragraphIndex].getRange('Start').expandTo(commentStart);
          prefixRange.load('text');
          const reviewedText = reviewedVersion
            ? prefixRange.getReviewedText(reviewedVersion)
            : null;
          paragraphCommentPrefixes[paragraphIndex].push({
            comment: data.comment,
            range: data.range,
            reviewedRangeText: data.reviewedRangeText,
            prefixRange,
            reviewedText
          });
        }
      }

      for (let i = 0; i < paragraphFootnotesData.length; i++) {
        const pFootnotes = paragraphFootnotesData[i];
        if (pFootnotes && pFootnotes.items && pFootnotes.items.length > 0) {
          for (let j = 0; j < pFootnotes.items.length; j++) {
            const fn = pFootnotes.items[j];
            fn.reference.load('text');
            fn.body.load('text');
            paragraphFootnoteOoxmlResults[i].push(fn.body.getOoxml());
            paragraphFootnoteOriginalTextResults[i].push(
              revision_view === 'original'
                ? fn.body.getReviewedText(Word.ChangeTrackingVersion.original)
                : null
            );
            paragraphFootnoteOriginalReferenceResults[i].push(
              revision_view === 'original'
                ? fn.reference.getReviewedText(Word.ChangeTrackingVersion.original)
                : null
            );
            const referenceStart = fn.reference.getRange('Start');
            const prefixRange = paragraphs.items[i].getRange('Start').expandTo(referenceStart);
            prefixRange.load('text');
            const reviewedText = reviewedVersion
              ? prefixRange.getReviewedText(reviewedVersion)
              : null;
            paragraphFootnotePrefixes[i].push({ range: prefixRange, reviewedText });
            if (fn.body.paragraphs && fn.body.paragraphs.items) {
              for (let k = 0; k < fn.body.paragraphs.items.length; k++) {
                const footnoteParagraph = fn.body.paragraphs.items[k];
                footnoteParagraph.load('text,font');
                footnoteParagraph.font.load('bold,italic,underline');
              }
            }
          }
        }
      }

      await context.sync();

      const paragraphsData = [];
      let nextFootnoteNumber = 1;

      for (let i = 0; i < paragraphs.items.length; i++) {
        const p = paragraphs.items[i];

        let text = '';
        if (reviewedVersion && reviewedTextResults[i]) {
          text = reviewedTextResults[i].value || '';
        } else {
          text = p.text || '';
        }

        if (text.charCodeAt(0) === 0xFEFF) {
          text = text.slice(1);
        }

        const references = [];
        const pFootnotes = paragraphFootnotesData[i];
        const paragraphFootnotes = [];
        if (pFootnotes && pFootnotes.items && pFootnotes.items.length > 0) {
          for (let j = 0; j < pFootnotes.items.length; j++) {
            const fn = pFootnotes.items[j];
            if (revision_view === 'original'
                && !paragraphFootnoteOriginalReferenceResults[i]?.[j]?.value) {
              continue;
            }
            const number = nextFootnoteNumber++;
            const originalFootnoteText = paragraphFootnoteOriginalTextResults[i]?.[j]?.value;
            const blocks = revision_view === 'original'
              ? String(originalFootnoteText || '').split(/\r\n?|\n/).map((block) => block.trim()).filter(Boolean)
              : footnoteOoxmlToMarkdownBlocks(paragraphFootnoteOoxmlResults[i]?.[j]?.value);
            if (revision_view !== 'original' && blocks.length === 0 && fn.body.paragraphs && fn.body.paragraphs.items) {
              for (const para of fn.body.paragraphs.items) {
                const block = formatWordFootnoteParagraph(para);
                if (block) blocks.push(block);
              }
            }
            if (revision_view !== 'original' && blocks.length === 0 && fn.body.text?.trim()) {
              blocks.push(fn.body.text.trim());
            }

            const prefix = paragraphFootnotePrefixes[i]?.[j];
            const prefixText = (
              (reviewedVersion && prefix?.reviewedText)
                ? prefix.reviewedText.value
                : prefix?.range.text
            || '').replace(/^\uFEFF/, '');
            references.push({ offset: prefixText.length, number });
            paragraphFootnotes.push({ number, blocks });
          }
        }

        const inlineComments = paragraphCommentPrefixes[i].map((entry) => {
          const prefixText = (
            (reviewedVersion && entry.reviewedText)
              ? entry.reviewedText.value
              : entry.prefixRange.text
          || '').replace(/^\uFEFF/, '');
          const anchorText = (
            (reviewedVersion && entry.reviewedRangeText)
              ? entry.reviewedRangeText.value
              : entry.range.text
          ) || '';
          return {
            offset: prefixText.length,
            text: entry.comment.content || '',
            removeLength: anchorText === '\u200B' ? 1 : 0
          };
        });
        text = insertInlineAnnotations(text, references, inlineComments);

        const style = p.style || 'Normal';

        let listLevel = -1;
        if (p.listString && p.listString !== '') {
          listLevel = Math.floor((p.leftIndent || 0) / 36);
        }

        const runs = [{
          text: text,
          font: {
            bold: p.font.bold,
            italic: p.font.italic,
            underline: p.font.underline
          }
        }];

        paragraphsData.push({
          index: i,
          text: text,
          style: style,
          listLevel: listLevel,
          listString: p.listString || '',
          runs: runs,
          footnotes: paragraphFootnotes
        });
      }

      if (list_headings) {
        const result = formatHeadingsList(paragraphsData, readOptions);
        return await anonymizeResultIfNeeded(result);
      }

      if (heading) {
        const result = formatHeadingContent(paragraphsData, heading, readOptions);
        return await anonymizeResultIfNeeded(result);
      }

      if (parsedIndexes && parsedIndexes.length > 0) {
        const result = formatSpecificIndexes(paragraphsData, parsedIndexes, readOptions);
        return await anonymizeResultIfNeeded(result);
      }

      const result = formatFullDocument(paragraphsData, readOptions);
      return await anonymizeResultIfNeeded(result);

    } catch (error) {
      console.error('[read-doc] Error:', error);
      return `❌ Error reading document: ${error.message}`;
    }
  });
}

/**
 * Anonymize result before sending to LLM
 * Graceful degradation: returns original text if anonymizeText not available
 */
async function anonymizeResultIfNeeded(text) {
  const anonymizeFn = deps?.anonymizeText;
  
  if (anonymizeFn) {
    try {
      const anonymizedText = await anonymizeFn(text, 'anonymize');
      console.log('[read_doc] 🔒 Texte traité par anonymizeText avant envoi au LLM');
      return anonymizedText;
    } catch (error) {
      console.error('[read_doc] ❌ Erreur anonymisation:', error);
      return text; // Return original on error instead of throwing
    }
  }
  
  console.warn('[read_doc] ⚠️ anonymizeText not available - returning original text');
  return text;
}

function encodeMarkdownComment(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/-/g, '&#45;');
}

function decodeMarkdownComment(text) {
  return String(text || '')
    .replace(/&#45;/g, '-')
    .replace(/&#13;/g, '\r')
    .replace(/&#10;/g, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function insertInlineAnnotations(text, references = [], comments = []) {
  let output = text;
  const markers = [
    ...references.map((reference) => ({
      offset: reference.offset,
      marker: `[^${reference.number}]`,
      removeLength: 0
    })),
    ...comments.map((comment) => ({
      offset: comment.offset,
      marker: `<!-- ${encodeMarkdownComment(comment.text)} -->`,
      removeLength: comment.removeLength || 0
    }))
  ].sort((left, right) => (
    right.offset - left.offset
    || right.removeLength - left.removeLength
  ));

  for (const item of markers) {
    const offset = Math.max(0, Math.min(output.length, item.offset));
    const removeLength = Math.max(
      0,
      Math.min(output.length - offset, item.removeLength)
    );
    output = `${output.slice(0, offset)}${item.marker}${output.slice(offset + removeLength)}`;
  }
  return output;
}

function insertFootnoteReferences(text, references) {
  return insertInlineAnnotations(text, references, []);
}

function formatWordFootnoteParagraph(paragraph) {
  const text = (paragraph.text || '').trim();
  if (!text) return '';
  return applyRunFormatting([{
    text,
    font: {
      bold: paragraph.font?.bold,
      italic: paragraph.font?.italic,
      underline: paragraph.font?.underline
    }
  }]);
}

function formatFootnoteDefinition(footnote) {
  const blocks = Array.isArray(footnote.blocks) ? footnote.blocks.filter(Boolean) : [];
  if (blocks.length === 0) return `[^${footnote.number}]:`;

  const firstLines = blocks[0].split('\n');
  const lines = [`[^${footnote.number}]: ${firstLines[0]}`];
  for (const line of firstLines.slice(1)) lines.push(`    ${line}`);

  for (const block of blocks.slice(1)) {
    lines.push('');
    for (const line of block.split('\n')) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

function removeFootnoteReferences(text) {
  return text.replace(/\[\^\d+\]/g, '');
}

function formatHeadingsList(paragraphsData, options = {}) {
  const headings = paragraphsData.filter(p => {
    const style = p.style || '';
    return style === 'Title' || style.startsWith('Title,') ||
           style.match(/^Heading\s+[1-4](?:,|$)/);
  });

  if (headings.length === 0) {
    return '📋 Document Structure:\n\n(No headings found)';
  }

  const entries = [];

  for (const h of headings) {
    let level = 0;
    if (h.style === 'Title' || h.style.startsWith('Title,')) {
      level = 0;
    } else {
      const match = h.style.match(/^Heading\s+(\d+)(?:,|$)/);
      level = match ? parseInt(match[1]) : 0;
    }

    const indent = '  '.repeat(level);
    const cleanText = removeFootnoteReferences(removeWordNumbering(h.text));

    const hashes = '#'.repeat(level + 1);
    const formattedHeading = `${hashes} ${cleanText}`;

    entries.push({
      index: h.index,
      prefix: `${indent}${h.index} -> `,
      content: formattedHeading
    });
  }

  const preface = '📋 Document Structure:\n\n';
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 100000;
  return `${preface}${formatIndexedEntries(entries, {
    ...options,
    maxChars: Math.max(1, maxChars - preface.length)
  })}`;
}

function formatHeadingContent(paragraphsData, headingQuery, options = {}) {
  let targetIndex = -1;
  let targetLevel = -1;

  if (/^\d+$/.test(headingQuery)) {
    targetIndex = parseInt(headingQuery);
  } else {
    const hashMatch = headingQuery.match(/^(#{1,11})\s*(.+?)$/);
    if (hashMatch) {
      const level = hashMatch[1].length - 1;
      const title = hashMatch[2].trim().toLowerCase();

      for (const p of paragraphsData) {
        let matchesStyle = false;
        if (level === 0) {
          matchesStyle = p.style === 'Title' || p.style.startsWith('Title,');
        } else {
          matchesStyle = p.style === `Heading ${level}` || p.style.startsWith(`Heading ${level},`);
        }

        if (matchesStyle) {
          const cleanText = removeWordNumbering(p.text).toLowerCase();
          if (cleanText.includes(title) || title.includes(cleanText)) {
            targetIndex = p.index;
            targetLevel = level;
            break;
          }
        }
      }
    } else {
      const legacyMatch = headingQuery.match(/^Heading\s+(\d+):\s*(.*)$/i);
      if (legacyMatch) {
        const level = parseInt(legacyMatch[1]);
        const title = legacyMatch[2].trim().toLowerCase();

        for (const p of paragraphsData) {
          const matchesStyle = p.style === `Heading ${level}` || p.style.startsWith(`Heading ${level},`);
          if (matchesStyle) {
            const cleanText = removeWordNumbering(p.text).toLowerCase();
            if (cleanText.includes(title) || title.includes(cleanText)) {
              targetIndex = p.index;
              targetLevel = level;
              break;
            }
          }
        }
      } else {
        const searchText = headingQuery.trim().toLowerCase();

        for (const p of paragraphsData) {
          const isTitle = p.style === 'Title' || p.style.startsWith('Title,');
          const isHeading = p.style.match(/^Heading\s+\d+(?:,|$)/);

          if (isTitle || isHeading) {
            const cleanText = removeWordNumbering(p.text).toLowerCase();
            if (cleanText.includes(searchText) || searchText.includes(cleanText)) {
              targetIndex = p.index;
              if (isTitle) {
                targetLevel = 0;
              } else if (isHeading) {
                const levelMatch = p.style.match(/\d+/);
                targetLevel = levelMatch ? parseInt(levelMatch[0]) : -1;
              }
              break;
            }
          }
        }
      }
    }
  }

  if (targetIndex === -1) {
    return `❌ Heading not found: ${headingQuery}`;
  }

  if (targetLevel === -1) {
    const targetPara = paragraphsData.find(p => p.index === targetIndex);
    if (targetPara && targetPara.style.match(/Heading\s+(\d+)/)) {
      targetLevel = parseInt(targetPara.style.match(/\d+/)[0]);
    }
  }

  let endIndex = paragraphsData.length;

  for (let i = targetIndex + 1; i < paragraphsData.length; i++) {
    const p = paragraphsData[i];
    const match = p.style.match(/Heading\s+(\d+)/);

    if (match) {
      const level = parseInt(match[1]);
      if (level <= targetLevel) {
        endIndex = i;
        break;
      }
    } else if (p.style === 'Title') {
      endIndex = i;
      break;
    }
  }

  const contentRange = paragraphsData.slice(targetIndex, endIndex);

  return formatParagraphRange(contentRange, options);
}

function formatSpecificIndexes(paragraphsData, indexes, options = {}) {
  const selected = paragraphsData.filter(p => indexes.includes(p.index));

  if (selected.length === 0) {
    return `❌ No paragraphs found at indexes: ${indexes.join(', ')}`;
  }

  return formatParagraphRange(selected, { ...options, includeEmpty: true });
}

function formatFullDocument(paragraphsData, options = {}) {
  return formatParagraphRange(paragraphsData, options);
}

function formatParagraphRange(paragraphsData, options = {}) {
  const entries = [];

  for (const para of paragraphsData) {
    const text = para.text.trim();

    if (!text) {
      if (options.includeEmpty) {
        entries.push({ index: para.index, content: '' });
      }
      continue;
    }

    const isPageBreak = text === '\f' || text === '\x0C';

    if (isPageBreak) {
      entries.push({ index: para.index, content: '[^page_break]' });
      continue;
    }

    const mdText = convertParagraphToMarkdown(para);
    const footnoteDefinitions = (para.footnotes || []).map(formatFootnoteDefinition);
    entries.push({
      index: para.index,
      content: footnoteDefinitions.length > 0
        ? `${mdText}\n\n${footnoteDefinitions.join('\n\n')}`
        : mdText,
      atomic: footnoteDefinitions.length > 0
    });
  }

  return formatIndexedEntries(entries, options);
}

/**
 * Cap every read response while keeping paragraph indexes stable. If a single
 * paragraph is longer than the cap, from_offset resumes inside that paragraph.
 */
function formatIndexedEntries(entries, options = {}) {
  const fromIndex = Number.isInteger(options.fromIndex) ? options.fromIndex : 0;
  const fromOffset = Number.isInteger(options.fromOffset) ? options.fromOffset : 0;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : 100000;
  const contentBudget = Math.max(1, maxChars - 100);
  let output = '';
  let cursor = null;

  for (const entry of entries) {
    if (entry.index < fromIndex) continue;

    const offset = entry.index === fromIndex ? fromOffset : 0;
    const content = entry.content || '';
    if (offset > content.length) continue;

    const prefix = entry.prefix || `${entry.index} -> `;
    if (entry.atomic && offset > 0) {
      return `❌ from_offset cannot resume inside paragraph ${entry.index}, because it contains footnotes. Resume with read_doc({"from_index":${entry.index}}).`;
    }

    const remaining = content.slice(offset);
    const line = `${prefix}${remaining}\n`;

    if (output.length + line.length <= contentBudget) {
      output += line;
      continue;
    }

    if (output.length === 0 && entry.atomic) {
      return `❌ Paragraph ${entry.index} and its footnotes exceed max_chars (${maxChars}). Read a smaller indexed selection or shorten the footnote.`;
    }

    if (output.length === 0) {
      const available = Math.max(1, contentBudget - prefix.length - 1);
      output = `${prefix}${remaining.slice(0, available)}`;
      cursor = {
        from_index: entry.index,
        from_offset: offset + Math.min(available, remaining.length)
      };
    } else {
      cursor = { from_index: entry.index };
      if (offset > 0) cursor.from_offset = offset;
    }
    break;
  }

  if (cursor) {
    output += `\n[TRUNCATED] Continue with read_doc(${JSON.stringify(cursor)})`;
  }

  return output || '(No matching paragraphs)';
}

function convertParagraphToMarkdown(para) {
  let text = para.text.trim();
  const style = para.style || 'Normal';

  if (style === 'Title' || style.startsWith('Title,')) {
    const cleanText = removeWordNumbering(text);
    return `# ${cleanText}`;
  }

  const headingMatch = style.match(/^Heading\s+(\d+)(?:,|$)/);
  if (headingMatch) {
    const level = parseInt(headingMatch[1]);
    const hashes = '#'.repeat(level + 1);
    const cleanText = removeWordNumbering(text);
    return `${hashes} ${cleanText}`;
  }

  if (para.listString && para.listString !== '') {
    const level = para.listLevel >= 0 ? para.listLevel : 0;
    const indent = '  '.repeat(level);
    const cleanText = removeWordNumbering(text);
    return `${indent}- ${cleanText}`;
  }

  if (para.runs && para.runs.length > 1) {
    return applyRunFormatting(para.runs);
  }

  return text;
}

function applyRunFormatting(runs) {
  let result = '';

  for (const run of runs) {
    let text = run.text;

    if (!text) continue;

    const isBold = run.font?.bold === true;
    const isItalic = run.font?.italic === true;
    const isUnderline = run.font?.underline && run.font.underline !== 'None';

    if (isBold && isItalic) {
      text = `***${text}***`;
    } else if (isBold) {
      text = `**${text}**`;
    } else if (isItalic) {
      text = `*${text}*`;
    }

    if (isUnderline && !isBold && !isItalic) {
      text = `<u>${text}</u>`;
    }

    result += text;
  }

  return result;
}

function removeWordNumbering(text) {
  const patterns = [
    /^[IVXLCDM]+\.\s+/,
    /^[IVXLCDM]+\)\s+/,
    /^\d+\.\s+/,
    /^\d+\)\s+/,
    /^[a-z]\.\s+/i,
    /^[a-z]\)\s+/i,
    /^[•\-\*]\s+/,
    /^§\s*\d+\.?\s+/,
    /^Article\s+\d+\.?\s+/i
  ];

  let cleanText = text;
  for (const pattern of patterns) {
    cleanText = cleanText.replace(pattern, '');
  }

  return cleanText;
}

/**
 * TOOL: edit-doc
 *
 * Edit Word document with index-based targeting
 *
 * Operations:
 * - insert_before / insert_after: Insert text before/after target index
 * - replace: Replace placeholder with content (targets placeholder, not just index)
 * - delete: Delete lines at target indexes
 *
 * @param {Object} params - Tool parameters
 * @returns {Object} - Result with success/error and guideline info
 */
export async function editDoc(params = {}) {
  if (params.review && typeof params.review === 'object') {
    const result = await reviewRevisions(params.review);
    if (result?.success && ['accept', 'reject'].includes(result.action)) docReadBeforeEdit = false;
    return result;
  }

  if (!Array.isArray(params.edits)) {
    return editDocSingle(params);
  }

  const prepared = prepareBatchEdits(params.edits);
  if (prepared.error) return { error: prepared.error };

  let paragraphCount;
  try {
    paragraphCount = await Word.run(async (context) => {
      const paragraphs = context.document.body.paragraphs;
      paragraphs.load('items');
      await context.sync();
      return paragraphs.items.length;
    });
  } catch (error) {
    return { error: `Unable to validate batch indexes: ${error.message}` };
  }

  const invalid = prepared.edits.find((edit) => edit.anchor >= paragraphCount);
  if (invalid) {
    return { error: `Invalid index: ${invalid.anchor} (document has ${paragraphCount} paragraphs)` };
  }

  const changes = [];
  for (const edit of prepared.edits) {
    const { anchor, ...singleEdit } = edit;
    singleEdit.track_changes = params.track_changes !== false;
    const result = await editDocSingle(singleEdit);

    if (!result?.success) {
      return {
        error: result?.error || 'Batch edit failed',
        edits_applied: changes.length,
        partial: changes.length > 0,
        changes
      };
    }

    const receipt = { operation: singleEdit.operation };
    if (singleEdit.target_index !== undefined) receipt.target_index = singleEdit.target_index;
    if (result.inserted_indexes) receipt.inserted_indexes = result.inserted_indexes;
    if (result.deleted_indexes) receipt.deleted_indexes = result.deleted_indexes;
    if (result.placeholders?.length) receipt.placeholders = result.placeholders;
    changes.push(receipt);
  }

  return {
    success: true,
    edits_applied: changes.length,
    changes
  };
}

function prepareBatchEdits(edits) {
  if (edits.length === 0 || edits.length > 50) {
    return { error: 'edits must contain between 1 and 50 operations' };
  }

  const prepared = [];
  const insertedAt = new Set();
  const deletedAt = new Set();

  for (let position = 0; position < edits.length; position++) {
    const edit = edits[position];
    if (!edit || typeof edit !== 'object') {
      return { error: `edits[${position}] must be an object` };
    }

    if (edit.operation === 'insert_before' || edit.operation === 'insert_after') {
      if (!Number.isInteger(edit.target_index) || edit.target_index < 0) {
        return { error: `edits[${position}].target_index must be a non-negative integer` };
      }
      if (typeof edit.text !== 'string' || edit.text.length === 0) {
        return { error: `edits[${position}].text must be a non-empty string` };
      }
      if (insertedAt.has(edit.target_index)) {
        return { error: `Only one insertion is allowed at index ${edit.target_index}; combine its text with \\n` };
      }

      insertedAt.add(edit.target_index);
      prepared.push({
        operation: edit.operation,
        target_index: edit.target_index,
        text: edit.text,
        anchor: edit.target_index
      });
      continue;
    }

    if (edit.operation === 'delete') {
      if (!Array.isArray(edit.indexes_to_delete) || edit.indexes_to_delete.length === 0) {
        return { error: `edits[${position}].indexes_to_delete must be a non-empty array` };
      }

      for (const index of edit.indexes_to_delete) {
        if (!Number.isInteger(index) || index < 0) {
          return { error: `edits[${position}] contains an invalid delete index` };
        }
        if (deletedAt.has(index)) {
          return { error: `Duplicate delete index: ${index}` };
        }
        deletedAt.add(index);
        prepared.push({ operation: 'delete', indexes_to_delete: [index], anchor: index });
      }
      continue;
    }

    return { error: `edits[${position}].operation is invalid` };
  }

  for (const index of insertedAt) {
    if (deletedAt.has(index)) {
      return { error: `Index ${index} cannot be both an insertion target and deleted in the same batch` };
    }
  }

  if (prepared.length > 50) {
    return { error: 'A batch cannot modify more than 50 paragraph indexes' };
  }

  prepared.sort((left, right) => right.anchor - left.anchor);
  return { edits: prepared };
}

async function editDocSingle(params = {}) {
  const {
    operation = null,
    target_index = null,
    placeholder = null,
    text = '',
    indexes_to_delete = null,
    skip_footnote_validation = false,
    track_changes = true
  } = params;

  const anonymizeFn = deps?.anonymizeText;
  
  const validOps = ['insert_before', 'insert_after', 'replace', 'delete'];
  if (!operation || !validOps.includes(operation)) {
    return {
      error: `Invalid operation. Must be one of: ${validOps.join(', ')}`
    };
  }

  let deanonymizedText = text;
  if (text && anonymizeFn) {
    try {
      deanonymizedText = await anonymizeFn(text, 'deanonymize');
      console.log('[edit_doc] 🔓 Texte dé-anonymisé');
    } catch (error) {
      console.warn('[edit_doc] ⚠️ Erreur lors de la désanonymisation:', error);
    }
  }

  let preparedMarkdown = null;
  if (operation !== 'delete') {
    try {
      preparedMarkdown = prepareMarkdownFootnotes(deanonymizedText.replace(/\\n/g, '\n'));
      if (preparedMarkdown.legacySyntaxUsed) {
        console.warn('[edit_doc] Syntaxe de note PieceMaker historique acceptée puis normalisée.');
      }
    } catch (error) {
      return { error: `Invalid Markdown footnotes: ${error.message}` };
    }
  }

  return await Word.run(async (context) => {
    let previousTrackingMode = null;
    let trackingModeWasLoaded = false;
    try {
      const body = context.document.body;
      const paragraphs = body.paragraphs;
      context.document.load('changeTrackingMode');
      paragraphs.load('items');

      await context.sync();
      previousTrackingMode = context.document.changeTrackingMode;
      trackingModeWasLoaded = true;
      context.document.changeTrackingMode = track_changes === false
        ? Word.ChangeTrackingMode.off
        : Word.ChangeTrackingMode.trackAll;
      await context.sync();

      if (operation === 'delete') {
        if (!indexes_to_delete || !Array.isArray(indexes_to_delete)) {
          return { error: 'indexes_to_delete must be an array of numbers' };
        }

        for (const idx of indexes_to_delete) {
          if (idx < 0 || idx >= paragraphs.items.length) {
            return { error: `Invalid index: ${idx}` };
          }
          const p = paragraphs.items[idx];
          p.delete();
        }

        await context.sync();

        docReadBeforeEdit = false;

        return {
          success: true,
          message: `✅ Deleted ${indexes_to_delete.length} line(s)`,
          deleted_indexes: indexes_to_delete
        };
      }

      if (operation === 'replace') {
        if (!skip_footnote_validation) {
          return {
            error: 'L\'opération "replace" n\'est accessible que via l\'outil draft. Utilisez insert_before, insert_after ou delete pour edit_doc.'
          };
        }

        if (!placeholder) {
          return {
            error: 'Replace operation requires a "placeholder" parameter (e.g., "FAITS", not an index)'
          };
        }

        for (let i = 0; i < paragraphs.items.length; i++) {
          paragraphs.items[i].load('text');
        }
        await context.sync();

        const searchPattern = `{{${placeholder}}}`;
        let foundIndex = -1;

        for (let i = 0; i < paragraphs.items.length; i++) {
          if (paragraphs.items[i].text.includes(searchPattern)) {
            foundIndex = i;
            break;
          }
        }

        if (foundIndex === -1) {
          return {
            error: `Placeholder {{${placeholder}}} not found in document`
          };
        }

        const normalizedText = preparedMarkdown.markdown;
        console.log('[REPLACE] 📝 Texte normalisé (longueur:', normalizedText.length, '):', JSON.stringify(normalizedText.substring(0, 200)));

        const trimmedText = normalizedText.replace(/\n+$/, '');
        console.log('[REPLACE] ✂️ Texte après trim (longueur:', trimmedText.length, '):', JSON.stringify(trimmedText.substring(0, 200)));

        const lines = trimmedText.split('\n');
        console.log('[REPLACE] 📊 Nombre de lignes après split:', lines.length);
        console.log('[REPLACE] 📋 Détail des lignes:', lines.map((l, i) => `[${i}]: "${l.substring(0, 50)}${l.length > 50 ? '...' : ''}" (longueur: ${l.length})`));

        const nonEmptyLines = lines.filter(line => line.trim() !== '');
        console.log('[REPLACE] 🔍 Lignes non-vides après filtrage:', nonEmptyLines.length, '(', lines.length - nonEmptyLines.length, 'lignes vides supprimées)');

        const processedParagraphs = [];

        for (const line of nonEmptyLines) {
          const formatted = markdownLineToWordFormat(line, preparedMarkdown.footnotes);
          processedParagraphs.push(formatted);
        }

        console.log('[REPLACE] 📦 Nombre de paragraphes traités:', processedParagraphs.length);

        const targetPara = paragraphs.items[foundIndex];
        const insertRange = foundIndex > 0
          ? paragraphs.items[foundIndex - 1].getRange('End')
          : body.getRange('Start');

        targetPara.delete();

        for (let i = 0; i < processedParagraphs.length; i++) {
          const wpara = processedParagraphs[i];
          console.log(`[REPLACE] 🔨 Insertion paragraphe ${i}/${processedParagraphs.length}:`, {
            style: wpara.style,
            isList: wpara.isList,
            isPageBreak: wpara.isPageBreak,
            segmentsCount: wpara.segments?.length || 0,
            firstSegmentText: wpara.segments?.[0]?.text?.substring(0, 50) || '(vide)'
          });

          if (wpara.isPageBreak) {
            insertRange.insertBreak(Word.BreakType.page, 'After');
            console.log(`[REPLACE] ⏸️ Page break inséré à l'index ${i}`);
            continue;
          }

          const newPara = insertRange.insertParagraph('', 'After');
          newPara.styleBuiltIn = getWordStyle(wpara.style);
          console.log(`[REPLACE] ✅ Paragraphe ${i} créé avec style:`, wpara.style);

          if (wpara.isList) {
            const listLevel = wpara.listLevel || 0;
            newPara.listItemOrNullObject.level = listLevel;
          }

          let insertionPoint = newPara.getRange('Start');

          for (const segment of wpara.segments) {
            if (!segment.text && !segment.isFootnote && !segment.isComment && !segment.isCrossRef && !segment.isPageBreak) {
              continue;
            }

            if (segment.isPageBreak) {
              insertionPoint.insertBreak(Word.BreakType.page, 'End');
              insertionPoint = newPara.getRange('End');
              continue;
            }

            if (segment.isFootnote && wpara.footnotes && wpara.footnotes[segment.footnoteIndex]) {
              const footnoteData = wpara.footnotes[segment.footnoteIndex];
              insertWordFootnote(insertionPoint, footnoteData);
              insertionPoint = newPara.getRange('End');
              continue;
            }

            if (segment.isComment && wpara.comments && wpara.comments[segment.commentIndex]) {
              const commentText = wpara.comments[segment.commentIndex].text;
              try {
                const commentRange = insertionPoint.insertText('\u200B', 'End');
                commentRange.insertComment(commentText);
              } catch (e) {
                console.warn('Comments not supported, skipping:', e.message);
              }
              insertionPoint = newPara.getRange('End');
              continue;
            }

            if (segment.isCrossRef && wpara.crossRefs && wpara.crossRefs[segment.crossRefIndex]) {
              const crossRef = wpara.crossRefs[segment.crossRefIndex];
              const crRange = insertionPoint.insertText(segment.text, 'End');
              crRange.font.underline = Word.UnderlineType.single;
              crRange.font.color = '#0000FF';
              insertionPoint = newPara.getRange('End');
              continue;
            }

            console.log('[insertText] Inserting segment:', segment);
            const segmentRange = insertionPoint.insertText(segment.text, 'End');

            segmentRange.font.bold = segment.bold === true;
            segmentRange.font.italic = segment.italic === true;
            segmentRange.font.underline = segment.underline === true ? Word.UnderlineType.single : Word.UnderlineType.none;
            if (segment.hyperlink) segmentRange.hyperlink = segment.hyperlink;

            console.log('[insertText] Applied formatting:', {
              text: segment.text,
              bold: segmentRange.font.bold,
              italic: segmentRange.font.italic,
              underline: segment.underline
            });

            insertionPoint = newPara.getRange('End');
          }
        }

        await context.sync();

        docReadBeforeEdit = false;

        const guideline = await checkPlaceholderGuideline(placeholder);

        return {
          success: true,
          message: `✅ Replaced {{${placeholder}}} with ${processedParagraphs.length} paragraph(s)`,
          placeholder: placeholder,
          replaced_at_index: foundIndex,
          guideline: guideline
        };
      }

      if (target_index === null || target_index < 0 || target_index >= paragraphs.items.length) {
        return { error: `Invalid target_index: ${target_index}` };
      }

      const targetPara = paragraphs.items[target_index];

      const normalizedText = preparedMarkdown.markdown;
      console.log('[INSERT] 📝 Texte normalisé (longueur:', normalizedText.length, '):', JSON.stringify(normalizedText.substring(0, 200)));

      const trimmedText = normalizedText.replace(/\n+$/, '');
      console.log('[INSERT] ✂️ Texte après trim (longueur:', trimmedText.length, '):', JSON.stringify(trimmedText.substring(0, 200)));

      const lines = trimmedText.split('\n');
      console.log('[INSERT] 📊 Nombre de lignes après split:', lines.length);
      console.log('[INSERT] 📋 Détail des lignes:', lines.map((l, i) => `[${i}]: "${l.substring(0, 50)}${l.length > 50 ? '...' : ''}" (longueur: ${l.length})`));

      const nonEmptyLines = lines.filter(line => line.trim() !== '');
      console.log('[INSERT] 🔍 Lignes non-vides après filtrage:', nonEmptyLines.length, '(', lines.length - nonEmptyLines.length, 'lignes vides supprimées)');

      const processedParagraphs = [];

      for (const line of nonEmptyLines) {
        const formatted = markdownLineToWordFormat(line, preparedMarkdown.footnotes);
        processedParagraphs.push(formatted);
      }

      console.log('[INSERT] 📦 Nombre de paragraphes traités:', processedParagraphs.length);

      const insertPosition = operation === 'insert_before' ? 'Before' : 'After';
      const insertRange = targetPara.getRange(insertPosition === 'Before' ? 'Start' : 'End');

      const insertedIndexes = [];

      for (let i = 0; i < processedParagraphs.length; i++) {
        const wpara = processedParagraphs[i];
        console.log(`[INSERT] 🔨 Insertion paragraphe ${i}/${processedParagraphs.length}:`, {
          operation: operation,
          style: wpara.style,
          isList: wpara.isList,
          isPageBreak: wpara.isPageBreak,
          segmentsCount: wpara.segments?.length || 0,
          firstSegmentText: wpara.segments?.[0]?.text?.substring(0, 50) || '(vide)'
        });

        if (wpara.isPageBreak) {
          insertRange.insertBreak(Word.BreakType.page, insertPosition);
          const insertedIdx = operation === 'insert_before' ? target_index + i : target_index + i + 1;
          insertedIndexes.push(insertedIdx);
          console.log(`[INSERT] ⏸️ Page break inséré à l'index ${i}, position:`, insertPosition);
          continue;
        }

        const newPara = insertRange.insertParagraph('', insertPosition);
        newPara.styleBuiltIn = getWordStyle(wpara.style);
        console.log(`[INSERT] ✅ Paragraphe ${i} créé avec style:`, wpara.style, 'position:', insertPosition);

        if (wpara.isList) {
          const listLevel = wpara.listLevel || 0;
          newPara.listItemOrNullObject.level = listLevel;
        }

        let insertionPoint = newPara.getRange('Start');

        for (const segment of wpara.segments) {
          if (!segment.text && !segment.isFootnote && !segment.isComment && !segment.isCrossRef && !segment.isPageBreak) {
            continue;
          }

          if (segment.isPageBreak) {
            insertionPoint.insertBreak(Word.BreakType.page, 'End');
            insertionPoint = newPara.getRange('End');
            continue;
          }

          if (segment.isFootnote && wpara.footnotes && wpara.footnotes[segment.footnoteIndex]) {
            const footnoteData = wpara.footnotes[segment.footnoteIndex];
            insertWordFootnote(insertionPoint, footnoteData);
            insertionPoint = newPara.getRange('End');
            continue;
          }

          if (segment.isComment && wpara.comments && wpara.comments[segment.commentIndex]) {
            const commentText = wpara.comments[segment.commentIndex].text;
            try {
              const commentRange = insertionPoint.insertText('\u200B', 'End');
              commentRange.insertComment(commentText);
            } catch (e) {
              console.warn('Comments not supported, skipping:', e.message);
            }
            insertionPoint = newPara.getRange('End');
            continue;
          }

          if (segment.isCrossRef && wpara.crossRefs && wpara.crossRefs[segment.crossRefIndex]) {
            const crossRef = wpara.crossRefs[segment.crossRefIndex];
            const crRange = insertionPoint.insertText(segment.text, 'End');
            crRange.font.underline = Word.UnderlineType.single;
            crRange.font.color = '#0000FF';
            insertionPoint = newPara.getRange('End');
            continue;
          }

          console.log('[insertText] Inserting segment:', segment);
          const segmentRange = insertionPoint.insertText(segment.text, 'End');

          segmentRange.font.bold = segment.bold === true;
          segmentRange.font.italic = segment.italic === true;
          segmentRange.font.underline = segment.underline === true ? Word.UnderlineType.single : Word.UnderlineType.none;
          if (segment.hyperlink) segmentRange.hyperlink = segment.hyperlink;

          console.log('[insertText] Applied formatting:', {
            text: segment.text,
            bold: segmentRange.font.bold,
            italic: segmentRange.font.italic,
            underline: segment.underline
          });

          insertionPoint = newPara.getRange('End');
        }

        const insertedIdx = operation === 'insert_before' ? target_index + i : target_index + i + 1;
        insertedIndexes.push(insertedIdx);
      }

      await context.sync();

      docReadBeforeEdit = false;

      const placeholders = extractPlaceholders(text);
      const guidelines = {};

      if (placeholders.length > 0) {
        for (const ph of placeholders) {
          const guideline = await checkPlaceholderGuideline(ph);
          if (guideline) {
            guidelines[ph] = guideline;
          }
        }

        await savePlaceholdersToLibrary(placeholders);
      }

      return {
        success: true,
        message: `✅ Inserted ${processedParagraphs.length} paragraph(s) ${operation.replace('_', ' ')} index ${target_index}`,
        operation: operation,
        target_index: target_index,
        inserted_indexes: insertedIndexes,
        placeholders: placeholders,
        guidelines: Object.keys(guidelines).length > 0 ? guidelines : undefined
      };

    } catch (error) {
      console.error('[edit-doc] Error:', error);

      return {
        error: `Edit failed: ${error.message}`
      };
    } finally {
      if (trackingModeWasLoaded && previousTrackingMode) {
        try {
          context.document.changeTrackingMode = previousTrackingMode;
          await context.sync();
        } catch (restoreError) {
          console.error('[edit-doc] Unable to restore change tracking mode:', restoreError);
        }
      }
    }
  });
}

function markdownLineToWordFormat(mdLine, footnoteDefinitions = []) {
  if (mdLine.trim() === '[^page_break]') {
    return {
      style: 'Normal',
      segments: [],
      isList: false,
      isPageBreak: true
    };
  }

  const headingMatch = mdLine.match(/^(#{1,11})\s*(.+?)\s*(#{1,11})?$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    let rawText = headingMatch[2].trim();

    let style = 'Normal';
    if (level === 1) style = 'Title';
    else if (level >= 2 && level <= 11) style = `Heading ${level - 1}`;

    const parsed = parseMarkdownToSegments(rawText, footnoteDefinitions);

    return {
      style,
      segments: parsed.segments,
      isList: false,
      footnotes: parsed.footnotes,
      comments: parsed.comments,
      crossRefs: parsed.crossRefs
    };
  }

  const listMatch = mdLine.match(/^(\s*)([-*+•])\s+(.*)$/);
  if (listMatch) {
    const indentStr = listMatch[1];
    const rawText = listMatch[3].trim();

    const listLevel = Math.floor(indentStr.replace(/\t/g, '  ').length / 2);

    const parsed = parseMarkdownToSegments(rawText, footnoteDefinitions);

    return {
      style: 'Normal',
      segments: parsed.segments,
      isList: true,
      listLevel: listLevel,
      footnotes: parsed.footnotes,
      comments: parsed.comments,
      crossRefs: parsed.crossRefs
    };
  }

  const parsed = parseMarkdownToSegments(mdLine, footnoteDefinitions);

  return {
    style: 'Normal',
    segments: parsed.segments,
    isList: false,
    footnotes: parsed.footnotes,
    comments: parsed.comments,
    crossRefs: parsed.crossRefs
  };
}

function prepareFootnoteForWord(footnote) {
  const paragraphs = [];
  for (const block of footnote.blocks || []) {
    const blockLines = block.split('\n').filter((line) => line.trim() !== '');
    for (const line of blockLines) {
      const formatted = markdownLineToWordFormat(line, []);
      paragraphs.push({ segments: formatted.segments || [] });
    }
  }
  return {
    identifier: footnote.identifier,
    label: footnote.label,
    paragraphs,
    // Compatibilité avec l'ancien chemin d'insertion et son texte de repli.
    segments: paragraphs[0]?.segments || []
  };
}

function insertWordFootnote(insertionPoint, footnoteData) {
  const footnoteRange = insertionPoint.insertText('', 'End');
  const plainText = (footnoteData.paragraphs || [])
    .map((paragraph) => (paragraph.segments || []).map((segment) => segment.text || '').join(''))
    .join('\n\n');

  try {
    const footnote = footnoteRange.insertFootnote('');
    const footnoteBody = footnote.body;
    const paragraphs = footnoteData.paragraphs?.length > 0
      ? footnoteData.paragraphs
      : [{ segments: footnoteData.segments || [] }];

    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
      const paragraphData = paragraphs[paragraphIndex];
      const targetParagraph = paragraphIndex === 0
        ? null
        : footnoteBody.insertParagraph('', 'End');
      let insertPoint = targetParagraph
        ? targetParagraph.getRange('Start')
        : footnoteBody.getRange('Start');

      for (const segment of paragraphData.segments || []) {
        if (!segment.text) continue;
        const segmentRange = insertPoint.insertText(segment.text, 'End');
        segmentRange.font.bold = segment.bold === true;
        segmentRange.font.italic = segment.italic === true;
        segmentRange.font.underline = segment.underline === true
          ? Word.UnderlineType.single
          : Word.UnderlineType.none;
        if (segment.hyperlink) segmentRange.hyperlink = segment.hyperlink;
        insertPoint = targetParagraph
          ? targetParagraph.getRange('End')
          : footnoteBody.getRange('End');
      }
    }
  } catch (error) {
    console.warn('Footnotes not supported, inserting readable fallback:', error.message);
    insertionPoint.insertText(` [${plainText}]`, 'End');
  }
}

function parseMarkdownToSegments(markdown, footnoteDefinitions = []) {
  const segments = [];
  const footnotes = [];
  const comments = [];
  const crossRefs = [];
  const links = [];

  let processedText = markdown;
  let footnoteIndex = 0;
  let commentIndex = 0;
  let crossRefIndex = 0;
  let linkIndex = 0;

  FOOTNOTE_TOKEN_PATTERN.lastIndex = 0;
  processedText = processedText.replace(FOOTNOTE_TOKEN_PATTERN, (_match, occurrence, offset) => {
    const definition = footnoteDefinitions[Number(occurrence)];
    if (!definition) return _match;
    footnotes.push({ ...prepareFootnoteForWord(definition), position: offset });
    return `__FOOTNOTE_${footnoteIndex++}__`;
  });

  processedText = processedText.replace(/<!--\s*((?:(?!-->)[\s\S])*?)\s*-->/g, (match, text, offset) => {
    comments.push({ text: decodeMarkdownComment(text.trim()), position: offset });
    return `__COMMENT_${commentIndex++}__`;
  });

  processedText = processedText.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, text, url) => {
    links.push({ text, url });
    return `__LINK_${linkIndex++}__`;
  });

  processedText = processedText.replace(/\[([^\]]+?)\s*\+\s*(\d+)\]/g, (match, title, index, offset) => {
    crossRefs.push({ title: title.trim(), index: parseInt(index), position: offset });
    return `__CROSSREF_${crossRefIndex++}__`;
  });

  const pageBreaks = [];
  let pageBreakIndex = 0;
  processedText = processedText.replace(/\[\^page_break\]/g, () => {
    pageBreaks.push(true);
    return `__PAGEBREAK_${pageBreakIndex++}__`;
  });

  const underlines = [];
  let underlineIndex = 0;
  processedText = processedText.replace(/<u>([^<]+)<\/u>/g, (match, text) => {
    underlines.push(text);
    return `__UNDERLINE_${underlineIndex++}__`;
  });

  const underscoreItalics = [];
  let underscoreIndex = 0;
  processedText = processedText.replace(/(?<!_)_([^_]+)_(?!_)/g, (match, text) => {
    underscoreItalics.push(text);
    return `__USITALIC_${underscoreIndex++}__`;
  });

  // Les marqueurs techniques peuvent se trouver à l'intérieur d'un segment
  // Markdown formaté (par exemple **texte[^n]**). Déplier récursivement ces
  // marqueurs évite de les insérer comme texte littéral dans Word.
  function appendDecoratedSegments(value, inherited = {}) {
    const markerPattern = /__(FOOTNOTE|COMMENT|CROSSREF|LINK|PAGEBREAK|USITALIC|UNDERLINE)_(\d+)__/g;
    let lastMarkerEnd = 0;
    let markerMatch;

    const appendText = (text, formatting = inherited) => {
      if (!text) return;
      const segment = {
        text,
        bold: formatting.bold === true,
        italic: formatting.italic === true,
        underline: formatting.underline === true
      };
      if (formatting.hyperlink) segment.hyperlink = formatting.hyperlink;
      segments.push(segment);
    };

    while ((markerMatch = markerPattern.exec(value)) !== null) {
      appendText(value.substring(lastMarkerEnd, markerMatch.index));

      const kind = markerMatch[1];
      const markerIndex = Number(markerMatch[2]);
      if (kind === 'FOOTNOTE') {
        segments.push({
          text: '',
          bold: false,
          italic: false,
          underline: false,
          isFootnote: true,
          footnoteIndex: markerIndex
        });
      } else if (kind === 'COMMENT') {
        segments.push({
          text: '',
          bold: false,
          italic: false,
          underline: false,
          isComment: true,
          commentIndex: markerIndex
        });
      } else if (kind === 'CROSSREF') {
        const crossRef = crossRefs[markerIndex];
        if (crossRef) {
          segments.push({
            text: `${crossRef.title} ${crossRef.index}`,
            bold: inherited.bold === true,
            italic: inherited.italic === true,
            underline: true,
            isCrossRef: true,
            crossRefIndex: markerIndex
          });
        }
      } else if (kind === 'LINK') {
        const link = links[markerIndex];
        if (link) {
          appendDecoratedSegments(link.text, { ...inherited, hyperlink: link.url });
        }
      } else if (kind === 'PAGEBREAK') {
        segments.push({
          text: '',
          bold: false,
          italic: false,
          underline: false,
          isPageBreak: true
        });
      } else if (kind === 'USITALIC') {
        appendDecoratedSegments(
          underscoreItalics[markerIndex] || '',
          { ...inherited, italic: true }
        );
      } else if (kind === 'UNDERLINE') {
        appendDecoratedSegments(
          underlines[markerIndex] || '',
          { ...inherited, underline: true }
        );
      }

      lastMarkerEnd = markerPattern.lastIndex;
    }

    appendText(value.substring(lastMarkerEnd));
  }

  const pattern = /(\*\*\*([^\*]+)\*\*\*|\*\*([^\*]+)\*\*|\*([^\*]+)\*|__USITALIC_\d+__|__UNDERLINE_\d+__|__PAGEBREAK_\d+__|__FOOTNOTE_\d+__|__COMMENT_\d+__|__CROSSREF_\d+__|__LINK_\d+__)/g;

  console.log('[parseMarkdownToSegments] Input:', markdown);
  console.log('[parseMarkdownToSegments] After preprocessing:', processedText);

  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(processedText)) !== null) {
    console.log('[parseMarkdownToSegments] Match:', {
      full: match[0],
      index: match.index,
      lastIndex: pattern.lastIndex,
      group2: match[2],
      group3: match[3],
      group4: match[4],
      group5: match[5]
    });
    if (match.index > lastIndex) {
      const plainText = processedText.substring(lastIndex, match.index);
      appendDecoratedSegments(plainText);
    }

    if (match[0].startsWith('__')) {
      appendDecoratedSegments(match[0]);
    } else {
      let text = '';
      let bold = false;
      let italic = false;
      let underline = false;

      if (match[2]) {
        text = match[2];
        bold = true;
        italic = true;
      } else if (match[3]) {
        text = match[3];
        bold = true;
      } else if (match[4]) {
        text = match[4];
        italic = true;
      }

      appendDecoratedSegments(text, { bold, italic, underline });
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < processedText.length) {
    const remaining = processedText.substring(lastIndex);
    appendDecoratedSegments(remaining);
  }

  if (segments.length === 0) {
    segments.push({
      text: '',
      bold: false,
      italic: false,
      underline: false
    });
  }

  console.log('[parseMarkdownToSegments] Final segments:', segments);

  return {
    segments,
    footnotes,
    comments,
    crossRefs
  };
}

function getWordStyle(styleName) {
  const styleMap = {
    'Title': Word.BuiltInStyleName.title,
    'Heading 1': Word.BuiltInStyleName.heading1,
    'Heading 2': Word.BuiltInStyleName.heading2,
    'Heading 3': Word.BuiltInStyleName.heading3,
    'Heading 4': Word.BuiltInStyleName.heading4,
    'Heading 5': Word.BuiltInStyleName.heading5,
    'Heading 6': Word.BuiltInStyleName.heading6,
    'Heading 7': Word.BuiltInStyleName.heading7,
    'Heading 8': Word.BuiltInStyleName.heading8,
    'Heading 9': Word.BuiltInStyleName.heading9,
    'Normal': Word.BuiltInStyleName.normal
  };

  return styleMap[styleName] || Word.BuiltInStyleName.normal;
}

// Fonctions pures exposées uniquement pour les tests de conversion. Elles ne
// font pas partie du schéma des outils MCP et ne sont jamais envoyées au modèle.
export const __footnoteTestUtils = {
  decodeMarkdownComment,
  encodeMarkdownComment,
  formatFootnoteDefinition,
  formatIndexedEntries,
  formatParagraphRange,
  insertFootnoteReferences,
  insertInlineAnnotations,
  markdownLineToWordFormat,
  parseMarkdownToSegments
};

function extractPlaceholders(text) {
  const regex = /\{\{([A-Z_0-9]+)\}\}/g;
  const matches = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (!matches.includes(match[1])) {
      matches.push(match[1]);
    }
  }

  return matches;
}

async function checkPlaceholderGuideline(placeholderName) {
  try {
    const response = await fetch('https://localhost:43098/api/word/template-library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'get_guideline',
        placeholder: placeholderName
      })
    });

    const data = await response.json();

    if (data.guideline) {
      return data.guideline;
    }

    const baseMatch = placeholderName.match(/^([A-Z_]+?)_?\d*$/);
    if (baseMatch) {
      const baseName = baseMatch[1];
      const fuzzyResponse = await fetch('https://localhost:43098/api/word/template-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search',
          query: baseName
        })
      });

      const fuzzyData = await fuzzyResponse.json();
      if (fuzzyData.results && fuzzyData.results.length > 0) {
        return fuzzyData.results[0].guideline;
      }
    }

    return null;
  } catch (e) {
    console.error('Error checking guideline:', e);
    return null;
  }
}

async function savePlaceholdersToLibrary(placeholders) {
  for (const ph of placeholders) {
    try {
      await fetch('https://localhost:43098/api/word/template-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          placeholder: ph,
          guideline: [`[Auto-created] Placeholder: {{${ph}}}`, 'Add guidelines here']
        })
      });
    } catch (e) {
      console.warn(`Failed to save placeholder ${ph}:`, e);
    }
  }
}

/**
 * Record a recent read for backward compatibility. One read may safely feed a
 * whole edit_doc batch; no re-read is required between operations in the batch.
 */
export function markDocRead() {
  docReadBeforeEdit = true;
  
  setTimeout(() => {
    docReadBeforeEdit = false;
  }, 5 * 60 * 1000);
}

/**
 * Get all placeholders from the document
 */
export async function getAllPlaceholdersInDocument() {
  return await Word.run(async (context) => {
    const body = context.document.body;
    const paragraphs = body.paragraphs;
    paragraphs.load('items');
    await context.sync();
    
    const placeholders = [];
    for (const p of paragraphs.items) {
      const text = p.text;
      if (text && text.match(/\{\{[A-Z_0-9]+\}\}/)) {
        placeholders.push(text);
      }
    }
    return placeholders;
  });
}

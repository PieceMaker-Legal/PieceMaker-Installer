/**
 * Read-doc and Edit-doc MCP Tools (ES6 Module)
 *
 * These tools provide LLM access to Word documents with:
 * - Markdown conversion for better readability
 * - Index-based paragraph targeting
 * - Placeholder management with guidelines
 * - Track changes support
 */

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
  const {
    list_headings = false,
    heading = null,
    indexes = null,
    include_track_changes = false
  } = params;

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

      let footnotes = null;
      try {
        footnotes = body.footnotes;
        footnotes.load('items/body/paragraphs,items/reference');
      } catch (e) {
        console.warn('Footnotes not supported on this platform');
      }

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

      for (const p of paragraphs.items) {
        p.load('text,style,font,listString,leftIndent');
        p.font.load('bold,italic,underline');

        if (!include_track_changes) {
          const reviewedText = p.getReviewedText(Word.ChangeTrackingVersion.current);
          reviewedTextResults.push(reviewedText);
        } else {
          reviewedTextResults.push(null);
        }

        try {
          const pFootnotes = p.footnotes;
          pFootnotes.load('items/reference,items/body/paragraphs');
          paragraphFootnotesData.push(pFootnotes);
        } catch (e) {
          paragraphFootnotesData.push(null);
        }
      }

      if (comments && comments.items.length > 0) {
        for (const comment of comments.items) {
          comment.load('content,authorName,replies');
        }
      }

      await context.sync();

      for (let i = 0; i < paragraphFootnotesData.length; i++) {
        const pFootnotes = paragraphFootnotesData[i];
        if (pFootnotes && pFootnotes.items && pFootnotes.items.length > 0) {
          for (let j = 0; j < pFootnotes.items.length; j++) {
            const fn = pFootnotes.items[j];
            fn.reference.load('text');
            fn.body.load('text');
            if (fn.body.paragraphs && fn.body.paragraphs.items) {
              for (let k = 0; k < fn.body.paragraphs.items.length; k++) {
                fn.body.paragraphs.items[k].load('text');
              }
            }
          }
        }
      }

      if (footnotes && footnotes.items.length > 0) {
        for (let i = 0; i < footnotes.items.length; i++) {
          const fn = footnotes.items[i];
          fn.reference.load('text');
          fn.body.load('text');
          if (fn.body.paragraphs && fn.body.paragraphs.items) {
            for (let j = 0; j < fn.body.paragraphs.items.length; j++) {
              fn.body.paragraphs.items[j].load('text');
            }
          }
        }
      }

      await context.sync();

      const commentsMap = {};
      if (comments && comments.items.length > 0) {
        for (const comment of comments.items) {
          commentsMap[comment.id] = {
            author: comment.authorName,
            text: comment.content
          };
        }
      }

      const paragraphsData = [];

      for (let i = 0; i < paragraphs.items.length; i++) {
        const p = paragraphs.items[i];

        let text = '';
        if (!include_track_changes && reviewedTextResults[i]) {
          text = reviewedTextResults[i].value || '';
        } else {
          text = p.text || '';
        }

        if (text.charCodeAt(0) === 0xFEFF) {
          text = text.slice(1);
        }

        const pFootnotes = paragraphFootnotesData[i];
        if (pFootnotes && pFootnotes.items && pFootnotes.items.length > 0) {
          for (let j = 0; j < pFootnotes.items.length; j++) {
            const fn = pFootnotes.items[j];
            const refText = fn.reference.text || '';

            let fnText = '';
            if (fn.body.paragraphs && fn.body.paragraphs.items) {
              for (const para of fn.body.paragraphs.items) {
                const paraText = (para.text || '').trim();
                if (paraText) {
                  fnText += paraText + ' ';
                }
              }
              fnText = fnText.trim();
            } else {
              fnText = fn.body.text.trim();
            }

            if (fnText) {
              text += `[^footnote: ${fnText}]`;
            }
          }
        }

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
          footnotes: []
        });
      }

      if (list_headings) {
        const result = formatHeadingsList(paragraphsData);
        return await anonymizeResultIfNeeded(result);
      }

      if (heading) {
        const result = formatHeadingContent(paragraphsData, heading);
        return await anonymizeResultIfNeeded(result);
      }

      if (parsedIndexes && parsedIndexes.length > 0) {
        const result = formatSpecificIndexes(paragraphsData, parsedIndexes);
        return await anonymizeResultIfNeeded(result);
      }

      const result = formatFullDocument(paragraphsData);
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

function formatHeadingsList(paragraphsData) {
  const headings = paragraphsData.filter(p => {
    const style = p.style || '';
    return style === 'Title' || style.startsWith('Title,') ||
           style.match(/^Heading\s+[1-4](?:,|$)/);
  });

  if (headings.length === 0) {
    return '📋 Document Structure:\n\n(No headings found)';
  }

  let output = '📋 Document Structure:\n\n';

  for (const h of headings) {
    let level = 0;
    if (h.style === 'Title' || h.style.startsWith('Title,')) {
      level = 0;
    } else {
      const match = h.style.match(/^Heading\s+(\d+)(?:,|$)/);
      level = match ? parseInt(match[1]) : 0;
    }

    const indent = '  '.repeat(level);
    const cleanText = removeWordNumbering(h.text);

    const hashes = '#'.repeat(level + 1);
    const formattedHeading = `${hashes} ${cleanText}`;

    output += `${indent}${h.index} -> ${formattedHeading}\n`;
  }

  return output;
}

function formatHeadingContent(paragraphsData, headingQuery) {
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

  return formatParagraphRange(contentRange);
}

function formatSpecificIndexes(paragraphsData, indexes) {
  const selected = paragraphsData.filter(p => indexes.includes(p.index));

  if (selected.length === 0) {
    return `❌ No paragraphs found at indexes: ${indexes.join(', ')}`;
  }

  return formatParagraphRange(selected);
}

function formatFullDocument(paragraphsData) {
  return formatParagraphRange(paragraphsData);
}

function formatParagraphRange(paragraphsData) {
  let output = '';
  let lastWasPageBreak = false;

  for (const para of paragraphsData) {
    const text = para.text.trim();

    if (!text) {
      output += `${para.index} -> \n`;
      continue;
    }

    const isPageBreak = text === '\f' || text === '\x0C';

    if (isPageBreak) {
      output += `${para.index} -> [^page_break]\n`;
      lastWasPageBreak = true;
      continue;
    }

    const mdText = convertParagraphToMarkdown(para);

    output += `${para.index} -> ${mdText}\n`;

    lastWasPageBreak = false;
  }

  return output;
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
  const {
    operation = null,
    target_index = null,
    placeholder = null,
    text = '',
    indexes_to_delete = null,
    skip_footnote_validation = false
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

  return await Word.run(async (context) => {
    try {
      context.document.changeTrackingMode = Word.ChangeTrackingMode.trackAll;

      const body = context.document.body;
      const paragraphs = body.paragraphs;
      paragraphs.load('items');

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

        const normalizedText = deanonymizedText.replace(/\\n/g, '\n');
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
          const formatted = markdownLineToWordFormat(line);
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
              const footnoteRange = insertionPoint.insertText('', 'End');
              try {
                const footnote = footnoteRange.insertFootnote('');
                const footnoteBody = footnote.body;

                let fnInsertPoint = footnoteBody.getRange('Start');
                for (const fnSegment of footnoteData.segments) {
                  if (!fnSegment.text) continue;

                  const fnSegmentRange = fnInsertPoint.insertText(fnSegment.text, 'End');
                  fnSegmentRange.font.bold = fnSegment.bold === true;
                  fnSegmentRange.font.italic = fnSegment.italic === true;
                  fnSegmentRange.font.underline = fnSegment.underline === true ? Word.UnderlineType.single : Word.UnderlineType.none;

                  fnInsertPoint = footnoteBody.getRange('End');
                }
              } catch (e) {
                const footnoteText = footnoteData.segments.map(s => s.text).join('');
                insertionPoint.insertText(` [${footnoteText}]`, 'End');
              }
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

      const normalizedText = deanonymizedText.replace(/\\n/g, '\n');
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
        const formatted = markdownLineToWordFormat(line);
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
            const footnoteRange = insertionPoint.insertText('', 'End');
            try {
              const footnote = footnoteRange.insertFootnote('');
              const footnoteBody = footnote.body;

              let fnInsertPoint = footnoteBody.getRange('Start');
              for (const fnSegment of footnoteData.segments) {
                if (!fnSegment.text) continue;

                const fnSegmentRange = fnInsertPoint.insertText(fnSegment.text, 'End');
                fnSegmentRange.font.bold = fnSegment.bold === true;
                fnSegmentRange.font.italic = fnSegment.italic === true;
                fnSegmentRange.font.underline = fnSegment.underline === true ? Word.UnderlineType.single : Word.UnderlineType.none;

                fnInsertPoint = footnoteBody.getRange('End');
              }
            } catch (e) {
              const footnoteText = footnoteData.segments.map(s => s.text).join('');
              insertionPoint.insertText(` [${footnoteText}]`, 'End');
            }
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
    }
  });
}

function markdownLineToWordFormat(mdLine) {
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

    const parsed = parseMarkdownToSegments(rawText);

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

    const parsed = parseMarkdownToSegments(rawText);

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

  const parsed = parseMarkdownToSegments(mdLine);

  return {
    style: 'Normal',
    segments: parsed.segments,
    isList: false,
    footnotes: parsed.footnotes,
    comments: parsed.comments,
    crossRefs: parsed.crossRefs
  };
}

function parseMarkdownToSegments(markdown) {
  const segments = [];
  const footnotes = [];
  const comments = [];
  const crossRefs = [];

  let processedText = markdown;
  let footnoteIndex = 0;
  let commentIndex = 0;
  let crossRefIndex = 0;

  processedText = processedText.replace(/\[\^(?:footnote:\s*([^\]]+)|(\d+):\s*([^\]]+)|\d+)\]/g, (match, footnoteText, digitGroup, digitText, offset) => {
    const text = footnoteText || digitText;
    if (text) {
      const parsed = parseMarkdownToSegments(text.trim());
      footnotes.push({ segments: parsed.segments, position: offset });
      return `__FOOTNOTE_${footnoteIndex++}__`;
    }
    return match;
  });

  processedText = processedText.replace(/<!--\s*([^-]+?)\s*-->/g, (match, text, offset) => {
    comments.push({ text: text.trim(), position: offset });
    return `__COMMENT_${commentIndex++}__`;
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

  const pattern = /(\*\*\*([^\*]+)\*\*\*|\*\*([^\*]+)\*\*|\*([^\*]+)\*|__USITALIC_\d+__|__UNDERLINE_\d+__|__PAGEBREAK_\d+__|__FOOTNOTE_\d+__|__COMMENT_\d+__|__CROSSREF_\d+__)/g;

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
      if (plainText) {
        segments.push({
          text: plainText,
          bold: false,
          italic: false,
          underline: false
        });
      }
    }

    if (match[0].startsWith('__FOOTNOTE_')) {
      const fnIndex = parseInt(match[0].match(/\d+/)[0]);
      segments.push({
        text: '',
        bold: false,
        italic: false,
        underline: false,
        isFootnote: true,
        footnoteIndex: fnIndex
      });
    } else if (match[0].startsWith('__COMMENT_')) {
      const cmIndex = parseInt(match[0].match(/\d+/)[0]);
      segments.push({
        text: '',
        bold: false,
        italic: false,
        underline: false,
        isComment: true,
        commentIndex: cmIndex
      });
    } else if (match[0].startsWith('__CROSSREF_')) {
      const crIndex = parseInt(match[0].match(/\d+/)[0]);
      segments.push({
        text: crossRefs[crIndex].title + ' ' + crossRefs[crIndex].index,
        bold: false,
        italic: false,
        underline: true,
        isCrossRef: true,
        crossRefIndex: crIndex
      });
    } else if (match[0].startsWith('__PAGEBREAK_')) {
      segments.push({
        text: '',
        bold: false,
        italic: false,
        underline: false,
        isPageBreak: true
      });
    } else if (match[0].startsWith('__USITALIC_')) {
      const usIndex = parseInt(match[0].match(/\d+/)[0]);
      const italicText = underscoreItalics[usIndex];
      segments.push({
        text: italicText,
        bold: false,
        italic: true,
        underline: false
      });
    } else if (match[0].startsWith('__UNDERLINE_')) {
      const ulIndex = parseInt(match[0].match(/\d+/)[0]);
      const underlineText = underlines[ulIndex];
      segments.push({
        text: underlineText,
        bold: false,
        italic: false,
        underline: true
      });
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

      const usItalicMarkerMatch = text.match(/^__USITALIC_(\d+)__$/);
      if (usItalicMarkerMatch) {
        const usIndex = parseInt(usItalicMarkerMatch[1]);
        text = underscoreItalics[usIndex];
        italic = true;
      }

      const underlineMarkerMatch = text.match(/^__UNDERLINE_(\d+)__$/);
      if (underlineMarkerMatch) {
        const ulIndex = parseInt(underlineMarkerMatch[1]);
        text = underlines[ulIndex];
        underline = true;
      }

      segments.push({ text, bold, italic, underline });
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < processedText.length) {
    const remaining = processedText.substring(lastIndex);
    if (remaining) {
      segments.push({
        text: remaining,
        bold: false,
        italic: false,
        underline: false
      });
    }
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
 * Mark that read-doc was called (required before edit)
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

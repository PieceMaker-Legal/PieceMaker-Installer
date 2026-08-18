// ---------------------------------------------------------------------------
// DEBUG LOGGING — Trace de diagnostic performance Markdown
// ---------------------------------------------------------------------------
const DEBUG = true;

function logToCentral(level, source, message, data = null) {
  if (typeof window !== 'undefined' && Array.isArray(window.__PM_LOGS)) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, -1);
    const entry = { id: Date.now() + Math.random(), timestamp, level, source, message, data };
    window.__PM_LOGS.push(entry);
    if (window.__PM_LOGS.length > 1000) window.__PM_LOGS.shift();

    const logContainer = document.getElementById('debugLogContainer');
    if (logContainer) {
      const row = document.createElement('div');
      row.className = `log-row log-${level.toLowerCase()}`;
      const payloadStr = data !== null ? ` | ${typeof data === 'object' ? JSON.stringify(data) : data}` : '';
      row.textContent = `[${timestamp}] [${source}] [${level}] ${message}${payloadStr}`;
      logContainer.appendChild(row);
      if (document.getElementById('debugAutoScroll')?.checked) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    }
  }
  const prefix = `[PM-DEBUG][${source}]`;
  if (level === 'WARN') console.warn(prefix, message, data || '');
  else if (level === 'ERROR') console.error(prefix, message, data || '');
  else if (DEBUG) console.log(prefix, message, data || '');
}

const dlog = (msg, data) => logToCentral('INFO', 'markdown.mjs', msg, data);
const dwarn = (msg, data) => logToCentral('WARN', 'markdown.mjs', msg, data);

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export function splitMarkdownDocument(source = '') {
  const t0 = performance.now();
  const srcLen = String(source).length;
  dlog('splitMarkdownDocument: START', { inputLength: srcLen });
  const normalized = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  const result = match
    ? { frontMatter: match[1], body: normalized.slice(match[0].length).replace(/^\n/, ''), metadata: parseMetadata(match[1]) }
    : { frontMatter: '', body: normalized, metadata: {} };
  const elapsed = performance.now() - t0;
  dlog('splitMarkdownDocument: DONE', { elapsedMs: elapsed.toFixed(2), bodyLength: result.body.length });
  if (elapsed > 50) dwarn(`splitMarkdownDocument: SLOW CALL — took ${elapsed.toFixed(2)}ms for ${srcLen} chars`);
  return result;
}

export function parseMetadata(frontMatter = '') {
  const t0 = performance.now();
  const values = {};
  const lines = String(frontMatter).split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) {
      let value = match[2];
      if (value.startsWith('"')) {
        try { value = JSON.parse(value); } catch { value = value.replace(/^"|"$/g, ''); }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).replaceAll("''", "'");
      }
      values[match[1]] = value;
    }
  }
  const elapsed = performance.now() - t0;
  if (elapsed > 30) dwarn(`parseMetadata: SLOW parsing ${lines.length} lines took ${elapsed.toFixed(2)}ms`);
  return values;
}

function cleanMetadataValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function yamlScalar(value) {
  return (!value || /[:#[\]{}&*!|>'"%@`]/.test(value) || /^[-?]\s/.test(value))
    ? JSON.stringify(value)
    : value;
}

export function updateMetadata(frontMatter, updates = {}) {
  const lines = String(frontMatter || '').split('\n').filter((line, index, values) => line || index < values.length - 1);
  for (const [key, rawValue] of Object.entries(updates)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || rawValue === undefined) continue;
    const value = cleanMetadataValue(rawValue);
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
    if (!value) {
      if (index >= 0) lines.splice(index, 1);
    } else if (index >= 0) {
      lines[index] = `${key}: ${yamlScalar(value)}`;
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join('\n').trim();
}

export function joinMarkdownDocument(frontMatter, metadata, body) {
  const t0 = performance.now();
  const content = String(body || '').trim();
  let result;
  if (!frontMatter) {
    result = `${content}\n`;
  } else {
    const updated = updateMetadata(frontMatter, metadata);
    result = `---\n${updated}\n---\n\n${content}\n`;
  }
  const elapsed = performance.now() - t0;
  dlog(`joinMarkdownDocument: DONE in ${elapsed.toFixed(2)}ms`);
  if (elapsed > 40) dwarn(`joinMarkdownDocument: SLOW execution took ${elapsed.toFixed(2)}ms`);
  return result;
}

function safeUrl(raw) {
  const value = String(raw || '').trim();
  if (/^(https?:|mailto:|\/|#)/i.test(value)) return value;
  // Références relatives aux fichiers annexes d'un skill (scripts, assets) :
  // aucun schéma (bloque javascript:…), pas de protocole-relatif (//host), pas
  // de remontée de dossier (..).
  if (
    value
    && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    && !value.startsWith('//')
    && !value.split('/').includes('..')
  ) {
    return value;
  }
  return '#';
}

function inlineMarkdown(source) {
  const code = [];
  let value = String(source).replace(/`([^`\n]+)`/g, (_match, content) => {
    const token = `\u0000CODE${code.length}\u0000`;
    code.push(`<code>${escapeHtml(content)}</code>`);
    return token;
  });
  value = escapeHtml(value);
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => (
    `<span class="image-placeholder" data-alt="${escapeHtml(alt)}" data-url="${escapeHtml(safeUrl(url))}">Image : ${alt || safeUrl(url)}</span>`
  ));
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => (
    `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noreferrer">${label}</a>`
  ));
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  value = value.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  value = value.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  code.forEach((replacement, index) => {
    value = value.replace(`\u0000CODE${index}\u0000`, replacement);
  });
  return value;
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  if (!line.trim()) return true;
  if (/^\s*```/.test(line) || /^#{1,6}\s+/.test(line) || /^>\s?/.test(line)) return true;
  if (/^\s*([-+*]|\d+\.)\s+/.test(line) || /^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) return true;
  if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) return true;
  return false;
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

let __markdownToHtmlDepth = 0;
let __markdownToHtmlCallCount = 0;

export function markdownToHtml(markdown = '') {
  const depth = ++__markdownToHtmlDepth;
  const callId = ++__markdownToHtmlCallCount;
  const t0 = performance.now();
  const srcLen = String(markdown).length;
  dlog(`markdownToHtml#${callId}: ENTER`, { depth, inputLength: srcLen });
  if (depth > 25) dwarn(`markdownToHtml#${callId}: Recursion depth is extremely HIGH (${depth})`);
  try {
    return __markdownToHtmlImpl(markdown, callId, depth, t0);
  } finally {
    __markdownToHtmlDepth -= 1;
  }
}

function __markdownToHtmlImpl(markdown = '', callId, depth, t0) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  let __iterations = 0;
  const __lineCount = lines.length;
  while (index < lines.length) {
    __iterations += 1;
    if (__iterations % 500 === 0) {
      dwarn(`markdownToHtml#${callId}: High loop iteration count (${__iterations}) at index=${index}/${__lineCount}`);
    }
    if (__iterations > __lineCount * 20 + 1000) {
      dwarn(`markdownToHtml#${callId}: ABORTED due to prospective infinite loop.`);
      break;
    }
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```\s*([A-Za-z0-9._+-]*)\s*$/);
    if (fence) {
      const content = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) content.push(lines[index++].replace(/^ {0,3}/, ''));
      if (index < lines.length) index += 1;
      html.push(`<pre data-language="${escapeHtml(fence[1])}"><code>${escapeHtml(content.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }

    const listMatch = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]) !== ordered) break;
        const itemLines = [item[2]];
        index += 1;
        while (index < lines.length) {
          const nextItem = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
          if (nextItem && /\d+\./.test(nextItem[1]) === ordered) break;
          if (!lines[index].trim()) {
            const following = lines[index + 1] || '';
            if (/^\s{2,}\S/.test(following)) {
              itemLines.push('');
              index += 1;
              continue;
            }
            break;
          }
          if (!/^\s{2,}/.test(lines[index])) break;
          itemLines.push(lines[index].replace(/^\s{2}/, ''));
          index += 1;
        }
        const renderedItem = markdownToHtml(itemLines.join('\n'));
        const simpleParagraph = renderedItem.match(/^<p>([\s\S]*)<\/p>$/);
        items.push(`<li>${simpleParagraph ? simpleParagraph[1] : renderedItem}</li>`);
        if (!lines[index]?.trim()) index += 1;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index++]));
      }
      html.push(`<table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }
  const __result = html.join('\n') || '<p><br></p>';
  const __elapsed = performance.now() - t0;
  dlog(`markdownToHtml#${callId}: EXIT`, { depth, elapsedMs: __elapsed.toFixed(2), outputLength: __result.length });
  if (__elapsed > 100) dwarn(`markdownToHtml#${callId}: SLOW EXECUTION — took ${__elapsed.toFixed(2)}ms`);
  return __result;
}

function serializeChildren(node) {
  return Array.from(node.childNodes || []).map(serializeNode).join('');
}

function serializeTable(node) {
  const rows = Array.from(node.querySelectorAll('tr')).map((row) => (
    Array.from(row.children).map((cell) => serializeChildren(cell).trim().replaceAll('|', '\\|'))
  ));
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
  return `${normalized.map((row, rowIndex) => {
    const value = `| ${row.join(' | ')} |\n`;
    return rowIndex === 0 ? `${value}| ${row.map(() => '---').join(' | ')} |\n` : value;
  }).join('')}\n`;
}

function serializeList(node, ordered) {
  return `${Array.from(node.children).filter((child) => child.tagName === 'LI').map((item, index) => {
    const content = serializeChildren(item).trim().replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ');
    return `${ordered ? `${index + 1}.` : '-'} ${content}`;
  }).join('\n')}\n\n`;
}

function serializeNode(node) {
  if (node.nodeType === 3) return String(node.nodeValue || '').replace(/\u00a0/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  const content = serializeChildren(node);
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${content.trim()}\n\n`;
  if (tag === 'p' || tag === 'div') return `${content.trim()}\n\n`;
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return `**${content}**`;
  if (tag === 'em' || tag === 'i') return `*${content}*`;
  if (tag === 's' || tag === 'del') return `~~${content}~~`;
  if (tag === 'code' && node.parentElement?.tagName !== 'PRE') return `\`${content}\``;
  if (tag === 'pre') return `\`\`\`${node.dataset.language || ''}\n${node.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
  if (tag === 'a') return `[${content}](${safeUrl(node.getAttribute('href'))})`;
  if (tag === 'ul') return serializeList(node, false);
  if (tag === 'ol') return serializeList(node, true);
  if (tag === 'li') return content;
  if (tag === 'blockquote') return `${content.trim().split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
  if (tag === 'hr') return '---\n\n';
  if (tag === 'table') return serializeTable(node);
  if (tag === 'span' && node.classList.contains('image-placeholder')) {
    return `![${node.dataset.alt || ''}](${safeUrl(node.dataset.url)})`;
  }
  return content;
}

export function visualEditorToMarkdown(element) {
  const t0 = performance.now();
  const nodeCount = element?.querySelectorAll ? element.querySelectorAll('*').length : -1;
  dlog('visualEditorToMarkdown: START', { childNodes: element?.childNodes?.length, totalElements: nodeCount });
  const result = serializeChildren(element)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const elapsed = performance.now() - t0;
  dlog('visualEditorToMarkdown: DONE', { elapsedMs: elapsed.toFixed(2), outputLength: result.length });
  if (elapsed > 80) dwarn(`visualEditorToMarkdown: SLOW DOM AST serialization — took ${elapsed.toFixed(2)}ms`);
  return result;
}
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFootnoteFromMarkdown, gfmFootnoteToMarkdown } from 'mdast-util-gfm-footnote';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';

// Marqueur privé : il n'est jamais renvoyé au modèle ni inséré dans Word.
// Il relie seulement le préparseur du document complet au convertisseur de
// paragraphes historique de PieceMaker.
export const FOOTNOTE_TOKEN_PATTERN = /\uE000PMFN:(\d+)\uE001/g;

function footnoteToken(index) {
  return `\uE000PMFN:${index}\uE001`;
}

function walk(node, visitor, insideDefinition = false) {
  const nowInsideDefinition = insideDefinition || node.type === 'footnoteDefinition';
  visitor(node, nowInsideDefinition);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) walk(child, visitor, nowInsideDefinition);
}

function serializeDefinitionBlocks(definition) {
  return definition.children
    .map((child) => toMarkdown(
      { type: 'root', children: [child] },
      { extensions: [gfmFootnoteToMarkdown({ firstLineBlank: false })] }
    ).trimEnd())
    .filter(Boolean);
}

function normalizeLegacyInlineFootnotes(markdown) {
  let counter = 0;
  let legacySyntaxUsed = false;
  const definitions = [];

  // Anciennes formes PieceMaker : [^footnote: texte] et [^1: texte]. La
  // définition standard [^1]: texte n'est pas concernée, car son deux-points
  // se trouve après le crochet fermant.
  const normalized = markdown.replace(
    /\[\^([A-Za-z0-9][A-Za-z0-9_.-]*):\s*([^\]\n]+)\]/g,
    (_match, _legacyLabel, text) => {
      legacySyntaxUsed = true;
      let identifier;
      do {
        counter += 1;
        identifier = `pm-legacy-${counter}`;
      } while (markdown.includes(`[^${identifier}]`));
      definitions.push(`[^${identifier}]: ${text.trim()}`);
      return `[^${identifier}]`;
    }
  );

  if (definitions.length === 0) return { markdown, legacySyntaxUsed };
  return {
    markdown: `${normalized.replace(/\n+$/, '')}\n\n${definitions.join('\n\n')}\n`,
    legacySyntaxUsed
  };
}

function applySourceEdits(source, edits) {
  let output = source;
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const edit of ordered) {
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
  }
  return output.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
}

function isEscaped(source, offset) {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index--) slashes += 1;
  return slashes % 2 === 1;
}

/**
 * Analyse les notes du document Markdown complet avant son découpage en
 * paragraphes. Les définitions sont retirées du corps et chaque référence est
 * remplacée par un marqueur privé compris par doc-tools.js.
 */
export function prepareMarkdownFootnotes(value, { acceptLegacy = true } = {}) {
  const original = String(value ?? '');
  const legacy = acceptLegacy
    ? normalizeLegacyInlineFootnotes(original)
    : { markdown: original, legacySyntaxUsed: false };
  const source = legacy.markdown;
  const tree = fromMarkdown(source, {
    extensions: [gfmFootnote()],
    mdastExtensions: [gfmFootnoteFromMarkdown()]
  });

  const definitions = new Map();
  const definitionNodes = [];
  const references = [];
  const unresolved = [];
  let nestedReference = null;

  walk(tree, (node, insideDefinition) => {
    if (node.type === 'footnoteDefinition') {
      const identifier = node.identifier;
      const blocks = serializeDefinitionBlocks(node);
      const previous = definitions.get(identifier);
      if (previous && JSON.stringify(previous.blocks) !== JSON.stringify(blocks)) {
        throw new Error(`Définitions contradictoires pour la note [^${node.label || identifier}].`);
      }
      if (!previous) definitions.set(identifier, { identifier, label: node.label || identifier, blocks });
      definitionNodes.push(node);
      return;
    }

    if (node.type === 'footnoteReference') {
      if (insideDefinition) {
        nestedReference = node.label || node.identifier;
      } else {
        references.push(node);
      }
      return;
    }

    // Micromark laisse une référence sans définition dans un nœud texte. La
    // détecter permet d'échouer avant toute mutation Word au lieu d'insérer le
    // littéral [^id]. Les blocs de code et commentaires HTML ne sont pas des
    // nœuds text et restent donc intacts.
    if (node.type === 'text' && !insideDefinition) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;
      const rawText = source.slice(start, end);
      const pattern = /\[\^([A-Za-z0-9][A-Za-z0-9_.-]*)\]/g;
      let match;
      while ((match = pattern.exec(rawText)) !== null) {
        if (match[1] === 'page_break') continue;
        if (!isEscaped(source, start + match.index)) unresolved.push(match[1]);
      }
    }
  });

  if (nestedReference) {
    throw new Error(`Les notes imbriquées ne sont pas prises en charge : [^${nestedReference}].`);
  }
  if (unresolved.length > 0) {
    const labels = [...new Set(unresolved)].map((id) => `[^${id}]`).join(', ');
    throw new Error(`Définition de note manquante : ${labels}.`);
  }

  const usedIdentifiers = new Set(references.map((node) => node.identifier));
  const unused = [...definitions.values()].filter((definition) => !usedIdentifiers.has(definition.identifier));
  if (unused.length > 0) {
    throw new Error(`Définition de note sans référence : [^${unused[0].label}].`);
  }

  const edits = [];
  const footnotes = [];
  for (const node of references) {
    const definition = definitions.get(node.identifier);
    if (!definition) {
      throw new Error(`Définition de note manquante : [^${node.label || node.identifier}].`);
    }
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`Position Markdown introuvable pour la note [^${definition.label}].`);
    }
    const occurrence = footnotes.length;
    footnotes.push({ ...definition });
    edits.push({ start, end, replacement: footnoteToken(occurrence) });
  }

  for (const node of definitionNodes) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (Number.isInteger(start) && Number.isInteger(end)) {
      edits.push({ start, end, replacement: '' });
    }
  }

  return {
    markdown: applySourceEdits(source, edits),
    footnotes,
    legacySyntaxUsed: legacy.legacySyntaxUsed
  };
}

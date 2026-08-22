const MAX_READ_CHARS = 100000;
const REVISION_CURSOR_RESERVE = 300;

function supportsRequirementSet(name, version) {
  try {
    return Office.context.requirements.isSetSupported(name, version);
  } catch (_error) {
    return false;
  }
}

function normalizeDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function normalizeText(value) {
  return String(value || '').replace(/^\uFEFF/, '');
}

function normalizedSet(values) {
  if (!Array.isArray(values)) return null;
  return new Set(values.map((value) => String(value).trim().toLocaleLowerCase()).filter(Boolean));
}

function fnv1a(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function revisionSnapshot(entries) {
  const signature = entries.map((entry) => [
    entry.index,
    entry.author,
    entry.date,
    entry.type,
    entry.formatDescription,
    entry.text
  ].join('\u001f')).join('\u001e');
  const first = fnv1a(signature, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a(`${signature.length}:${signature}`, 0x9e3779b9).toString(16).padStart(8, '0');
  return `${first}${second}`.slice(0, 12);
}

export function filterRevisionEntries(entries, options = {}) {
  const indexes = Array.isArray(options.indexes) ? new Set(options.indexes) : null;
  const authors = normalizedSet(options.authors);
  const types = normalizedSet(options.types);

  return entries.filter((entry) => {
    if (indexes && !indexes.has(entry.index)) return false;
    if (authors && !authors.has(entry.author.toLocaleLowerCase())) return false;
    if (types && !types.has(entry.type.toLocaleLowerCase())) return false;
    return true;
  });
}

function revisionLine(entry) {
  const fields = [`R${entry.index}`, entry.type || 'None', entry.date || '-', entry.author || '-'];
  if (entry.formatDescription) fields.push(entry.formatDescription);
  fields.push(JSON.stringify(entry.text));
  return fields.join(' | ');
}

function continuationMarker(options, cursor, maxChars) {
  const revisions = {
    ...(Array.isArray(options.indexes) ? { indexes: options.indexes } : {}),
    ...(Array.isArray(options.authors) ? { authors: options.authors } : {}),
    ...(Array.isArray(options.types) ? { types: options.types } : {}),
    ...cursor
  };
  const exact = `[TRUNCATED] Continue with read_doc(${JSON.stringify({
    revisions,
    max_chars: maxChars
  })})`;
  if (exact.length <= REVISION_CURSOR_RESERVE) return exact;

  const offset = cursor.from_offset ? `, from_offset=${cursor.from_offset}` : '';
  return `[TRUNCATED] Continue with the same revision filters, from_revision=${cursor.from_revision}${offset}.`;
}

export function formatRevisionPage(entries, options = {}) {
  const maxChars = Math.min(
    MAX_READ_CHARS,
    Math.max(500, Number.isFinite(options.maxChars) ? Math.floor(options.maxChars) : MAX_READ_CHARS)
  );
  const snapshot = options.snapshot || revisionSnapshot(entries);
  const scope = options.scope || 'body';
  const filtered = filterRevisionEntries(entries, options);
  const fromRevision = Number.isInteger(options.fromRevision) && options.fromRevision > 0
    ? options.fromRevision
    : 1;
  const fromOffset = Number.isInteger(options.fromOffset) && options.fromOffset >= 0
    ? options.fromOffset
    : 0;
  const header = `[REVISIONS snapshot=${snapshot} scope=${scope} total=${entries.length} matched=${filtered.length}]\n`;

  if (filtered.length === 0) return `${header}(No matching revisions)`;

  const pending = filtered
    .filter((entry) => entry.index >= fromRevision)
    .map((entry) => {
      const line = revisionLine(entry);
      const offset = entry.index === fromRevision ? Math.min(fromOffset, line.length) : 0;
      return { entry, line, offset };
    });
  if (pending.length === 0) return `${header}(No more revisions)`;

  const completeBody = pending.map(({ line, offset }) => line.slice(offset)).join('\n');
  if (header.length + completeBody.length <= maxChars) return `${header}${completeBody}`;

  let output = header;
  const contentLimit = Math.max(header.length, maxChars - REVISION_CURSOR_RESERVE - 1);
  let cursor = { from_revision: pending[0].entry.index };
  if (pending[0].offset > 0) cursor.from_offset = pending[0].offset;
  for (const { entry, line, offset } of pending) {
    const remaining = line.slice(offset);
    const separator = output === header ? '' : '\n';

    if (output.length + separator.length + remaining.length <= contentLimit) {
      output += `${separator}${remaining}`;
      cursor = { from_revision: entry.index + 1 };
      continue;
    }

    const available = contentLimit - output.length - separator.length;
    if (available > 0) {
      output += `${separator}${remaining.slice(0, available)}`;
      cursor = {
        from_revision: entry.index,
        from_offset: offset + available
      };
    } else {
      cursor = { from_revision: entry.index };
      if (offset > 0) cursor.from_offset = offset;
    }
    break;
  }

  const marker = continuationMarker(options, cursor, maxChars);
  output += `\n${marker}`;

  return output.slice(0, maxChars);
}

async function loadDesktopRevisions(context) {
  const collection = context.document.revisions;
  collection.load({
    author: true,
    date: true,
    formatDescription: true,
    index: true,
    type: true,
    range: { text: true }
  });
  await context.sync();

  return {
    scope: 'document',
    collection,
    entries: collection.items.map((revision, position) => ({
      index: Number.isInteger(revision.index) && revision.index > 0 ? revision.index : position + 1,
      author: String(revision.author || ''),
      date: normalizeDate(revision.date),
      type: String(revision.type || 'None'),
      formatDescription: String(revision.formatDescription || ''),
      text: normalizeText(revision.range?.text),
      source: revision,
      range: revision.range
    }))
  };
}

async function loadBodyTrackedChanges(context) {
  const collection = context.document.body.getTrackedChanges();
  collection.load({ author: true, date: true, text: true, type: true });
  await context.sync();

  return {
    scope: 'body',
    collection,
    entries: collection.items.map((change, position) => ({
      index: position + 1,
      author: String(change.author || ''),
      date: normalizeDate(change.date),
      type: String(change.type || 'None'),
      formatDescription: '',
      text: normalizeText(change.text),
      source: change,
      range: null
    }))
  };
}

async function loadAvailableRevisions(context) {
  if (supportsRequirementSet('WordApiDesktop', '1.4')) {
    return loadDesktopRevisions(context);
  }
  if (supportsRequirementSet('WordApi', '1.6')) {
    return loadBodyTrackedChanges(context);
  }
  throw new Error('Tracked changes require WordApi 1.6 or WordApiDesktop 1.4.');
}

export async function readRevisions(options = {}, maxChars = MAX_READ_CHARS) {
  return Word.run(async (context) => {
    try {
      const loaded = await loadAvailableRevisions(context);
      const entries = loaded.entries.map(({ source: _source, range: _range, ...entry }) => entry);
      return formatRevisionPage(entries, {
        indexes: options.indexes,
        authors: options.authors,
        types: options.types,
        fromRevision: options.from_revision,
        fromOffset: options.from_offset,
        maxChars,
        scope: loaded.scope,
        snapshot: revisionSnapshot(entries)
      });
    } catch (error) {
      return `❌ Error reading revisions: ${error.message}`;
    }
  });
}

function selectRevisionTargets(entries, review) {
  if (Array.isArray(review.indexes)) {
    const requested = new Set(review.indexes);
    const selected = entries.filter((entry) => requested.has(entry.index));
    const missing = [...requested].filter((index) => !selected.some((entry) => entry.index === index));
    if (missing.length > 0) return { error: `Unknown revision indexes: ${missing.join(', ')}` };
    return { selected, selection: 'indexes' };
  }

  if (review.filter && typeof review.filter === 'object') {
    if (review.confirm !== true) {
      return { error: 'Filtered revision actions require confirm: true.' };
    }
    const selected = filterRevisionEntries(entries, review.filter);
    return { selected, selection: 'filter' };
  }

  return { error: 'accept/reject requires indexes or filter.' };
}

function validateSnapshot(entries, suppliedSnapshot) {
  const current = revisionSnapshot(entries);
  if (!suppliedSnapshot) return { error: 'A revision snapshot from read_doc is required.', current };
  if (suppliedSnapshot !== current) {
    return { error: 'The revision snapshot is stale. Read revisions again before acting.', current };
  }
  return { current };
}

async function displayRevisions(context, review) {
  if (!supportsRequirementSet('WordApiDesktop', '1.4')) {
    return { error: 'Revision display settings require WordApiDesktop 1.4.' };
  }
  if (!review.markup && !review.view && !review.reviewers) {
    return { error: 'display requires markup, view, or reviewers.' };
  }

  const window = context.document.windows.getFirst();
  const filter = window.view.revisionsFilter;
  const reviewers = filter.reviewers;
  const update = {};
  if (review.markup) update.markup = review.markup[0].toUpperCase() + review.markup.slice(1).toLowerCase();
  if (review.view) update.view = review.view[0].toUpperCase() + review.view.slice(1).toLowerCase();
  if (Object.keys(update).length > 0) filter.set(update);

  if (review.reviewers === 'all' || review.reviewers === 'none') {
    reviewers.load({ isVisible: true });
    await context.sync();
    for (const reviewer of reviewers.items) reviewer.isVisible = review.reviewers === 'all';
  }

  await context.sync();
  return {
    success: true,
    action: 'display',
    ...(review.markup ? { markup: review.markup } : {}),
    ...(review.view ? { view: review.view } : {}),
    ...(review.reviewers ? { reviewers: review.reviewers } : {})
  };
}

export async function reviewRevisions(review = {}) {
  return Word.run(async (context) => {
    try {
      if (review.action === 'display') return await displayRevisions(context, review);

      const loaded = await loadAvailableRevisions(context);
      const plainEntries = loaded.entries.map(({ source: _source, range: _range, ...entry }) => entry);
      const snapshotCheck = validateSnapshot(plainEntries, review.snapshot);
      if (snapshotCheck.error) {
        return { error: snapshotCheck.error, current_snapshot: snapshotCheck.current };
      }

      if (review.action === 'show') {
        const entry = loaded.entries.find((candidate) => candidate.index === review.index);
        if (!entry) return { error: `Unknown revision index: ${review.index}` };
        const range = entry.range || entry.source.getRange();
        range.select('Select');
        await context.sync();
        return { success: true, action: 'show', index: entry.index, scope: loaded.scope };
      }

      let selected;
      let selection;
      if (review.action === 'accept_all' || review.action === 'reject_all') {
        if (review.confirm !== true) return { error: 'Global revision actions require confirm: true.' };
        selected = loaded.entries;
        selection = 'all';
      } else if (review.action === 'accept' || review.action === 'reject') {
        const targetResult = selectRevisionTargets(loaded.entries, review);
        if (targetResult.error) return { error: targetResult.error };
        selected = targetResult.selected;
        selection = targetResult.selection;
      } else {
        return { error: `Unknown review action: ${review.action || '(missing)'}` };
      }

      if (selected.length === 0) return { error: 'No revisions match this action.' };
      const accepts = review.action === 'accept' || review.action === 'accept_all';
      for (const entry of selected) {
        if (accepts) entry.source.accept();
        else entry.source.reject();
      }
      await context.sync();

      return {
        success: true,
        action: accepts ? 'accept' : 'reject',
        selection,
        count: selected.length,
        remaining: Math.max(0, loaded.entries.length - selected.length),
        scope: loaded.scope
      };
    } catch (error) {
      return { error: `Revision action failed: ${error.message}` };
    }
  });
}

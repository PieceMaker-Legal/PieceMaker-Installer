import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterRevisionEntries,
  formatRevisionPage,
  readRevisions,
  reviewRevisions,
  revisionSnapshot
} from '../taskpane/modules/word-revisions.js';

const sampleEntries = [
  {
    index: 1,
    author: 'Alice Martin',
    date: '2026-08-20T10:00:00.000Z',
    type: 'Insert',
    formatDescription: '',
    text: 'Ajout'
  },
  {
    index: 2,
    author: 'Bob Durand',
    date: '2026-08-21T11:00:00.000Z',
    type: 'Delete',
    formatDescription: '',
    text: 'Suppression'
  }
];

function installOfficeMock({ desktop = true, wordApi = true, context }) {
  globalThis.Office = {
    context: {
      requirements: {
        isSetSupported(name) {
          if (name === 'WordApiDesktop') return desktop;
          if (name === 'WordApi') return wordApi;
          return false;
        }
      }
    }
  };
  globalThis.Word = {
    run: async (callback) => callback(context)
  };
}

function desktopContext(entries = sampleEntries, { rejectMultiActionBatch = false } = {}) {
  const calls = { accepted: [], rejected: [], selected: [], filter: [], sync: 0 };
  const pending = [];
  const revisions = entries.map((entry) => {
    const source = {
      ...entry,
      date: new Date(entry.date),
      range: {
        text: entry.text,
        select(mode) { calls.selected.push([entry.index, mode]); }
      },
      accept() { pending.push({ action: 'accept', entry, source }); },
      reject() { pending.push({ action: 'reject', entry, source }); }
    };
    return source;
  });
  const reviewers = [{ isVisible: false }, { isVisible: true }];
  const context = {
    document: {
      revisions: {
        items: revisions,
        load() {}
      },
      windows: {
        getFirst() {
          return {
            view: {
              revisionsFilter: {
                reviewers: {
                  items: reviewers,
                  load() {}
                },
                set(value) { calls.filter.push(value); }
              }
            }
          };
        }
      }
    },
    async sync() {
      calls.sync += 1;
      if (rejectMultiActionBatch && pending.length > 1) {
        for (const item of pending) calls.rejected.push(item.entry.index);
        pending.length = 0;
        revisions.length = 0;
        throw new Error('Microsoft Word: Object has been deleted.');
      }
      for (const item of pending.splice(0)) {
        calls[item.action === 'accept' ? 'accepted' : 'rejected'].push(item.entry.index);
        const position = revisions.indexOf(item.source);
        if (position >= 0) revisions.splice(position, 1);
      }
    }
  };
  return { context, calls, reviewers };
}

test('le snapshot est stable et couvre le contenu des révisions', () => {
  const first = revisionSnapshot(sampleEntries);
  assert.equal(first, revisionSnapshot(structuredClone(sampleEntries)));
  assert.notEqual(first, revisionSnapshot([
    { ...sampleEntries[0], text: 'Texte modifié' },
    sampleEntries[1]
  ]));
});

test('les filtres auteur/type sont insensibles à la casse et combinables avec les index', () => {
  assert.deepEqual(
    filterRevisionEntries(sampleEntries, { authors: ['alice martin'], types: ['INSERT'], indexes: [1, 2] }),
    [sampleEntries[0]]
  );
});

test('la pagination des révisions reste sous le plafond et fournit un curseur exploitable', () => {
  const entries = Array.from({ length: 12 }, (_, position) => ({
    ...sampleEntries[0],
    index: position + 1,
    text: `Révision ${position + 1} ${'x'.repeat(180)}`
  }));
  const first = formatRevisionPage(entries, { maxChars: 500, authors: ['Alice Martin'] });

  assert.ok(first.length <= 500);
  assert.match(first, /^\[REVISIONS snapshot=[a-f0-9]{12}/);
  assert.match(first, /\[TRUNCATED\]/);
  const revision = Number(first.match(/from_revision["=:\s]+(\d+)/)?.[1]);
  const offset = Number(first.match(/from_offset["=:\s]+(\d+)/)?.[1] || 0);
  assert.ok(revision >= 1);

  const resumed = formatRevisionPage(entries, {
    maxChars: 500,
    authors: ['Alice Martin'],
    fromRevision: revision,
    fromOffset: offset
  });
  assert.ok(resumed.length <= 500);
  assert.notEqual(resumed, first);
});

test('read_doc expose les métadonnées Desktop et retombe sur WordApi 1.6', async () => {
  const desktop = desktopContext();
  installOfficeMock({ context: desktop.context });
  const desktopResult = await readRevisions({}, 100000);
  assert.match(desktopResult, /scope=document/);
  assert.match(desktopResult, /R1 \| Insert \| 2026-08-20T10:00:00.000Z \| Alice Martin \| "Ajout"/);

  const fallbackChanges = sampleEntries.map((entry) => ({
    author: entry.author,
    date: new Date(entry.date),
    type: entry.type === 'Insert' ? 'Added' : 'Deleted',
    text: entry.text,
    accept() {},
    reject() {},
    getRange() { return { select() {} }; }
  }));
  const fallbackContext = {
    document: {
      body: {
        getTrackedChanges() {
          return { items: fallbackChanges, load() {} };
        }
      }
    },
    async sync() {}
  };
  installOfficeMock({ desktop: false, context: fallbackContext });
  const fallbackResult = await readRevisions({}, 100000);
  assert.match(fallbackResult, /scope=body/);
  assert.match(fallbackResult, /R1 \| Added/);
});

test('les actions refusent un snapshot périmé et exigent confirmation pour les sélections larges', async () => {
  const desktop = desktopContext();
  installOfficeMock({ context: desktop.context });

  const stale = await reviewRevisions({ action: 'accept', snapshot: 'ancien', indexes: [1] });
  assert.match(stale.error, /stale/);

  const snapshot = revisionSnapshot(sampleEntries);
  const unconfirmed = await reviewRevisions({
    action: 'reject',
    snapshot,
    filter: { authors: ['Alice Martin'] }
  });
  assert.match(unconfirmed.error, /confirm/);

  const accepted = await reviewRevisions({ action: 'accept', snapshot, indexes: [2] });
  assert.deepEqual(desktop.calls.accepted, [2]);
  assert.deepEqual(accepted, {
    success: true,
    action: 'accept',
    selection: 'indexes',
    count: 1,
    remaining: 1,
    scope: 'document'
  });

  const globalDesktop = desktopContext();
  installOfficeMock({ context: globalDesktop.context });
  const global = await reviewRevisions({ action: 'reject_all', snapshot });
  assert.match(global.error, /confirm/);

  const filteredDesktop = desktopContext();
  installOfficeMock({ context: filteredDesktop.context });
  const filtered = await reviewRevisions({
    action: 'reject',
    snapshot,
    filter: { authors: ['Alice Martin'] },
    confirm: true
  });
  assert.equal(filtered.count, 1);
  assert.deepEqual(filteredDesktop.calls.rejected, [1]);
});

test('accept/reject synchronise chaque cible avant que Word invalide les proxies', async () => {
  const entries = [
    ...sampleEntries,
    { ...sampleEntries[0], index: 3, text: 'Autre ajout' }
  ];
  const desktop = desktopContext(entries, { rejectMultiActionBatch: true });
  installOfficeMock({ context: desktop.context });

  const result = await reviewRevisions({
    action: 'reject',
    snapshot: revisionSnapshot(entries),
    indexes: [1, 3]
  });

  assert.deepEqual(desktop.calls.rejected, [3, 1]);
  assert.deepEqual(result, {
    success: true,
    action: 'reject',
    selection: 'indexes',
    count: 2,
    remaining: 1,
    scope: 'document'
  });
});

test('show sélectionne la révision et display configure la vue Desktop', async () => {
  const desktop = desktopContext();
  installOfficeMock({ context: desktop.context });
  const snapshot = revisionSnapshot(sampleEntries);

  const shown = await reviewRevisions({ action: 'show', snapshot, index: 1 });
  assert.equal(shown.success, true);
  assert.deepEqual(desktop.calls.selected, [[1, 'Select']]);

  const displayed = await reviewRevisions({
    action: 'display',
    markup: 'simple',
    view: 'original',
    reviewers: 'none'
  });
  assert.equal(displayed.success, true);
  assert.deepEqual(desktop.calls.filter, [{ markup: 'Simple', view: 'Original' }]);
  assert.ok(desktop.reviewers.every((reviewer) => reviewer.isVisible === false));
});

test('edit_doc restaure le mode de suivi après une écriture suivie ou directe', async () => {
  globalThis.document = {
    createElement() {
      return {
        set innerHTML(value) { this.textContent = value; },
        textContent: ''
      };
    }
  };
  const { editDoc } = await import('../taskpane/modules/doc-tools.js');

  for (const testCase of [
    { prior: 'Off', tracked: true, expectedDuring: 'TrackAll' },
    { prior: 'TrackAll', tracked: false, expectedDuring: 'Off' }
  ]) {
    const deleted = [];
    const observedModes = [];
    const document = {
      changeTrackingMode: testCase.prior,
      load() {},
      body: {
        paragraphs: {
          items: [{ delete() { deleted.push(0); } }],
          load() {}
        }
      }
    };
    const context = {
      document,
      async sync() { observedModes.push(document.changeTrackingMode); }
    };
    globalThis.Word = {
      ChangeTrackingMode: { off: 'Off', trackAll: 'TrackAll' },
      run: async (callback) => callback(context)
    };

    const result = await editDoc({
      operation: 'delete',
      indexes_to_delete: [0],
      track_changes: testCase.tracked
    });

    assert.equal(result.success, true);
    assert.deepEqual(deleted, [0]);
    assert.equal(observedModes[1], testCase.expectedDuring);
    assert.equal(observedModes.at(-1), testCase.prior);
    assert.equal(document.changeTrackingMode, testCase.prior);
  }
});

test('edit_doc restaure aussi le mode de suivi si la mutation Word échoue', async () => {
  globalThis.document = {
    createElement() {
      return {
        set innerHTML(value) { this.textContent = value; },
        textContent: ''
      };
    }
  };
  const { editDoc } = await import('../taskpane/modules/doc-tools.js');
  const document = {
    changeTrackingMode: 'Off',
    load() {},
    body: {
      paragraphs: {
        items: [{ delete() { throw new Error('échec simulé'); } }],
        load() {}
      }
    }
  };
  globalThis.Word = {
    ChangeTrackingMode: { off: 'Off', trackAll: 'TrackAll' },
    run: async (callback) => callback({ document, async sync() {} })
  };

  const result = await editDoc({
    operation: 'delete',
    indexes_to_delete: [0],
    track_changes: true
  });

  assert.match(result.error, /échec simulé/);
  assert.equal(document.changeTrackingMode, 'Off');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chronologyDocumentFlags,
  chronologyStateModel,
  entityDecisionsForSelection,
  sameEntityDecisions,
} from '../admin/chronology-model.mjs';

test('un graphe stale ou en quarantaine n’est jamais présenté comme prêt', () => {
  const stale = chronologyStateModel({
    graphRevision: 18,
    graphStatus: {
      staticState: 'current',
      semanticState: 'stale',
      staticRevision: 18,
      semanticBaseRevision: 17,
      semanticStaleReasons: ['date_changed', 'party_or_corpus_boundary_changed'],
      semanticQuarantined: true,
    },
  });

  assert.equal(stale.ready, false);
  assert.equal(stale.label, 'Analyse juridique à actualiser');
  assert.equal(stale.staticRevision, 18);
  assert.equal(stale.semanticBaseRevision, 17);
  assert.equal(stale.quarantined, true);
  assert.match(stale.detail, /ancienne analyse est masquée/);
  assert.deepEqual(stale.reasons, ['date corrigée', 'parties ou périmètre modifiés']);

  const building = chronologyStateModel({ graphStatus: { semanticState: 'building' } });
  assert.equal(building.ready, false);
  assert.equal(building.canRefresh, false);

  const current = chronologyStateModel({
    graphStatus: { staticState: 'current', semanticState: 'current', semanticQuarantined: false },
  });
  assert.equal(current.ready, true);
});

test('les corrections, contradictions et revues deviennent des flags lisibles', () => {
  const flags = chronologyDocumentFlags({
    qualityFlags: [{
      type: 'MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION',
      field: 'dateIso',
      detectedValue: '2024-01-01',
      effectiveValue: '2024-01-02',
    }],
    contradictions: [{ type: 'LLM_CONTRADICTS_MANUAL_FACT', field: 'nature' }],
    reviewReasons: ['piece_non_analysee'],
  });

  assert.deepEqual(flags.map(({ type, severity }) => ({ type, severity })), [
    { type: 'MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION', severity: 'warning' },
    { type: 'LLM_CONTRADICTS_MANUAL_FACT', severity: 'error' },
    { type: 'REVIEW_PIECE_NON_ANALYSEE', severity: 'info' },
  ]);
  assert.match(flags[0].detail, /2024-01-01.*2024-01-02/);
});

test('les ajouts et exclusions restent des décisions propres à la pièce', () => {
  const document = {
    detectedCodes: ['PERSONNE_PHYSIQUE_01', 'SAS_1'],
    effectiveCodes: ['PERSONNE_PHYSIQUE_01', 'ADRESSE_1'],
  };
  const decisions = entityDecisionsForSelection(document, [
    'PERSONNE_PHYSIQUE_01',
    'ADRESSE_1',
  ]);

  assert.deepEqual(decisions, {
    additions: ['ADRESSE_1'],
    exclusions: ['SAS_1'],
  });
  assert.equal(sameEntityDecisions(decisions, {
    exclusions: ['SAS_1'], additions: ['ADRESSE_1'], updatedAt: 'ignoré',
  }), true);
  assert.equal(sameEntityDecisions(decisions, { additions: [], exclusions: [] }), false);
});

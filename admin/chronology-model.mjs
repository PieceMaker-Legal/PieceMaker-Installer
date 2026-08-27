/** Modèle pur de la chronologie/graphe pour l'administration. */

const STATE_LABELS = {
  current: ['Analyse juridique à jour', 'ok'],
  stale: ['Analyse juridique à actualiser', 'warning'],
  building: ['Analyse juridique en cours…', 'progress'],
  failed: ['Échec de l’analyse juridique', 'error'],
  blocked: ['Analyse juridique bloquée', 'error'],
  missing: ['Analyse juridique non construite', 'muted'],
};

const REASON_LABELS = {
  date_changed: 'date corrigée',
  nature_changed: 'type de pièce corrigé',
  document_entities_changed: 'entités de la pièce modifiées',
  semantic_corpus_changed: 'corpus juridique modifié',
  party_or_corpus_boundary_changed: 'parties ou périmètre modifiés',
  legal_prompt_version_changed: 'instructions d’analyse mises à jour',
  legal_integration_version_changed: 'intégration juridique mise à jour',
  legal_finalizer_version_changed: 'contrôles juridiques mis à jour',
  semantic_build_failed: 'dernière construction en échec',
  mapping_missing: 'mapping manquant',
  parties_required: 'parties à identifier',
  party_selection_invalid: 'sélection des parties invalide',
  no_party_documents: 'aucune pièce reliée aux parties',
};

const FLAG_LABELS = {
  MANUAL_OVERRIDE_DIFFERS_FROM_DETECTION: ['Correction manuelle différente de la détection', 'warning'],
  SEMANTIC_LAYER_STALE_AFTER_EDIT: ['Analyse juridique antérieure à la correction', 'warning'],
  LLM_CONTRADICTS_MANUAL_FACT: ['L’analyse contredit une valeur validée par le cabinet', 'error'],
};

const REVIEW_LABELS = {
  piece_non_analysee: 'Pièce non analysée',
  markdown_indisponible: 'Markdown indisponible',
  markdown_illisible: 'Markdown illisible',
  contenu_vide: 'Contenu vide',
  aucune_personne_indexee: 'Aucune personne indexée',
  partie_absente_des_pieces: 'Partie absente des pièces',
};

function cleanCode(value) {
  return String(typeof value === 'string' ? value : value?.code || '').trim();
}

function uniqueCodes(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(cleanCode).filter(Boolean))].sort();
}

function readableReason(reason) {
  const key = String(reason || '');
  return REASON_LABELS[key] || key.replaceAll('_', ' ');
}

/** État directement affichable, sans jamais assimiler stale/failed à ready. */
export function chronologyStateModel(data = {}) {
  const state = data.graphStatus || data.graph?.state || {};
  const semanticState = STATE_LABELS[state.semanticState] ? state.semanticState : 'missing';
  const [label, tone] = STATE_LABELS[semanticState];
  const staticRevision = state.staticRevision ?? data.graphRevision ?? data.graph?.revision ?? null;
  const semanticBaseRevision = state.semanticBaseRevision ?? null;
  const reasons = [...new Set((state.semanticStaleReasons || []).map(readableReason).filter(Boolean))];
  const quarantined = Boolean(state.semanticQuarantined);
  return {
    staticState: state.staticState || (data.stats?.documents ? 'current' : 'missing'),
    semanticState,
    label,
    tone,
    staticRevision,
    semanticBaseRevision,
    reasons,
    quarantined,
    ready: semanticState === 'current' && !quarantined,
    canRefresh: !['building', 'blocked'].includes(semanticState),
    revisionLabel: staticRevision == null
      ? 'Révision documentaire inconnue'
      : `Documents à jour · révision ${staticRevision}`,
    detail: quarantined
      ? 'L’ancienne analyse est masquée jusqu’à sa reconstruction.'
      : (reasons.length ? reasons.join(' · ') : ''),
  };
}

function flagValue(value) {
  if (value == null || value === '') return '—';
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized.length > 140 ? `${serialized.slice(0, 137)}…` : serialized;
}

/** Flags de qualité, contradictions et motifs de revue d'une pièce. */
export function chronologyDocumentFlags(document = {}) {
  const flags = [];
  const rawFlags = [
    ...(document.qualityFlags || document.quality_flags || []),
    ...(document.contradictions || document.contradictionFlags || document.contradiction_flags || []),
  ];
  for (const raw of rawFlags) {
    const flag = typeof raw === 'string' ? { type: raw } : (raw || {});
    const type = String(flag.type || flag.code || 'QUALITY_REVIEW_REQUIRED');
    const [label, severity] = FLAG_LABELS[type]
      || [type.replaceAll('_', ' '), type.includes('CONTRADICT') ? 'error' : 'warning'];
    const field = flag.field ? ` · ${flag.field}` : '';
    const comparison = Object.hasOwn(flag, 'detectedValue') || Object.hasOwn(flag, 'effectiveValue')
      ? `Détecté : ${flagValue(flag.detectedValue)} · Retenu : ${flagValue(flag.effectiveValue)}`
      : String(flag.detail || flag.message || '');
    flags.push({ type, severity, label: `${label}${field}`, detail: comparison });
  }
  for (const reason of document.reviewReasons || document.review_reasons || []) {
    const type = `REVIEW_${String(reason).toUpperCase()}`;
    flags.push({
      type,
      severity: 'info',
      label: REVIEW_LABELS[reason] || readableReason(reason),
      detail: '',
    });
  }
  const seen = new Set();
  return flags.filter((flag) => {
    const key = `${flag.type}\u0000${flag.label}\u0000${flag.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectedDocumentEntityCodes(document = {}) {
  const source = Object.hasOwn(document, 'detectedCodes')
    ? document.detectedCodes
    : (Object.hasOwn(document, 'detected_codes') ? document.detected_codes : document.codes);
  return uniqueCodes(source);
}

export function effectiveDocumentEntityCodes(document = {}) {
  const source = Object.hasOwn(document, 'effectiveCodes')
    ? document.effectiveCodes
    : (Object.hasOwn(document, 'effective_codes') ? document.effective_codes : document.codes);
  return uniqueCodes(source);
}

/** Transforme l'état visuel en décisions locales minimales. */
export function entityDecisionsForSelection(document = {}, activeCodes = []) {
  const detected = new Set(detectedDocumentEntityCodes(document));
  const active = new Set(uniqueCodes(activeCodes));
  return {
    additions: [...active].filter((code) => !detected.has(code)).sort(),
    exclusions: [...detected].filter((code) => !active.has(code)).sort(),
  };
}

export function sameEntityDecisions(left = {}, right = {}) {
  const normalized = (value) => ({
    additions: uniqueCodes(value?.additions),
    exclusions: uniqueCodes(value?.exclusions),
  });
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

/**
 * Registre autoritatif des parties pour le graphe juridique (Graphify).
 *
 * Extrait ici, hors de `legal-graph.cjs` déjà volumineux, plan
 * `docs/PLAN-Legal-Graphify.md` § 4 (« Lot 1 »). Ce module ne lit jamais
 * `mapping_default.json` lui-même : il reçoit le document de mapping déjà
 * chargé (`readCaseMapping()` côté appelant) et se contente d'en extraire les
 * parties de la procédure (`informations_dossier.parties_clientes` et
 * `parties_adverses`, cf. `normalizeProcedureParty` dans
 * `piecemaker-plugin/scripts/lib/mapping.cjs`) pour produire un registre sûr :
 * uniquement des codes, jamais des noms en clair.
 *
 * Aucun comportement « dernier enregistrement gagnant » : deux parties dont la
 * sélection entre en conflit (même code pour deux côtés/positions
 * incompatibles, type personne physique pointant vers un code société, etc.)
 * font échouer la construction plutôt que de laisser l'une écraser l'autre en
 * silence.
 */

// ─────────────────────────── Mapping : lecture défensive ───────────────────

/** Le document de mapping porte-t-il au moins une entité codée exploitable ? */
function hasUsableMapping(mappingDocument) {
  if (!mappingDocument || typeof mappingDocument !== 'object') return false;
  const mapping = mappingDocument.mapping && typeof mappingDocument.mapping === 'object'
    ? mappingDocument.mapping : {};
  const reverse = mappingDocument.reverse_mapping && typeof mappingDocument.reverse_mapping === 'object'
    ? mappingDocument.reverse_mapping : {};
  return Object.keys(mapping).length > 0 || Object.keys(reverse).length > 0;
}

/** Ensemble des codes connus du mapping, dans les deux sens de lecture. */
function knownCodes(mappingDocument) {
  const codes = new Set();
  const mapping = mappingDocument.mapping && typeof mappingDocument.mapping === 'object'
    ? mappingDocument.mapping : {};
  const reverse = mappingDocument.reverse_mapping && typeof mappingDocument.reverse_mapping === 'object'
    ? mappingDocument.reverse_mapping : {};
  for (const code of Object.values(mapping)) if (code) codes.add(code);
  for (const code of Object.keys(reverse)) if (code) codes.add(code);
  return codes;
}

/**
 * Catégorie GLiNER d'un code (`personnes_physiques`, `societes`, …), déduite
 * de `extracted_data` — seul endroit du document de mapping qui porte cette
 * information par code. `null` si le code n'y figure pas (identité saisie à la
 * main, hors scan) : dans ce cas la cohérence de catégorie n'est pas vérifiable
 * et n'est donc pas opposée à la partie.
 */
function categoryOfCode(code, mappingDocument) {
  const extracted = mappingDocument.extracted_data;
  if (!extracted || typeof extracted !== 'object') return null;
  for (const [category, codes] of Object.entries(extracted)) {
    if (codes && typeof codes === 'object' && Object.prototype.hasOwnProperty.call(codes, code)) {
      return category;
    }
  }
  return null;
}

/** Catégorie GLiNER attendue pour un type de partie de procédure. */
function expectedCategoryForType(type) {
  return type === 'societe' ? 'societes' : 'personnes_physiques';
}

/** `entityType` sûr (« personne » / « societe ») transmis au registre. */
function entityTypeForParty(party) {
  return party.type === 'societe' ? 'societe' : 'personne';
}

// ───────────────────────────── Résolution d'identité ───────────────────────

/**
 * Résout l'identité d'une seule partie de procédure vers un code du mapping.
 * Ne fait aucune vérification de conflit inter-parties : voir
 * `buildLegalPartyRegistry` pour la détection des doublons de code.
 *
 * Renvoie `{ ok: true, code, entityType }` ou `{ ok: false, reason }`.
 */
function resolvePartyIdentity(party, mappingDocument) {
  const expectedCategory = expectedCategoryForType(party.type);
  const entityType = entityTypeForParty(party);

  // 1. Affectation explicite `field === "identite"`, posée par l'éditeur des
  //    parties de la procédure — c'est la seule source de vérité tant qu'elle
  //    existe et reste cohérente avec le mapping courant.
  const assignments = Array.isArray(party.mapping_assignments) ? party.mapping_assignments : [];
  const identity = assignments.find((assignment) => assignment && assignment.field === 'identite');
  const assignedCode = identity && identity.code ? String(identity.code).trim() : '';

  if (assignedCode) {
    if (!knownCodes(mappingDocument).has(assignedCode)) {
      return { ok: false, reason: `le code d'identité « ${assignedCode} » n'existe plus dans le mapping du dossier` };
    }
    const actualCategory = categoryOfCode(assignedCode, mappingDocument);
    if (actualCategory && actualCategory !== expectedCategory) {
      return {
        ok: false,
        reason: `le code d'identité « ${assignedCode} » (catégorie « ${actualCategory} ») est incompatible avec le type de partie « ${party.type} »`,
      };
    }
    return { ok: true, code: assignedCode, entityType };
  }

  // 2. Repli : à défaut d'affectation, correspondance EXACTE (jamais
  //    approximative) du nom explicitement saisi pour cette partie, sur le
  //    champ propre à son type — jamais l'autre.
  const name = party.type === 'societe' ? party.societe_nom : party.nom;
  if (!name) {
    return { ok: false, reason: 'aucune identité exploitable : ni affectation « identite », ni nom déclaré' };
  }
  const mapping = mappingDocument.mapping && typeof mappingDocument.mapping === 'object'
    ? mappingDocument.mapping : {};
  const fallbackCode = mapping[name];
  if (!fallbackCode) {
    return { ok: false, reason: `aucune correspondance exacte pour le nom déclaré dans le mapping du dossier` };
  }
  const actualCategory = categoryOfCode(fallbackCode, mappingDocument);
  if (actualCategory && actualCategory !== expectedCategory) {
    return {
      ok: false,
      reason: `le nom déclaré correspond au code « ${fallbackCode} » (catégorie « ${actualCategory} »), incompatible avec le type de partie « ${party.type} »`,
    };
  }
  return { ok: true, code: fallbackCode, entityType };
}

/**
 * Résout une seule partie vers son code, ou `null` si elle est irrésolue ou
 * incohérente. Ne signale aucun conflit inter-parties (voir
 * `buildLegalPartyRegistry` pour la construction complète du registre).
 */
function partyCodeForSelection(party, mappingDocument) {
  if (!party || typeof party !== 'object') return null;
  if (!hasUsableMapping(mappingDocument)) return null;
  const outcome = resolvePartyIdentity(party, mappingDocument);
  return outcome.ok ? outcome.code : null;
}

// ───────────────────────────── Registre complet ────────────────────────────

const SIDE_LABELS = { client: 'cliente', adversaire: 'adverse' };

function describeParty(side, index) {
  return `partie ${SIDE_LABELS[side] || side} #${index + 1}`;
}

/**
 * Construit le registre autoritatif des parties à partir du document de
 * mapping déjà chargé (`readCaseMapping()` côté appelant — jamais requis ici).
 *
 * Renvoie `{ status }`, complété par `parties` uniquement à l'état `ready` et
 * par `errors` uniquement à l'état `party_selection_invalid` :
 *  - `mapping_missing`         : pas de mapping exploitable pour ce dossier ;
 *  - `parties_required`        : mapping présent, aucune partie sélectionnée ;
 *  - `party_selection_invalid` : sélection présente mais incohérente ;
 *  - `ready`                   : registre cohérent, prêt pour Graphify.
 */
function buildLegalPartyRegistry(mappingDocument) {
  if (!hasUsableMapping(mappingDocument)) {
    return { status: 'mapping_missing' };
  }

  const info = mappingDocument.informations_dossier && typeof mappingDocument.informations_dossier === 'object'
    ? mappingDocument.informations_dossier : {};
  const sides = [
    { side: 'client', list: Array.isArray(info.parties_clientes) ? info.parties_clientes : [] },
    { side: 'adversaire', list: Array.isArray(info.parties_adverses) ? info.parties_adverses : [] },
  ];

  if (!sides.some(({ list }) => list.length)) {
    return { status: 'parties_required' };
  }

  const errors = [];
  const resolved = [];
  for (const { side, list } of sides) {
    list.forEach((party, index) => {
      if (!party || typeof party !== 'object') {
        errors.push(`${describeParty(side, index)} : partie invalide`);
        return;
      }
      const outcome = resolvePartyIdentity(party, mappingDocument);
      if (!outcome.ok) {
        errors.push(`${describeParty(side, index)} : ${outcome.reason}`);
        return;
      }
      resolved.push({
        code: outcome.code,
        entityType: outcome.entityType,
        side,
        position: party.position,
        positionLibelle: party.position_libelle || '',
      });
    });
  }

  // Détection des conflits : un même code revendiqué par des parties dont le
  // côté, la position ou le type diffèrent — jamais résolu au dernier arrivé.
  const byCode = new Map();
  for (const party of resolved) {
    if (!byCode.has(party.code)) byCode.set(party.code, []);
    byCode.get(party.code).push(party);
  }
  for (const [code, claimants] of byCode) {
    const signatures = new Set(claimants.map((party) => `${party.side}:${party.position}:${party.entityType}`));
    if (signatures.size > 1) {
      errors.push(`le code « ${code} » est revendiqué par des parties incompatibles (${[...signatures].join(' / ')})`);
    }
  }

  if (errors.length) {
    return { status: 'party_selection_invalid', errors };
  }
  return { status: 'ready', parties: resolved };
}

// ───────────────────────────── Projection sûre ─────────────────────────────

/**
 * Projection du registre transmissible à Graphify (fichier `entity_mapping`
 * temporaire, cf. plan § 6.3) : uniquement des codes, jamais de noms ni de
 * variantes. `positionLibelle` — texte libre saisi par le cabinet — ne
 * franchit jamais cette frontière.
 */
function serializeSafePartyRegistry(registry) {
  const mapping = {};
  const entity_metadata = {};
  const parties = registry && registry.status === 'ready' && Array.isArray(registry.parties)
    ? registry.parties : [];
  for (const party of parties) {
    mapping[party.code] = party.code;
    entity_metadata[party.code] = {
      entity_type: party.entityType,
      procedural_role: party.position,
      side: party.side,
      is_key_party: true,
    };
  }
  return { schema_version: 1, mapping, entity_metadata };
}

// ───────────────────────────── Relations déterministes ─────────────────────

/**
 * Relation `procedure_dossier -> partie` déterministe pour une position de
 * procédure (plan § 7.2) — jamais laissée au LLM.
 */
function partyRelationForPosition(position) {
  if (position === 'demandeur') return 'a_pour_demandeur';
  if (position === 'defendeur') return 'a_pour_defendeur';
  return 'a_pour_partie';
}

module.exports = {
  buildLegalPartyRegistry,
  partyCodeForSelection,
  partyRelationForPosition,
  serializeSafePartyRegistry,
};

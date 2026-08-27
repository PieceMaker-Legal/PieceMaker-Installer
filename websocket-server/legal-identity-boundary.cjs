/**
 * Frontière autoritative des identités du graphe juridique.
 *
 * Les codes sont appris depuis les structures du mapping et de la topologie,
 * jamais depuis une liste de préfixes de codes. Cette distinction permet de
 * traiter de la même façon PERSONNE_PHYSIQUE_01, P1, S1 ou un code cabinet.
 */
const crypto = require('node:crypto');

const PARTY_METADATA_FIELDS = Object.freeze([
  'entity_type', 'side', 'procedural_role', 'is_key_party',
]);

const IDENTITY_CATEGORIES = new Set([
  'personne', 'personnes', 'person', 'persons',
  'personne_physique', 'personnes_physiques', 'physical_person', 'physical_persons',
  'personne_morale', 'personnes_morales', 'legal_person', 'legal_persons',
  'societe', 'societes', 'company', 'companies', 'corporation', 'corporations',
  'entreprise', 'entreprises', 'organisation', 'organisations',
  'organization', 'organizations',
  'dirigeant', 'dirigeants', 'officer', 'officers',
  'representant', 'representants', 'representative', 'representatives',
  'mandataire', 'mandataires',
]);

function normalizedCategory(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isIdentityCategory(value) {
  return IDENTITY_CATEGORIES.has(normalizedCategory(value));
}

function own(record, key) {
  return Boolean(record && typeof record === 'object'
    && Object.prototype.hasOwnProperty.call(record, key));
}

function stringCode(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function addCodesFromContainer(target, container, codeUniverse = null) {
  if (!container || typeof container !== 'object' || Array.isArray(container)) return;
  for (const [key, value] of Object.entries(container)) {
    const keyCode = stringCode(key);
    const directCode = stringCode(value);
    const embeddedCode = value && typeof value === 'object' ? stringCode(value.code) : '';
    if (keyCode && (!codeUniverse || codeUniverse.has(keyCode))) target.add(keyCode);
    if (directCode) target.add(directCode);
    if (embeddedCode) target.add(embeddedCode);
  }
}

function metadataCategory(metadata) {
  if (typeof metadata === 'string') return metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  return metadata.entity_type || metadata.entityType || metadata.category
    || metadata.type || metadata.legal_kind || metadata.kind || '';
}

function addIdentityMetadataMap(target, metadataMap) {
  if (!metadataMap || typeof metadataMap !== 'object' || Array.isArray(metadataMap)) return;
  for (const [code, metadata] of Object.entries(metadataMap)) {
    if (isIdentityCategory(metadataCategory(metadata))) target.add(String(code));
  }
}

function mappingCodeUniverse(mappingDocument) {
  const codes = new Set();
  const direct = mappingDocument?.mapping;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    for (const value of Object.values(direct)) {
      const code = stringCode(value);
      if (code) codes.add(code);
    }
  }
  const reverse = mappingDocument?.reverse_mapping || mappingDocument?.reverseMapping;
  if (reverse && typeof reverse === 'object' && !Array.isArray(reverse)) {
    for (const code of Object.keys(reverse)) if (String(code).trim()) codes.add(String(code).trim());
  }
  return codes;
}

function escaped(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codesInLabel(label, codes) {
  const text = String(label || '');
  const found = [];
  for (const code of codes) {
    const matcher = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped(code)}(?=$|[^A-Za-z0-9_])`);
    if (matcher.test(text)) found.push(code);
  }
  return found;
}

function canonicalPartyId(code) {
  const slug = normalizedCategory(code).slice(0, 48) || 'code';
  const digest = crypto.createHash('sha256').update(String(code)).digest('hex').slice(0, 12);
  return `entite_${slug}_${digest}`;
}

/** Construit les ensembles nécessaires au contrôle du finalizer. */
function buildLegalIdentityBoundary(mappingDocument, topology) {
  const mappedCodes = mappingCodeUniverse(mappingDocument);
  const partyCodes = new Set((topology?.registry?.parties || [])
    .map((party) => String(party?.code || '').trim()).filter(Boolean));
  // Le mapping complet contient aussi des adresses, dates, SIREN, courriels,
  // etc. Il sert d'univers de résolution, pas de registre d'identités : seuls
  // le registre des parties, l'index personne/société et les métadonnées de
  // catégorie ci-dessous peuvent classer un code comme identitaire. Les codes
  // opaques P1/S1 restent couverts lorsqu'ils proviennent de ces sources, sans
  // jamais déduire leur type depuis leur préfixe.
  const identityCodes = new Set(partyCodes);

  // La topologie a déjà classé ces codes comme personne/société à partir de
  // l'index documentaire ; elle couvre notamment les décisions manuelles.
  const documents = topology?.documentRecords || topology?.documents || [];
  for (const document of documents) {
    for (const code of document?.codes || []) {
      const normalized = String(code || '').trim();
      if (normalized) identityCodes.add(normalized);
    }
  }

  // Format courant et alias historique de `extracted_data`.
  for (const extracted of [mappingDocument?.extracted_data, mappingDocument?.extractedData]) {
    if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) continue;
    for (const [category, entries] of Object.entries(extracted)) {
      if (isIdentityCategory(category)) addCodesFromContainer(identityCodes, entries, mappedCodes);
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [code, metadata] of Object.entries(entries)) {
        if (isIdentityCategory(metadataCategory(metadata))) identityCodes.add(String(code));
      }
    }
  }

  // Métadonnées récentes ou personnalisées, sans imposer leur nom de clé aux
  // anciens dossiers PieceMaker.
  for (const metadataMap of [
    mappingDocument?.entity_metadata,
    mappingDocument?.entityMetadata,
    mappingDocument?.code_categories,
    mappingDocument?.entity_categories,
    mappingDocument?.category_by_code,
    mappingDocument?.metadata_by_code,
    mappingDocument?.mapping_metadata,
  ]) addIdentityMetadataMap(identityCodes, metadataMap);

  // Anciens mappings où les catégories étaient des conteneurs de premier
  // niveau, ou imbriquées sous `mapping`.
  for (const source of [mappingDocument, mappingDocument?.mapping]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const [category, entries] of Object.entries(source)) {
      if (isIdentityCategory(category)) addCodesFromContainer(identityCodes, entries, mappedCodes);
    }
  }

  for (const code of identityCodes) mappedCodes.add(code);
  const contextCodesByFile = new Map();
  for (const document of documents) {
    const contextual = new Set((document?.codes || [])
      .map((code) => String(code || '').trim())
      .filter((code) => code && identityCodes.has(code) && !partyCodes.has(code)));
    contextCodesByFile.set(String(document?.file || ''), contextual);
  }

  return { mappedCodes, identityCodes, partyCodes, contextCodesByFile };
}

function identityAttemptForNode(node, boundary) {
  const label = String(node?.label || '').trim();
  const id = String(node?.id || '').trim();
  const exactCode = boundary.identityCodes.has(label) ? label : null;
  const idCode = boundary.identityCodes.has(id) ? id : null;
  const mentionedCodes = codesInLabel(label, boundary.identityCodes);
  const forbiddenFields = PARTY_METADATA_FIELDS.filter((field) => own(node, field));
  const rawKind = normalizedCategory(node?.legal_kind);
  const rawEntityType = normalizedCategory(node?.entity_type);
  const rawFileType = normalizedCategory(node?.file_type);
  const identityKind = isIdentityCategory(rawKind)
    || isIdentityCategory(rawEntityType)
    || isIdentityCategory(rawFileType);
  // Un concept utile doit porter un code tiers dans `context_entity_codes`,
  // jamais l'enfouir dans son libellé. Toute décoration d'un code identitaire
  // tiers est donc rejetée, même sans mot-indice ("témoin", "dirigeant", etc.).
  // Un concept juridique peut légitimement nommer une partie autorisée
  // (p. ex. « obligation de SAS_1 »). Seule la décoration d'une identité
  // tierce constitue ici une tentative de créer une identité hors registre.
  const decoratedCodes = mentionedCodes.filter((code) => !boundary.partyCodes.has(code));
  const decoratedIdentity = decoratedCodes.length > 0;
  const reasons = [];
  if (exactCode) reasons.push('code_identite_exact');
  if (idCode) reasons.push('code_identite_comme_identifiant');
  if (decoratedIdentity) reasons.push('libelle_identitaire_decore');
  if (identityKind) reasons.push('type_identitaire');
  if (forbiddenFields.length) reasons.push('metadonnees_partie_forgees');
  if (!reasons.length) return null;
  return {
    code: exactCode || idCode || decoratedCodes[0] || null,
    codes: decoratedCodes,
    forbiddenFields,
    reasons,
  };
}

function sanitizeContextEntityCodes(value, boundary, sourceFile) {
  if (!Array.isArray(value)) return [];
  const allowed = boundary.contextCodesByFile.get(String(sourceFile || '')) || new Set();
  return [...new Set(value
    .map((code) => String(code || '').trim())
    .filter((code) => code && allowed.has(code) && !boundary.partyCodes.has(code)))]
    .sort((left, right) => left.localeCompare(right));
}

function nonPartyIdentityQualityFlag(node, attempt, sourceFile) {
  const fingerprint = crypto.createHash('sha256')
    .update(`${String(node?.id || '')}\u0000${String(node?.label || '')}`)
    .digest('hex').slice(0, 16);
  return {
    type: 'NON_PARTY_IDENTITY_ATTEMPT',
    code: attempt.code || null,
    node_ref: `NODE_${fingerprint.toUpperCase()}`,
    source_file: String(sourceFile || ''),
    reasons: [...new Set(attempt.reasons)].sort(),
    action: 'rejected',
  };
}

module.exports = {
  PARTY_METADATA_FIELDS,
  buildLegalIdentityBoundary,
  canonicalPartyId,
  codesInLabel,
  identityAttemptForNode,
  isIdentityCategory,
  nonPartyIdentityQualityFlag,
  sanitizeContextEntityCodes,
};

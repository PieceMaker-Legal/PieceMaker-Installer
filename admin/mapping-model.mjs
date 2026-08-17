/**
 * Modèle pur de l'éditeur de mapping.
 *
 * Le fichier JSON reste volontairement plat pour l'anonymisation
 * (`variant -> code`). L'éditeur, lui, travaille par code : une seule ligne
 * porte le nom anonymisé, le variant principal utilisé au revert et ses autres
 * écritures. C'est le même regroupement que l'éditeur historique du task pane.
 */

// Sigles de sociétés — miroir navigateur de `websocket-server/legal-forms.cjs`
// (lui-même miroir de `_LEGAL_FORMS` dans `scripts/scan_utils.py`). Ce module est
// servi tel quel au navigateur : il ne peut pas `import` le `.cjs` côté serveur,
// d'où la copie. Toute modification d'un sigle doit être répercutée aux trois
// endroits. Sert à reconnaître les codes à sigle (SA_1, GMBH_2) comme des sociétés.
const LEGAL_FORM_TOKENS = new Set([
  'SELARL', 'SELAS', 'SELCA', 'SELCS', 'SASU', 'SARL', 'EURL', 'EARL',
  'SCOP', 'SCIC', 'GAEC', 'SAS', 'SCI', 'SCA', 'SCS', 'SCP', 'SCM', 'SNC',
  'GIE', 'SLP', 'SEL', 'SEM',
  'EEIG', 'CIC', 'CIO', 'CLG', 'RTM', 'PLC', 'LTD',
  'LLLP', 'PLLC', 'LLC', 'LLP', 'INC', 'CORP', 'LP', 'GP', 'PC', 'PA', 'CO',
  'PARTG', 'GMBH', 'KGAA', 'OHG', 'GBR', 'KG', 'AG', 'UG', 'EG', 'EK',
  'SE', 'SA', 'BV', 'NV', 'SPA', 'SRL', 'SL', 'LDA', 'AB', 'OY', 'APS', 'AS',
  'PTYLTD', 'PVTLTD',
]);

/** Un code désigne-t-il une société ? (repli/legacy …MORALE…/SOCIETE_ ou sigle) */
function isSocieteCode(code) {
  const normalizedCode = String(code || '').replace(/\s+/g, '_').toUpperCase();
  if (normalizedCode.includes('MORALE') || normalizedCode.includes('SOCIETE')) return true;
  return normalizedCode
    .replace(/_\d+$/, '')
    .split('_')
    .filter(Boolean)
    .some((token) => LEGAL_FORM_TOKENS.has(token));
}

function clean(value) {
  return String(value || '').trim();
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function preferredVariant(variants, reverseValue) {
  const preferred = clean(Array.isArray(reverseValue) ? reverseValue[0] : reverseValue);
  if (preferred && variants.includes(preferred)) return preferred;
  return variants.find((variant) => variant === variant.toUpperCase())
    || variants.find((variant) => variant[0] === variant[0].toUpperCase())
    || variants[0];
}

/**
 * Regroupe un mapping plat par nom anonymisé.
 *
 * Le premier élément de `reverse_mapping[code]` est canonique. S'il est absent
 * du mapping direct (fichier ancien ou incohérent), on reprend la même règle de
 * repli que l'éditeur original : capitales, initiale capitale, premier variant.
 */
export function groupMappingByCode(mapping = {}, reverseMapping = {}) {
  const codeToVariants = new Map();
  for (const [rawVariant, rawCode] of Object.entries(mapping || {})) {
    const variant = clean(rawVariant);
    const code = clean(rawCode);
    if (!variant || !code) continue;
    if (!codeToVariants.has(code)) codeToVariants.set(code, []);
    const variants = codeToVariants.get(code);
    if (!variants.includes(variant)) variants.push(variant);
  }

  return [...codeToVariants].map(([code, variants]) => {
    const principal = preferredVariant(variants, reverseMapping?.[code]);
    return {
      code,
      principal,
      variants: variants.filter((variant) => variant !== principal),
    };
  });
}

export class MappingValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'MappingValidationError';
    Object.assign(this, details);
  }
}

/**
 * Reconstruit le document plat attendu par le pipeline.
 *
 * Plusieurs variants peuvent et doivent partager un code dans une même ligne.
 * Seuls un code dupliqué entre deux lignes ou un variant attribué à deux codes
 * différents constituent un conflit.
 */
export function buildMappingDocument(groups = []) {
  const mapping = {};
  const reverseMapping = {};
  const codeRows = new Map();
  const variantCodes = new Map();

  groups.forEach((group, rowIndex) => {
    const code = clean(group?.code);
    const principal = clean(group?.principal);
    const otherVariants = Array.isArray(group?.variants) ? group.variants : [];
    const hasContent = Boolean(code || principal || otherVariants.some((variant) => clean(variant)));
    if (!hasContent) return;

    if (!code) {
      throw new MappingValidationError('Chaque entrée demande un nom anonymisé.', { rowIndex, field: 'code' });
    }
    if (!principal) {
      throw new MappingValidationError('Chaque entrée demande un variant principal pour le revert.', { rowIndex, field: 'principal' });
    }
    if (codeRows.has(code)) {
      throw new MappingValidationError(`Le nom anonymisé « ${code} » apparaît sur plusieurs lignes.`, { rowIndex, field: 'code' });
    }

    const variants = unique([principal, ...otherVariants]);
    for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
      const variant = variants[variantIndex];
      const previousCode = variantCodes.get(variant);
      if (previousCode && previousCode !== code) {
        throw new MappingValidationError(
          `Le variant « ${variant} » est déjà attribué au nom anonymisé « ${previousCode} ».`,
          { rowIndex, field: variant === principal ? 'principal' : 'variant', variant }
        );
      }
      mapping[variant] = code;
      variantCodes.set(variant, code);
    }

    reverseMapping[code] = variants;
    codeRows.set(code, rowIndex);
  });

  return { mapping, reverse_mapping: reverseMapping };
}

export const PROCEDURE_POSITIONS = [
  { value: 'demandeur', label: 'Demandeur' },
  { value: 'defendeur', label: 'Défendeur' },
  { value: 'appelant', label: 'Appelant' },
  { value: 'intime', label: 'Intimé' },
  { value: 'requerant', label: 'Requérant' },
  { value: 'mis_en_cause', label: 'Mis en cause' },
  { value: 'intervenant', label: 'Intervenant' },
  { value: 'autre', label: 'Autre' },
];

const PROCEDURE_POSITION_VALUES = new Set(PROCEDURE_POSITIONS.map(({ value }) => value));

function normalized(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('fr');
}

function codeToken(value, fallback = 'AUTRE') {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

function partyCategoryForCode(code) {
  const value = codeToken(code);
  if (value.startsWith('SIREN_')) return 'siren';
  if (value.startsWith('ADRESSE_') || value.startsWith('LIEU_NAISSANCE_')) return 'adresses';
  if (value.includes('PERSONNE_PHYSIQUE') || value.startsWith('DIRIGEANT_')) return 'personnes_physiques';
  if (isSocieteCode(value)) return 'societes';
  return 'autres';
}

function normalizeAssignments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((assignment) => ({
    field: clean(assignment?.field),
    code: clean(assignment?.code),
    original_code: clean(assignment?.original_code),
    category: clean(assignment?.category) || partyCategoryForCode(assignment?.code),
    principal: clean(assignment?.principal),
    variants: unique(Array.isArray(assignment?.variants) ? assignment.variants : []),
  })).filter((assignment) => assignment.code && assignment.variants.length);
}

function normalizeParty(raw, side) {
  const party = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const type = party.type === 'societe' ? 'societe' : 'personne_physique';
  const fallbackPosition = side === 'client' ? 'demandeur' : 'defendeur';
  const position = PROCEDURE_POSITION_VALUES.has(party.position) ? party.position : fallbackPosition;
  return {
    type,
    position,
    position_libelle: position === 'autre' ? clean(party.position_libelle) : '',
    civilite: type === 'personne_physique' ? clean(party.civilite) : '',
    nom: type === 'personne_physique' ? clean(party.nom) : '',
    date_naissance: type === 'personne_physique' ? clean(party.date_naissance) : '',
    lieu_naissance: type === 'personne_physique' ? clean(party.lieu_naissance) : '',
    adresse: type === 'personne_physique' ? clean(party.adresse) : '',
    societe_nom: type === 'societe' ? clean(party.societe_nom) : '',
    forme_sociale: type === 'societe' ? clean(party.forme_sociale) : '',
    siren: type === 'societe' ? clean(party.siren) : '',
    siege_social: type === 'societe' ? clean(party.siege_social) : '',
    representant: type === 'societe' ? clean(party.representant) : '',
    mapping_assignments: normalizeAssignments(party.mapping_assignments),
  };
}

/** Structure stable stockée dans `mapping_default.json`. */
export function normalizeProcedureInfo(info = {}) {
  const source = info && typeof info === 'object' && !Array.isArray(info) ? info : {};
  return {
    parties_clientes: (Array.isArray(source.parties_clientes) ? source.parties_clientes : [])
      .map((party) => normalizeParty(party, 'client')),
    parties_adverses: (Array.isArray(source.parties_adverses) ? source.parties_adverses : [])
      .map((party) => normalizeParty(party, 'adversaire')),
  };
}

export function partyDisplayName(party) {
  if (party?.type === 'societe') {
    return [clean(party.forme_sociale), clean(party.societe_nom)].filter(Boolean).join(' ');
  }
  const name = clean(party?.nom);
  const title = clean(party?.civilite);
  return title && !normalized(name).startsWith(`${normalized(title)} `) ? `${title} ${name}`.trim() : name;
}

export function procedureSummary(info = {}) {
  const normalizedInfo = normalizeProcedureInfo(info);
  const names = (parties) => parties.map(partyDisplayName).filter(Boolean);
  return {
    client: names(normalizedInfo.parties_clientes),
    adverse: names(normalizedInfo.parties_adverses),
  };
}

/** Variants principaux proposés dans la combo, filtrés par nature de partie. */
export function principalPartyOptions(mapping = {}, reverseMapping = {}, type = 'personne_physique') {
  const expected = type === 'societe' ? 'societes' : 'personnes_physiques';
  return groupMappingByCode(mapping, reverseMapping)
    .filter((group) => partyCategoryForCode(group.code) === expected)
    .map(({ code, principal }) => ({ code, principal }));
}

function nextGenericCode(category, codes) {
  const prefix = {
    personnes_physiques: 'PERSONNE_PHYSIQUE',
    societes: 'PERSONNE_MORALE',
    adresses: 'ADRESSE',
    siren: 'SIREN',
    autres: 'AUTRE',
  }[category] || 'AUTRE';
  let highest = 0;
  for (const code of codes) {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(code);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}_${String(highest + 1).padStart(2, '0')}`;
}

function restorePreviousAssignments(document, previousInfo) {
  const mapping = { ...document.mapping };
  const reverseMapping = { ...document.reverse_mapping };
  const parties = [
    ...normalizeProcedureInfo(previousInfo).parties_clientes,
    ...normalizeProcedureInfo(previousInfo).parties_adverses,
  ];

  for (const party of parties) {
    for (const assignment of party.mapping_assignments) {
      const variants = assignment.variants.filter((variant) => mapping[variant] === assignment.code);
      if (!variants.length) continue;
      const occupiedOutsideAssignment = assignment.original_code && Object.entries(mapping)
        .some(([variant, code]) => code === assignment.original_code && !variants.includes(variant));
      const restoredCode = assignment.original_code && !occupiedOutsideAssignment
        ? assignment.original_code
        : nextGenericCode(assignment.category, new Set(Object.values(mapping)));
      for (const variant of variants) mapping[variant] = restoredCode;
      reverseMapping[restoredCode] = unique([assignment.principal, ...variants]);
    }
  }

  return buildMappingDocument(groupMappingByCode(mapping, reverseMapping));
}

function findGroup(document, value) {
  const needle = normalized(value);
  if (!needle) return null;
  const groups = groupMappingByCode(document.mapping, document.reverse_mapping);
  return groups.find((group) => normalized(group.principal) === needle)
    || groups.find((group) => group.variants.some((variant) => normalized(variant) === needle))
    || null;
}

function assignValue(document, value, code, field, category, claimedVariants) {
  const principal = clean(value);
  if (!principal) return null;
  const source = findGroup(document, principal);
  const variants = source ? unique([source.principal, ...source.variants]) : [principal];
  for (const variant of variants) {
    const previousClaim = claimedVariants.get(variant);
    if (previousClaim && previousClaim !== code) {
      throw new MappingValidationError(`Le variant « ${variant} » ne peut pas identifier deux parties de la procédure.`, {
        field: 'party', variant,
      });
    }
    claimedVariants.set(variant, code);
    document.mapping[variant] = code;
  }
  document.reverse_mapping[code] = unique([principal, ...variants]);
  return {
    field,
    code,
    original_code: source?.code || '',
    category,
    principal,
    variants,
  };
}

function partyRoleToken(party) {
  return codeToken(party.position === 'autre' ? party.position_libelle : party.position);
}

function applySideAssignments(document, parties, side, claimedVariants) {
  const sideToken = side === 'client' ? 'CLIENT' : 'ADVERSAIRE';
  return parties.map((party, index) => {
    const number = String(index + 1).padStart(2, '0');
    const role = partyRoleToken(party);
    const prefix = `${sideToken}_${role}`;
    const assignments = [];
    const add = (value, code, field, category) => {
      const assignment = assignValue(document, value, code, field, category, claimedVariants);
      if (assignment) assignments.push(assignment);
    };

    if (party.type === 'societe') {
      add(party.societe_nom, `${prefix}_PERSONNE_MORALE_${number}`, 'identite', 'societes');
      add(party.siren, `SIREN_${prefix}_${number}`, 'siren', 'siren');
      add(party.siege_social, `ADRESSE_${prefix}_${number}`, 'siege_social', 'adresses');
      add(party.representant, `DIRIGEANT_${prefix}_${number}`, 'representant', 'personnes_physiques');
    } else {
      add(party.nom, `${prefix}_PERSONNE_PHYSIQUE_${number}`, 'identite', 'personnes_physiques');
      add(party.date_naissance, `DATE_NAISSANCE_${prefix}_${number}`, 'date_naissance', 'autres');
      add(party.lieu_naissance, `LIEU_NAISSANCE_${prefix}_${number}`, 'lieu_naissance', 'adresses');
      add(party.adresse, `ADRESSE_${prefix}_${number}`, 'adresse', 'adresses');
    }
    return { ...party, mapping_assignments: assignments };
  });
}

/**
 * Remplace les codes génériques des variants choisis par leurs rôles dans la
 * procédure, tout en permettant une édition ultérieure sans perdre d'entité.
 */
export function applyProcedureParties(mappingDocument = {}, previousInfo = {}, nextInfo = {}) {
  const base = buildMappingDocument(groupMappingByCode(
    mappingDocument.mapping || {},
    mappingDocument.reverse_mapping || {},
  ));
  const document = restorePreviousAssignments(base, previousInfo);
  const info = normalizeProcedureInfo(nextInfo);
  const claimedVariants = new Map();
  const parties_clientes = applySideAssignments(document, info.parties_clientes, 'client', claimedVariants);
  const parties_adverses = applySideAssignments(document, info.parties_adverses, 'adversaire', claimedVariants);
  const rebuilt = buildMappingDocument(groupMappingByCode(document.mapping, document.reverse_mapping));
  return {
    ...rebuilt,
    informations_dossier: { parties_clientes, parties_adverses },
  };
}

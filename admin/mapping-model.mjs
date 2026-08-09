/**
 * Modèle pur de l'éditeur de mapping.
 *
 * Le fichier JSON reste volontairement plat pour l'anonymisation
 * (`variant -> code`). L'éditeur, lui, travaille par code : une seule ligne
 * porte le nom anonymisé, le variant principal utilisé au revert et ses autres
 * écritures. C'est le même regroupement que l'éditeur historique du task pane.
 */

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

/**
 * Outil doc_styles — table des styles du document Word ouvert.
 *
 * Indépendant de l'injection de template : rien n'est lu ni copié depuis un
 * fichier .docx. On lit la table de styles du document, on redéfinit les
 * propriétés demandées, et Word propage la mise en forme à tous les paragraphes
 * qui portent le style. Aucun contenu n'est touché, aucun style n'est créé ni
 * supprimé.
 */

// Propriétés lisibles et modifiables. Toute propriété hors de ces listes est
// refusée par le schéma de l'outil, et ignorée ici par sécurité.
export const FONT_PROPERTIES = [
  'name',
  'size',
  'color',
  'highlightColor',
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'allCaps',
  'smallCaps'
];

export const PARAGRAPH_FORMAT_PROPERTIES = [
  'alignment',
  'leftIndent',
  'rightIndent',
  'firstLineIndent',
  'spaceBefore',
  'spaceAfter',
  'lineSpacing',
  'lineUnitBefore',
  'lineUnitAfter',
  'outlineLevel',
  'keepTogether',
  'keepWithNext',
  'widowControl'
];

// Seuls les styles de texte intéressent la rédaction : les styles de tableau ou
// de liste ne sont jamais renvoyés.
const TEXT_STYLE_TYPES = new Set(['Paragraph', 'Character']);

// Socle toujours renvoyé en portée « used », même si le document ne l'emploie
// pas encore : c'est la table que l'utilisateur veut régler avant d'écrire.
const CORE_STYLE_NAMES = [
  'Normal',
  'Title',
  'Subtitle',
  'Body Text',
  'Quote',
  'List Paragraph',
  'Footnote Text',
  ...Array.from({ length: 9 }, (_, i) => `Heading ${i + 1}`)
];

// Word localise le nom des styles intégrés. Le modèle raisonne en anglais, le
// document d'un cabinet français répond « Titre 1 » : on rapproche les deux
// sans imposer de langue.
const STYLE_NAME_ALIASES = [
  ['Normal', 'Normal'],
  ['Title', 'Titre'],
  ['Subtitle', 'Sous-titre'],
  ['Body Text', 'Corps de texte'],
  ['Quote', 'Citation'],
  ['List Paragraph', 'Paragraphe de liste'],
  ['Footnote Text', 'Note de bas de page'],
  ...Array.from({ length: 9 }, (_, i) => [`Heading ${i + 1}`, `Titre ${i + 1}`])
];

function normalizeName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Tous les noms équivalents d'un style : le nom lui-même plus, s'il fait partie
 * du socle intégré, sa traduction.
 */
function nameVariants(name) {
  const normalized = normalizeName(name);
  const variants = new Set([normalized]);
  for (const [english, french] of STYLE_NAME_ALIASES) {
    const pair = [normalizeName(english), normalizeName(french)];
    if (pair.includes(normalized)) pair.forEach((variant) => variants.add(variant));
  }
  return variants;
}

function sameStyleName(left, right) {
  const rightVariants = nameVariants(right);
  for (const variant of nameVariants(left)) {
    if (rightVariants.has(variant)) return true;
  }
  return false;
}

const CORE_STYLE_VARIANTS = new Set(
  CORE_STYLE_NAMES.flatMap((name) => Array.from(nameVariants(name)))
);

function isCoreStyle(name) {
  return CORE_STYLE_VARIANTS.has(normalizeName(name));
}

/**
 * Filtre la table selon « names » (prioritaire) puis « scope ».
 * @param {Array<{nameLocal: string, builtIn?: boolean, inUse?: boolean, type?: string}>} entries
 * @param {{names?: string[], scope?: string}} options
 */
export function selectStyles(entries, options = {}) {
  const { names = null, scope = 'used' } = options;
  const textStyles = entries.filter((entry) => !entry.type || TEXT_STYLE_TYPES.has(entry.type));

  if (Array.isArray(names) && names.length) {
    return textStyles.filter((entry) => names.some((name) => sameStyleName(entry.nameLocal, name)));
  }

  if (scope === 'all') return textStyles;

  return textStyles.filter((entry) => entry.inUse === true || isCoreStyle(entry.nameLocal));
}

// Word renvoie ces marqueurs quand la propriété n'a pas de valeur propre : les
// laisser passer gonflerait la réponse sans rien apprendre au modèle.
const EMPTY_VALUES = new Set(['', 'Mixed', 'Unknown']);

function pickDefined(source, properties) {
  const picked = {};
  for (const property of properties) {
    const value = source?.[property];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && EMPTY_VALUES.has(value)) continue;
    picked[property] = value;
  }
  return picked;
}

/**
 * Met un style à plat pour le modèle : propriétés non définies omises.
 */
export function serializeStyleShape(raw) {
  const serialized = { name: raw.nameLocal };
  if (raw.type !== undefined) serialized.type = raw.type;
  if (raw.builtIn !== undefined) serialized.builtIn = raw.builtIn;
  if (raw.inUse !== undefined) serialized.inUse = raw.inUse;

  const font = pickDefined(raw.font, FONT_PROPERTIES);
  if (Object.keys(font).length) serialized.font = font;

  const paragraphFormat = pickDefined(raw.paragraphFormat, PARAGRAPH_FORMAT_PROPERTIES);
  if (Object.keys(paragraphFormat).length) serialized.paragraphFormat = paragraphFormat;

  return serialized;
}

/**
 * Retrouve un style de la collection par son nom, en tolérant la casse et la
 * langue de Word.
 */
export function matchStyle(items, name) {
  return items.find((item) => sameStyleName(item.nameLocal, name)) || null;
}

function stylesApiUnavailable() {
  const isSetSupported = globalThis.Office?.context?.requirements?.isSetSupported;
  if (typeof isSetSupported !== 'function') return null;
  if (isSetSupported.call(globalThis.Office.context.requirements, 'WordApi', '1.5')) return null;
  return {
    error: 'La table des styles exige WordApi 1.5. Cette version de Word ne l’expose pas : régler les styles directement dans Word.'
  };
}

async function readStyles(params) {
  const names = Array.isArray(params.names) && params.names.length ? params.names : null;
  const scope = params.scope === 'all' ? 'all' : 'used';

  return await Word.run(async (context) => {
    const styles = context.document.getStyles();
    styles.load('items/nameLocal,items/builtIn,items/inUse,items/type');
    await context.sync();

    const retained = selectStyles(
      styles.items.map((style) => ({
        nameLocal: style.nameLocal,
        builtIn: style.builtIn,
        inUse: style.inUse,
        type: style.type
      })),
      { names, scope }
    );

    if (!retained.length) {
      return {
        styles: [],
        note: names
          ? 'Aucun style ne porte ces noms. Relancer sans « names » pour voir la table réelle.'
          : 'Aucun style de texte trouvé dans ce document.'
      };
    }

    const retainedNames = new Set(retained.map((entry) => normalizeName(entry.nameLocal)));
    const handles = styles.items.filter((style) => retainedNames.has(normalizeName(style.nameLocal)));

    for (const style of handles) {
      style.font.load(FONT_PROPERTIES.join(','));
      style.paragraphFormat.load(PARAGRAPH_FORMAT_PROPERTIES.join(','));
    }

    // Un style exotique peut refuser le chargement groupé ; on retombe alors sur
    // un chargement style par style pour ne pas perdre toute la table.
    let loadedIndividually = false;
    try {
      await context.sync();
    } catch (error) {
      console.warn('[doc_styles] Chargement groupé refusé, reprise style par style :', error.message);
      loadedIndividually = true;
    }

    const serialized = [];
    for (const style of handles) {
      if (loadedIndividually) {
        try {
          style.font.load(FONT_PROPERTIES.join(','));
          style.paragraphFormat.load(PARAGRAPH_FORMAT_PROPERTIES.join(','));
          await context.sync();
        } catch (error) {
          serialized.push({ name: style.nameLocal, error: error.message });
          continue;
        }
      }
      try {
        serialized.push(serializeStyleShape({
          nameLocal: style.nameLocal,
          builtIn: style.builtIn,
          inUse: style.inUse,
          type: style.type,
          font: style.font,
          paragraphFormat: style.paragraphFormat
        }));
      } catch (error) {
        serialized.push({ name: style.nameLocal, error: error.message });
      }
    }

    return { scope: names ? 'names' : scope, styles: serialized };
  });
}

/**
 * Affecte les propriétés d'un style, une à une : une valeur refusée par Word ne
 * doit pas emporter les autres.
 */
function queueStyleProperties(target, entry) {
  const applied = [];
  const ignored = [];

  const groups = [
    ['font', FONT_PROPERTIES, target.font],
    ['paragraphFormat', PARAGRAPH_FORMAT_PROPERTIES, target.paragraphFormat]
  ];

  for (const [groupName, allowed, wordObject] of groups) {
    const source = entry[groupName];
    if (!source || typeof source !== 'object') continue;
    for (const [property, value] of Object.entries(source)) {
      if (!allowed.includes(property)) {
        ignored.push(`${groupName}.${property}`);
        continue;
      }
      try {
        wordObject[property] = value;
        applied.push(`${groupName}.${property}`);
      } catch (error) {
        ignored.push(`${groupName}.${property}`);
        console.warn(`[doc_styles] Propriété refusée ${groupName}.${property} :`, error.message);
      }
    }
  }

  return { applied, ignored };
}

async function writeStyles(params) {
  const requested = Array.isArray(params.styles) ? params.styles : [];
  if (!requested.length) {
    return { error: 'Aucun style à redéfinir : fournir « styles ».' };
  }

  return await Word.run(async (context) => {
    const styles = context.document.getStyles();
    styles.load('items/nameLocal,items/type');
    await context.sync();

    const updated = [];
    const skipped = [];

    for (const entry of requested) {
      const target = matchStyle(styles.items, entry.name);
      if (!target) {
        skipped.push({
          name: entry.name,
          reason: 'Style absent du document ; doc_styles ne crée aucun style. Vérifier le nom avec action « get ».'
        });
        continue;
      }

      const { applied, ignored } = queueStyleProperties(target, entry);
      if (!applied.length) {
        skipped.push({
          name: target.nameLocal,
          reason: ignored.length
            ? `Aucune propriété applicable (${ignored.join(', ')}).`
            : 'Aucune propriété fournie.'
        });
        continue;
      }

      try {
        await context.sync();
        const result = { name: target.nameLocal, applied };
        if (ignored.length) result.ignored = ignored;
        updated.push(result);
      } catch (error) {
        // Le lot a été refusé : on rejoue propriété par propriété pour isoler la
        // valeur fautive au lieu de perdre tout le style.
        const retryApplied = [];
        const retryFailed = [];
        for (const property of applied) {
          const [groupName, key] = property.split('.');
          try {
            target[groupName][key] = entry[groupName][key];
            await context.sync();
            retryApplied.push(property);
          } catch (retryError) {
            retryFailed.push(`${property} (${retryError.message})`);
          }
        }
        if (retryApplied.length) {
          updated.push({ name: target.nameLocal, applied: retryApplied, ignored: [...ignored, ...retryFailed] });
        } else {
          skipped.push({ name: target.nameLocal, reason: error.message });
        }
      }
    }

    // Un nom inconnu n'est pas une erreur : tant qu'un style a été redéfini,
    // l'appel a abouti. « skipped » dit le reste.
    return { success: updated.length > 0, updated, skipped };
  });
}

/**
 * Point d'entrée de l'outil doc_styles.
 * @param {{action: 'get'|'set', names?: string[], scope?: 'used'|'all', styles?: object[]}} params
 */
export async function docStyles(params = {}) {
  const unavailable = stylesApiUnavailable();
  if (unavailable) return unavailable;

  try {
    if (params.action === 'get') return await readStyles(params);
    if (params.action === 'set') return await writeStyles(params);
    return { error: `Action inconnue pour doc_styles : ${params.action}. Utiliser « get » ou « set ».` };
  } catch (error) {
    console.error('[doc_styles] Erreur :', error);
    return { error: error.message };
  }
}

// Fonctions pures exposées pour les tests hors Word. Elles ne font pas partie du
// schéma de l'outil et ne sont jamais envoyées au modèle.
export const __docStylesTestUtils = {
  isCoreStyle,
  matchStyle,
  nameVariants,
  normalizeName,
  sameStyleName,
  selectStyles,
  serializeStyleShape
};

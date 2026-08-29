function forbidProperties(...names) {
  return { not: { anyOf: names.map((name) => ({ required: [name] })) } };
}

const PANE_ID_PROPERTY = {
  type: 'string',
  pattern: '^[0-9a-zA-Z]{4}$',
  description: 'Identifiant du volet renvoyé par open_doc.'
};

export const REVISION_FILTER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    authors: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    types: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    }
  },
  anyOf: [{ required: ['authors'] }, { required: ['types'] }]
};

export const READ_REVISIONS_INPUT_SCHEMA = {
  type: 'object',
  description: 'Révisions R1, R2… et snapshot requis pour les actions de revue.',
  properties: {
    indexes: {
      type: 'array',
      minItems: 1,
      items: { type: 'integer', minimum: 1 },
      description: 'Index Rn à partir de 1, pas des paragraphes.'
    },
    authors: REVISION_FILTER_INPUT_SCHEMA.properties.authors,
    types: REVISION_FILTER_INPUT_SCHEMA.properties.types,
    from_revision: { type: 'integer', minimum: 1 },
    from_offset: { type: 'integer', minimum: 0 }
  }
};

const REVIEW_PROPERTIES = {
  action: { type: 'string', enum: ['show', 'display', 'accept', 'reject', 'accept_all', 'reject_all'] },
  snapshot: { type: 'string', minLength: 1, description: 'Snapshot renvoyé par read_doc.' },
  index: { type: 'integer', minimum: 1, description: 'Révision Rn à montrer.' },
  indexes: {
    type: 'array',
    minItems: 1,
    items: { type: 'integer', minimum: 1 },
    description: 'Révisions Rn exactes.'
  },
  filter: { ...REVISION_FILTER_INPUT_SCHEMA, description: 'Filtre auteur/type ; confirm=true.' },
  confirm: { type: 'boolean', description: 'true pour filtre/global.' },
  markup: { type: 'string', enum: ['none', 'simple', 'all'] },
  view: { type: 'string', enum: ['original', 'final'], description: 'Affichage Word uniquement.' },
  reviewers: { type: 'string', enum: ['all', 'none'] }
};

export const REVIEW_INPUT_SCHEMA = {
  type: 'object',
  description: 'show: snapshot+index ; display: markup/view/reviewers ; accept/reject: snapshot+indexes, ou filter+confirm=true ; *_all: snapshot+confirm=true.',
  properties: REVIEW_PROPERTIES,
  required: ['action']
};

const EDIT_ITEM_PROPERTIES = {
  operation: { type: 'string', enum: ['insert_before', 'insert_after', 'delete'] },
  target_index: { type: 'integer', minimum: 0, description: 'Index de paragraphe à partir de 0.' },
  text: { type: 'string', minLength: 1 },
  indexes_to_delete: {
    type: 'array',
    minItems: 1,
    items: { type: 'integer', minimum: 0 },
    description: 'Index de paragraphes à partir de 0.'
  }
};

const EDIT_ITEM_SCHEMA = {
  type: 'object',
  description: 'insert_*: target_index+text ; delete: indexes_to_delete.',
  properties: EDIT_ITEM_PROPERTIES,
  required: ['operation']
};

const READ_DOC_PROPERTIES = {
  paneId: PANE_ID_PROPERTY,
  list_headings: { type: 'boolean', description: 'Renvoie seulement les titres indexés.' },
  heading: { type: 'string', minLength: 1, description: 'Titre ou index du titre à lire.' },
  indexes: {
    oneOf: [
      { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } },
      { type: 'string', pattern: '^\\d+(?:-\\d+)?$' }
    ],
    description: 'Index de paragraphes à partir de 0, ou plage telle que "5-20".'
  },
  revision_view: {
    type: 'string',
    enum: ['current', 'original'],
    description: 'Texte courant/final ou original ; review.view règle seulement l’affichage Word.'
  },
  revisions: READ_REVISIONS_INPUT_SCHEMA,
  from_index: { type: 'integer', minimum: 0, description: 'Index de paragraphe où reprendre.' },
  from_offset: { type: 'integer', minimum: 0, description: 'Offset de reprise ; interdit dans un paragraphe avec notes.' },
  max_chars: {
    type: 'integer',
    minimum: 500,
    maximum: 100000,
    default: 100000,
    description: 'Plafond en caractères, environ 25 000 tokens.'
  }
};

export const READ_DOC_TOOL = {
  name: 'read_doc',
  description: 'Lit le Word en Markdown indexé ou ses révisions Rn. Notes avec leur paragraphe ; commentaires en <!-- contenu -->.',
  inputSchema: {
    type: 'object',
    properties: READ_DOC_PROPERTIES,
    required: ['paneId'],
    oneOf: [
      {
        properties: { list_headings: { const: true } },
        required: ['list_headings']
      },
      { required: ['heading'] },
      { required: ['indexes'] },
      {
        required: ['revisions'],
        ...forbidProperties('revision_view', 'from_index', 'from_offset')
      },
      {
        properties: { list_headings: { const: false } },
        ...forbidProperties('heading', 'indexes', 'revisions')
      }
    ]
  }
};

const EDIT_DOC_PROPERTIES = {
  paneId: PANE_ID_PROPERTY,
  ...EDIT_ITEM_PROPERTIES,
  track_changes: {
    type: 'boolean',
    default: true,
    description: 'true par défaut ; false écrit directement ; mode Word restauré.'
  },
  review: REVIEW_INPUT_SCHEMA,
  edits: {
    type: 'array',
    minItems: 1,
    maxItems: 50,
    description: 'Lot fondé sur une même lecture.',
    items: EDIT_ITEM_SCHEMA
  }
};

export const EDIT_DOC_TOOL = {
  name: 'edit_doc',
  description: 'Modifie les paragraphes ou révise. Markdown, notes GFM/Pandoc [^id] + définition séparée [^id]:, commentaires <!-- contenu -->.',
  inputSchema: {
    type: 'object',
    properties: EDIT_DOC_PROPERTIES,
    required: ['paneId'],
    oneOf: [
      {
        properties: { operation: { enum: ['insert_before', 'insert_after'] } },
        required: ['operation', 'target_index', 'text']
      },
      {
        properties: { operation: { const: 'delete' } },
        required: ['operation', 'indexes_to_delete']
      },
      { required: ['edits'] },
      { required: ['review'] }
    ]
  }
};

export const TEMPLATE_TOOL = {
  name: 'template',
  description: 'Injecte un template .docx local dans le document Word ouvert et renvoie { success: true, content: texte intégral du template, placeholders inclus }. Remplace intégralement le contenu et les styles ; utiliser uniquement sur un document de travail.',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: PANE_ID_PROPERTY,
      path: {
        type: 'string',
        minLength: 1,
        description: 'Chemin absolu du fichier template .docx à injecter.'
      }
    },
    required: ['paneId', 'path']
  }
};

const STYLE_FONT_SCHEMA = {
  type: 'object',
  description: 'Propriétés de police du style.',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, description: 'Nom de la police, ex. « Times New Roman ».' },
    size: { type: 'number', minimum: 1, maximum: 1638, description: 'Taille en points.' },
    color: { type: 'string', minLength: 1, description: 'Couleur #RRGGBB ou nom Word.' },
    highlightColor: { type: 'string', minLength: 1 },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    underline: {
      type: 'string',
      enum: ['None', 'Single', 'Double', 'Thick', 'Dotted', 'DashLine', 'Wave']
    },
    strikeThrough: { type: 'boolean' },
    allCaps: { type: 'boolean' },
    smallCaps: { type: 'boolean' }
  }
};

const STYLE_PARAGRAPH_FORMAT_SCHEMA = {
  type: 'object',
  description: 'Format de paragraphe du style. Indentations et espacements en points.',
  additionalProperties: false,
  properties: {
    alignment: { type: 'string', enum: ['Left', 'Centered', 'Right', 'Justified'] },
    leftIndent: { type: 'number' },
    rightIndent: { type: 'number' },
    firstLineIndent: { type: 'number' },
    spaceBefore: { type: 'number', minimum: 0 },
    spaceAfter: { type: 'number', minimum: 0 },
    lineSpacing: { type: 'number', minimum: 0, description: 'Interligne en points ; 12 pt ≈ simple sur du 12.' },
    lineUnitBefore: { type: 'number', minimum: 0 },
    lineUnitAfter: { type: 'number', minimum: 0 },
    outlineLevel: {
      type: 'string',
      enum: [
        'OutlineLevel1', 'OutlineLevel2', 'OutlineLevel3', 'OutlineLevel4', 'OutlineLevel5',
        'OutlineLevel6', 'OutlineLevel7', 'OutlineLevel8', 'OutlineLevel9', 'OutlineLevelBodyText'
      ]
    },
    keepTogether: { type: 'boolean' },
    keepWithNext: { type: 'boolean' },
    widowControl: { type: 'boolean' }
  }
};

const STYLE_UPDATE_SCHEMA = {
  type: 'object',
  description: 'Style à redéfinir ; seules les propriétés fournies changent.',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, description: 'Nom exact renvoyé par action « get », ex. « Heading 1 ».' },
    font: STYLE_FONT_SCHEMA,
    paragraphFormat: STYLE_PARAGRAPH_FORMAT_SCHEMA
  },
  required: ['name'],
  anyOf: [{ required: ['font'] }, { required: ['paragraphFormat'] }]
};

export const DOC_STYLES_TOOL = {
  name: 'doc_styles',
  description: 'Lit la table des styles du document Word ouvert (police, taille, couleur, alignement, espacements par style) ou en redéfinit. Une redéfinition se propage à tous les paragraphes portant le style — aucun contenu n’est touché. Indépendant de « template ».',
  inputSchema: {
    type: 'object',
    properties: {
      paneId: PANE_ID_PROPERTY,
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: 'get : lire la table ; set : redéfinir des styles existants.'
      },
      names: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: { type: 'string', minLength: 1 },
        description: 'get : restreindre à ces styles ; l’emporte sur scope.'
      },
      scope: {
        type: 'string',
        enum: ['used', 'all'],
        default: 'used',
        description: 'get : « used » = styles utilisés plus le socle Normal/Titres ; « all » = toute la table.'
      },
      styles: {
        type: 'array',
        minItems: 1,
        maxItems: 40,
        items: STYLE_UPDATE_SCHEMA,
        description: 'set : styles à redéfinir. Un nom inconnu n’est jamais créé, il revient dans « skipped ».'
      }
    },
    required: ['paneId', 'action'],
    oneOf: [
      {
        properties: { action: { const: 'get' } },
        ...forbidProperties('styles')
      },
      {
        properties: { action: { const: 'set' } },
        required: ['styles'],
        ...forbidProperties('names', 'scope')
      }
    ]
  }
};

export function toEmbeddedTool(tool) {
  const { paneId, ...properties } = tool.inputSchema.properties;
  const required = (tool.inputSchema.required || []).filter((name) => name !== 'paneId');
  const inputSchema = { ...tool.inputSchema, properties };
  if (required.length) inputSchema.required = required;
  else delete inputSchema.required;
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema
  };
}

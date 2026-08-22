#!/usr/bin/env node

/**
 * Serveur MCP local pour exposer les outils Word à Claude Desktop
 * Utilise le SDK officiel MCP v1.x et uniquement les outils locaux PieceMaker.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fetch from 'node-fetch';

// Désactiver la vérification SSL pour localhost
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PIECEMAKER_SERVER_URL = (process.env.PIECEMAKER_SERVER_URL || 'https://localhost:43098').replace(/\/+$/, '');

// Chaque processus MCP correspond à une session Codex/Claude distincte. Le
// document choisi par open_doc reste donc local à cette session. Son paneId
// opaque accompagne ensuite chaque requête Word ; le chemin n'est plus utilisé
// pour choisir le volet.
let boundDocumentPath = null;
let boundPaneId = null;

function endpointUrl(pathname) {
  return `${PIECEMAKER_SERVER_URL}${pathname}`;
}

function documentRoutingHeaders() {
  if (!boundDocumentPath || !boundPaneId) return {};
  return {
    // encodeURIComponent garde l'en-tête ASCII, y compris pour les chemins
    // contenant des accents. Le serveur accepte aussi une URL file:// envoyée
    // directement par le volet Word.
    'X-PieceMaker-Document': encodeURIComponent(boundDocumentPath),
    // Identifiant local opaque : il ne passe jamais dans la réponse MCP et ne
    // consomme donc aucun token du modèle.
    'X-PieceMaker-Pane': boundPaneId,
  };
}

const REVISION_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    authors: { type: 'array', items: { type: 'string' } },
    types: { type: 'array', items: { type: 'string' } }
  }
};

const READ_REVISIONS_SCHEMA = {
  type: 'object',
  description: 'List/filter revisions; use the returned snapshot before show/accept/reject.',
  properties: {
    indexes: { type: 'array', items: { type: 'number', minimum: 1 } },
    authors: { type: 'array', items: { type: 'string' } },
    types: { type: 'array', items: { type: 'string' } },
    from_revision: { type: 'number', minimum: 1 },
    from_offset: { type: 'number', minimum: 0 }
  }
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['show', 'display', 'accept', 'reject', 'accept_all', 'reject_all'] },
    snapshot: { type: 'string', description: 'Required for every action except display.' },
    index: { type: 'number', minimum: 1, description: 'Revision to show.' },
    indexes: { type: 'array', items: { type: 'number', minimum: 1 }, description: 'Exact revisions to accept/reject.' },
    filter: { ...REVISION_FILTER_SCHEMA, description: 'Author/type selection; requires confirm=true.' },
    confirm: { type: 'boolean', description: 'Required for filtered and global accept/reject.' },
    markup: { type: 'string', enum: ['none', 'simple', 'all'] },
    view: { type: 'string', enum: ['original', 'final'] },
    reviewers: { type: 'string', enum: ['all', 'none'] }
  },
  required: ['action']
};

// Outils proxy Word disponibles
const LOCAL_TOOLS = [
        {
        name: 'open_doc',
        description: 'Open a .docx in Word with the PieceMaker pane, then make it active for read_doc/edit_doc.',
            inputSchema: {
            type: 'object',
            properties: {
                path: {
                type: 'string',
                description: 'Absolute .docx path'
                },
                timeoutMs: {
                type: 'number',
                description: 'Optional pane timeout in ms'
                }
            },
            required: ['path']
            }
        },
        {
        name: 'read_doc',
        description: 'Read indexed Markdown or tracked revisions. Use revision_view for current/original text; revisions returns a separate snapshot for review actions. Footnote definitions follow their paragraph.',
            inputSchema: {
            type: 'object',
            properties: {
                list_headings: {
                type: 'boolean',
                description: 'Only heading indexes'
                },
                heading: {
                type: 'string',
                description: 'Heading title or index'
                },
                indexes: {
                oneOf: [
                    { type: 'array', items: { type: 'number' } },
                    { type: 'string', pattern: '^\\d+(?:-\\d+)?$' }
                ],
                description: 'Indexes, or range such as "5-20"'
                },
                revision_view: { type: 'string', enum: ['current', 'original'], description: 'Current/final or original text.' },
                revisions: READ_REVISIONS_SCHEMA,
                from_index: {
                type: 'number',
                minimum: 0,
                description: 'Resume at this paragraph index'
                },
                from_offset: {
                type: 'number',
                minimum: 0,
                description: 'Resume inside from_index (paragraphs without footnotes only)'
                },
                max_chars: {
                type: 'number',
                minimum: 500,
                maximum: 100000,
                description: 'Response cap; default/max 100000 chars (~25000 tokens)'
                }
            }
            }
        },
        {
        name: 'edit_doc',
        description: 'Edit indexed paragraphs or review tracked changes. Text uses CommonMark footnotes: [^id] plus a separate [^id]: definition. track_changes defaults to true and Word\'s prior mode is restored. Review actions use the read_doc revision snapshot.',
            inputSchema: {
            type: 'object',
            properties: {
                operation: {
                type: 'string',
                enum: ['insert_before', 'insert_after', 'delete']
                },
                target_index: {
                type: 'number',
                minimum: 0
                },
                text: {
                type: 'string'
                },
                indexes_to_delete: {
                type: 'array',
                items: { type: 'number' }
                },
                track_changes: { type: 'boolean', description: 'Default true; false writes without tracked changes.' },
                review: REVIEW_SCHEMA,
                edits: {
                type: 'array',
                minItems: 1,
                maxItems: 50,
                description: 'Batch using indexes from the same read_doc result',
                items: {
                    type: 'object',
                    properties: {
                        operation: { type: 'string', enum: ['insert_before', 'insert_after', 'delete'] },
                        target_index: { type: 'number', minimum: 0 },
                        text: { type: 'string' },
                        indexes_to_delete: { type: 'array', items: { type: 'number' } }
                    },
                    required: ['operation']
                }
                }
            },
            anyOf: [{ required: ['operation'] }, { required: ['edits'] }, { required: ['review'] }]
            }
        },
        {
            name: 'read_case',
            description: `Recherche et gestion des pièces du dossier juridique.
            1. Listing available files : { show_structure: true }
            2. Querying by keywords : { query: "retard permis", search_mode: "OU" / "ET" / "EXACTE" }
            "EXACTE" enables you to query an exact quote.
            3 Querying by date { date_debut: "2023-01-01", date_fin: "2023-12-31" }
            4 Reading file content : { query: "0001", read_full: true }
            5 Reading MULTIPLE files at once : { query: "0001, 0002, 0003", read_full: true }
            6 Edit metadata & analysis : { edit: { id: "0001", date_document: "2025-03-12", analyse: "..." } }

            ⚠️ RULE : You are a Legal Counsel
            Automatically edit if a metadata is wrong,
            Automatically write a missing analysis (Short but exhaustive description from a legal point of view)
            Suggest edition if an analysis is incomplete.`,
            
            inputSchema: {
                type: 'object',
                properties: {
                query: {
                    type: 'string',
                    description: 'Keywords or file id'
                },
                show_structure: {
                    type: 'boolean',
                    description: 'If true, returns files list',
                    default: false
                },
                date_debut: {
                    type: 'string',
                    description: 'Date de début (format: YYYY-MM-DD, optionnel)'
                },
                date_fin: {
                    type: 'string',
                    description: 'Date de fin (format: YYYY-MM-DD, optionnel)'
                },
                search_mode: {
                    type: 'string',
                    enum: ['OU', 'ET', 'EXACTE'],
                    description: 'Search mode : OU, ET, EXACTE (expression exacte)',
                    default: 'OU'
                },
                read_full: {
                    type: 'boolean',
                    description: 'if true with query="id", returns file content',
                    default: false
                },
                edit: {
                    type: 'object',
                    description: 'Metadata edition : {id: "0001", date_document?: "...", type_document?: "...", analyse?: "..."}',
                    properties: {
                    id: {
                        type: 'string',
                        description: 'file id to edit'
                    },
                    date_document: {
                        type: 'string',
                        description: 'new date (YYYY-MM-DD, optional)'
                    },
                    type_document: {
                        type: 'string',
                        description: 'New title (ex: "Jugement", "Contrat", optionnel)'
                    },
                    analyse: {
                        type: 'string',
                        description: 'New analysis : résumé concis + points d\'attention)'
                    }
                    },
                    required: ['id']
                }
                }
            }
            },
{
    name: "get_resource",
    description: "Get guides, legal researches, writing examples",
    inputSchema: {
        type: "object",
        properties: {
            filename: {
                type: "string",
                description: "Name of the file"
            },
            action: {
                type: "string",
                enum: ["list", "read", "copy", "write", "rename", "delete"],
                description: "If no filename, 'list' will be automatically applied"
            },
            content: {
                type: "string",
                description: "Content to add"
            },
            new_filename: {
                type: "string",
                description: "New filename"
            }
        },
        required: []
    }
},
{
    name: "draft",
    description: `Tool for legal drafting.
1. { action: "check_template" } : check if a template has been injected in the docx.
   → If no template is injected, automatically returns the list of available templates from the resources folder
2. { action: "inject_template", template_name: "template_assignation.docx" }
   → If template_name is not provided, automatically returns the list of available templates
   ⚠️ USER AUTHORIZATION NECESSARY (doc will be emptied)
3. { action: "get_placeholder_instructions", placeholder: "{{FAITS}}" } (optional - provides formatting guidelines)
4. { action: "fill_placeholder", placeholder: "{{FAITS}}", content: "..." }
5. { action: "check_completion" } : Check for remaining placeholders.

Note: You can fill placeholders directly without calling get_placeholder_instructions first.
Note: You no longer need to call get_resource to list templates - check_template and inject_template do this automatically.`,

    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["check_template", "inject_template", "get_placeholder_instructions", "fill_placeholder", "check_completion"],
                description: "Action à effectuer dans le workflow"
            },
            template_name: {
                type: "string",
                description: "Nom EXACT du fichier template à injecter (ex: '01 - Modèle Assignation.docx', '02 - Conclusions_défense.docx'). Si non fourni avec action='inject_template', la liste des templates disponibles sera retournée automatiquement. (obligatoire pour action='inject_template')"
            },
            placeholder: {
                type: "string",
                description: "Nom du placeholder (ex: '{{FAITS}}') pour get_placeholder_instructions ou fill_placeholder"
            },
            content: {
                type: "string",
                description: "Contenu pour remplir un placeholder (obligatoire pour action='fill_placeholder')"
            }
        },
        required: ["action"]
    }
},
{
    name: "template_library",
    description: `Manage templates, placeholders, guidelines & validation rules.

TEMPLATE MANAGEMENT:
- create_template: Create a new template from the currently open Word document (convert first content to placeholders, generate guidelines, and then save as .docx + .json)
- copy_template: Copy an existing template (both .docx and .json files)
- delete_template: Delete a template and its associated JSON file
- list_templates: List all available templates in the resources folder

PLACEHOLDER MANAGEMENT (for the currently active template):
- list_all: List all placeholders with their steps
- search: Search placeholders by keyword
- get_guideline: Get guidelines for a specific placeholder
- create: Create a new placeholder with guidelines
- edit: Edit an existing placeholder's name, guidelines, step, or validation rules
- delete: Delete a placeholder`,

    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["create_template", "copy_template", "delete_template", "list_templates", "list_all", "search", "get_guideline", "create", "edit", "delete"],
                description: "Action to perform"
            },
            query: {
                type: "string",
                description: "Terme de recherche (obligatoire pour action='search'). Recherche insensible à la casse dans les noms de placeholders"
            },
            placeholder: {
                type: "string",
                description: "Nom du placeholder (ex: '{{FAITS}}' ou 'FAITS'). Obligatoire pour actions 'get_guideline', 'create', 'edit', 'delete'"
            },
            guideline: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Tableau de chaînes contenant les instructions (obligatoire pour action='create')"
            },
            new_placeholder: {
                type: "string",
                description: "New placeholder name (create or edit)"
            },
            new_guideline: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Nouvelle guideline (optionnel pour action='edit'). Tableau de chaînes pour remplacer la guideline existante"
            },
            validation: {
                type: "object",
                description: "Validation rules for this placeholder (for action='create'). Footnote example: { enabled: true, rules: [{ type: 'footnote', message: 'Error message' }] }"
            },
            new_validation: {
                type: "object",
                description: "New validation rules (for action='edit'). Footnote example: { enabled: true, rules: [{ type: 'footnote', message: 'Error message' }] }"
            },
            step: {
                type: "number",
                description: "Numéro d'ordre du placeholder (pour action='create' et 'edit'). Les placeholders sont triés par step croissant."
            },
            template_name: {
                type: "string",
                description: "Template filename (required for create_template, copy_template, delete_template). Ex: '03 - Nouveau Template.docx'"
            },
            source_template: {
                type: "string",
                description: "Source template filename (required for copy_template). Ex: '01 - Template Assignation.docx'"
            }
        },
        required: ["action"]
    }
},
{
    name: "Stamping",
    description: `Stamp files in the order indicated in the doc.
Give the list of IDs in their stamping order.
Exemple :
{ "pieces": ["0001", "0003", "0002"] }
→ Crée : "Pièce n°1" (ID 0001), "Pièce n°2" (ID 0003), "Pièce n°3" (ID 0002)
Les fichiers sont écrits dans le sous-dossier "Pièces" du dossier de travail (dossier du document Word).`,

    inputSchema: {
        type: "object",
        properties: {
            pieces: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Liste des IDs des pièces à Stamping, dans l'ordre souhaité"
            }
        },
        required: ["pieces"]
    }
},
{
    name: "Call_Ollama",
    description: `Triggers analysis of case files in background.
Use it if analysis is empty`,

    inputSchema: {
        type: "object",
        properties: {},
        required: []
    }
}
];

// Les autres outils restent implémentés et validés ci-dessous, mais ne sont
// plus annoncés ni exécutables par le modèle. Réactivation volontaire = ajouter
// leur nom ici, sans restaurer de code supprimé.
const ENABLED_TOOL_NAMES = new Set(['open_doc', 'read_doc', 'edit_doc']);
const ENABLED_TOOLS = LOCAL_TOOLS.filter((tool) => ENABLED_TOOL_NAMES.has(tool.name));

// Schémas Zod pour validation des arguments
const OpenDocSchema = z.object({
  path: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

const ReadDocSchema = z.object({
  list_headings: z.boolean().optional().default(false),
  heading: z.string().optional(),
  indexes: z.union([
    z.array(z.number().int().nonnegative()),
    z.string().regex(/^\d+(?:-\d+)?$/)
  ]).optional(),
  include_track_changes: z.boolean().optional().default(false),
  revision_view: z.enum(['current', 'original']).optional(),
  revisions: z.object({
    indexes: z.array(z.number().int().positive()).optional(),
    authors: z.array(z.string().min(1)).optional(),
    types: z.array(z.string().min(1)).optional(),
    from_revision: z.number().int().positive().optional(),
    from_offset: z.number().int().nonnegative().optional()
  }).optional(),
  from_index: z.number().int().nonnegative().optional(),
  from_offset: z.number().int().nonnegative().optional(),
  max_chars: z.number().int().min(500).max(100000).optional()
});

const InsertEditSchema = z.object({
  operation: z.enum(['insert_before', 'insert_after']),
  target_index: z.number().int().nonnegative(),
  text: z.string().min(1)
});

const DeleteEditSchema = z.object({
  operation: z.literal('delete'),
  indexes_to_delete: z.array(z.number().int().nonnegative()).min(1)
});

const SingleEditSchema = z.discriminatedUnion('operation', [
  InsertEditSchema,
  DeleteEditSchema
]);

const RevisionFilterInputSchema = z.object({
  authors: z.array(z.string().min(1)).optional(),
  types: z.array(z.string().min(1)).optional()
});

const ReviewInputSchema = z.object({
  action: z.enum(['show', 'display', 'accept', 'reject', 'accept_all', 'reject_all']),
  snapshot: z.string().min(1).optional(),
  index: z.number().int().positive().optional(),
  indexes: z.array(z.number().int().positive()).min(1).optional(),
  filter: RevisionFilterInputSchema.optional(),
  confirm: z.boolean().optional(),
  markup: z.enum(['none', 'simple', 'all']).optional(),
  view: z.enum(['original', 'final']).optional(),
  reviewers: z.enum(['all', 'none']).optional()
});

const EditDocSchema = z.union([
  InsertEditSchema.extend({ track_changes: z.boolean().optional().default(true) }),
  DeleteEditSchema.extend({ track_changes: z.boolean().optional().default(true) }),
  z.object({
    edits: z.array(SingleEditSchema).min(1).max(50),
    track_changes: z.boolean().optional().default(true)
  }),
  z.object({ review: ReviewInputSchema })
]);

const ReadCaseSchema = z.object({
  query: z.string().optional(),
  show_structure: z.boolean().optional().default(false),
  date_debut: z.string().optional(),
  date_fin: z.string().optional(),
  search_mode: z.enum(['OU', 'ET', 'EXACTE']).optional().default('OU'),
  read_full: z.boolean().optional().default(false),
  edit: z.object({
    id: z.string(),
    date_document: z.string().optional(),
    type_document: z.string().optional(),
    analyse: z.string().optional()
  }).optional()
});

const GetResourceSchema = z.object({
  filename: z.string().optional(),
  action: z.enum(['list', 'read', 'copy', 'write', 'rename', 'delete']).optional(),
  content: z.string().optional(),
  new_filename: z.string().optional()
});

const DraftSchema = z.object({
  action: z.enum(['check_template', 'inject_template', 'get_placeholder_instructions', 'fill_placeholder', 'check_completion']),
  template_name: z.string().optional(),
  placeholder: z.string().optional(),
  content: z.string().optional()
});

const TemplateLibrarySchema = z.object({
  action: z.enum(['create_template', 'copy_template', 'delete_template', 'list_templates', 'list_all', 'search', 'get_guideline', 'create', 'edit', 'delete']),
  query: z.string().optional(),
  placeholder: z.string().optional(),
  guideline: z.array(z.string()).optional(),
  new_placeholder: z.string().optional(),
  new_guideline: z.array(z.string()).optional(),
  validation: z.object({
    enabled: z.boolean(),
    rules: z.array(z.any())
  }).optional(),
  new_validation: z.object({
    enabled: z.boolean(),
    rules: z.array(z.any())
  }).optional(),
  step: z.number().optional(),
  template_name: z.string().optional(),
  source_template: z.string().optional()
});

const StampingSchema = z.object({
  pieces: z.array(z.string())
});

const CallOllamaSchema = z.object({});

// Mapper des schémas Zod par outil
const TOOL_SCHEMAS = {
  'open_doc': OpenDocSchema,
  'read_doc': ReadDocSchema,
  'edit_doc': EditDocSchema,
  'read_case': ReadCaseSchema,
  'get_resource': GetResourceSchema,
  'draft': DraftSchema,
  'template_library': TemplateLibrarySchema,
  'Stamping': StampingSchema,
  'Call_Ollama': CallOllamaSchema
};

// Fonction pour appeler un outil local Word
async function callLocalTool(toolName, toolArgs) {
  // Validation avec Zod
  const schema = TOOL_SCHEMAS[toolName];
  if (schema) {
    try {
      toolArgs = schema.parse(toolArgs);
    } catch (error) {
      throw new Error(`Arguments invalides: ${error.message}`);
    }
  }

  if (toolName !== 'open_doc' && (!boundDocumentPath || !boundPaneId)) {
    throw new Error('Aucun document lié à cette session. Appelez open_doc avant read_doc/edit_doc.');
  }

  let endpoint;
  switch (toolName) {
    case 'open_doc':
      endpoint = endpointUrl('/api/word/open-doc');
      break;
    case 'read_doc':
      endpoint = endpointUrl('/api/word/read-doc');
      break;
    case 'edit_doc':
      endpoint = endpointUrl('/api/word/edit-doc');
      break;
    case 'read_case':
      endpoint = endpointUrl('/api/word/search-case');
      break;
    case 'get_resource':
      endpoint = endpointUrl('/api/word/get-resource');
      break;
    case 'draft':
      endpoint = endpointUrl('/api/word/draft-conclusions');
      break;
    case 'template_library':
      endpoint = endpointUrl('/api/word/template-library');
      break;
    case 'Stamping':
      endpoint = endpointUrl('/api/word/Stamping');
      break;
    case 'Call_Ollama':
      endpoint = endpointUrl('/api/word/call-ollama');
      break;
    default:
      throw new Error(`Outil inconnu: ${toolName}`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...documentRoutingHeaders(),
    },
    body: JSON.stringify(toolArgs)
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage = data.error || 'Erreur inconnue';

    // Si l'erreur contient déjà "<error>" (erreur de validation métier),
    // ne pas ajouter les instructions serveur
    if (errorMessage.includes('<error>')) {
      throw new Error(errorMessage);
    }

    // Sinon, c'est probablement un problème de connexion/serveur
    throw new Error(`${errorMessage}\n\nAssurez-vous que:\n1. Le serveur est démarré (node server.js)\n2. Le complément Word est ouvert\n3. Le complément est bien connecté au serveur`);
  }

  if (typeof data === 'string') return data;

  if (toolName === 'open_doc') {
    if (data.ok === true && data.paneReady === true
        && typeof data.path === 'string' && typeof data.paneId === 'string') {
      boundDocumentPath = data.path;
      boundPaneId = data.paneId;
    }
    return JSON.stringify({
      ok: data.ok === true,
      paneReady: data.paneReady === true,
      path: data.path,
      message: data.message
    });
  }

  return JSON.stringify(data);
}

// Système anti-doublons pour les éditions exposées
// Pour éviter les insertions en double dues aux retries réseau
const editRequestCache = new Map();
const EDIT_CACHE_TTL = 5000; // 5 secondes

// Nettoyage périodique du cache
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of editRequestCache.entries()) {
    if (now - timestamp > EDIT_CACHE_TTL) {
      editRequestCache.delete(key);
    }
  }
}, 10000); // Nettoyer toutes les 10 secondes

// Initialiser le serveur MCP avec le SDK officiel
const server = new Server(
  {
    name: 'PieceMaker Word Add-in',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handler pour tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: ENABLED_TOOLS
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};

  console.error(`[MCP] 📥 Requête reçue - Tool: ${toolName}`);

  if (!ENABLED_TOOL_NAMES.has(toolName)) {
    return {
      content: [{ type: 'text', text: `❌ Outil désactivé : ${toolName}` }],
      isError: true
    };
  }

  // Anti-doublons pour les écritures exposées (éviter les insertions en double)
  if (toolName === 'edit_doc') {
    const requestString = `${toolName}-${JSON.stringify(toolArgs)}`;
    const requestKey = requestString.length; // Utiliser la longueur comme clé simple
    const now = Date.now();

    if (editRequestCache.has(requestKey)) {
      const timestamp = editRequestCache.get(requestKey);
      const ageMs = now - timestamp;

      if (ageMs < EDIT_CACHE_TTL) {
        console.error(`[MCP] ⚠️ Doublon ${toolName} détecté - Longueur: ${requestKey}, Âge: ${ageMs}ms - BLOQUÉ`);
        return {
          content: [{
            type: 'text',
            text: `⏳ Requête ${toolName} identique détectée il y a ${ageMs}ms. Pour éviter les insertions en double, cette requête est ignorée.`
          }]
        };
      }
    }

    // Marquer comme traité
    editRequestCache.set(requestKey, now);
  }

  const isLocalTool = ENABLED_TOOLS.some(t => t.name === toolName);
  if (!isLocalTool) {
    return {
      content: [{ type: 'text', text: `❌ Outil MCP local inconnu : ${toolName}` }],
      isError: true
    };
  }

  try {
    const result = await callLocalTool(toolName, toolArgs);
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ ${error.message}` }],
      isError: true
    };
  }
});

// Démarrer le serveur avec stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Local] Serveur MCP local démarré avec SDK officiel v2.0');
  console.error('[MCP Local] - Tools: Enabled');
}

main().catch((error) => {
  console.error('[MCP Local] Erreur fatale:', error);
  process.exit(1);
});

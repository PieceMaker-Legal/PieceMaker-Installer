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
import { EDIT_DOC_TOOL, READ_DOC_TOOL } from '../taskpane/modules/word-tool-schemas.js';
import { ensurePieceMakerServer } from './ensure-piecemaker-server.mjs';
import { fetchPieceMaker } from './piecemaker-fetch.mjs';

const PIECEMAKER_SERVER_URL = (process.env.PIECEMAKER_SERVER_URL || 'https://localhost:43098').replace(/\/+$/, '');

function endpointUrl(pathname) {
  return `${PIECEMAKER_SERVER_URL}${pathname}`;
}

function documentRoutingHeaders(paneId) {
  if (!paneId) return {};
  return {
    'X-PieceMaker-Pane': paneId,
  };
}

// Outils proxy Word disponibles
const LOCAL_TOOLS = [
        {
        name: 'open_doc',
        description: 'Ouvre un .docx dans Word avec son volet PieceMaker et renvoie le paneId à passer à read_doc/edit_doc.',
            inputSchema: {
            type: 'object',
            properties: {
                path: {
                type: 'string',
                minLength: 1,
                description: 'Chemin absolu du fichier .docx'
                },
                timeoutMs: {
                type: 'integer',
                minimum: 1,
                description: 'Délai facultatif d’attente du volet, en millisecondes'
                }
            },
            required: ['path']
            }
        },
        READ_DOC_TOOL,
        EDIT_DOC_TOOL,
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
}).strict();

const PaneIdSchema = z.string().regex(/^[0-9a-z]{4}$/i);

const ReadDocSchema = z.object({
  paneId: PaneIdSchema,
  list_headings: z.boolean().optional().default(false),
  heading: z.string().min(1).optional(),
  indexes: z.union([
    z.array(z.number().int().nonnegative()).min(1),
    z.string().regex(/^\d+(?:-\d+)?$/)
  ]).optional(),
  // Compatibilité avec les anciens clients. Ce paramètre n'est plus annoncé :
  // revision_view exprime sans ambiguïté la version de révision souhaitée.
  include_track_changes: z.boolean().optional().default(false),
  revision_view: z.enum(['current', 'original']).optional(),
  revisions: z.object({
    indexes: z.array(z.number().int().positive()).min(1).optional(),
    authors: z.array(z.string().min(1)).min(1).optional(),
    types: z.array(z.string().min(1)).min(1).optional(),
    from_revision: z.number().int().positive().optional(),
    from_offset: z.number().int().nonnegative().optional()
  }).strict().optional(),
  from_index: z.number().int().nonnegative().optional(),
  from_offset: z.number().int().nonnegative().optional(),
  max_chars: z.number().int().min(500).max(100000).optional()
}).strict().superRefine((value, ctx) => {
  const modes = [
    Boolean(value.revisions),
    value.list_headings === true,
    value.heading !== undefined,
    value.indexes !== undefined
  ];
  if (modes.filter(Boolean).length > 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Choisir un seul mode : revisions, list_headings, heading ou indexes.'
    });
  }
  if (value.revisions && (
    value.revision_view !== undefined
    || value.from_index !== undefined
    || value.from_offset !== undefined
  )) {
    ctx.addIssue({
      code: 'custom',
      message: 'Le mode revisions ne se combine pas avec revision_view, from_index ou from_offset.'
    });
  }
});

const InsertEditSchema = z.object({
  operation: z.enum(['insert_before', 'insert_after']),
  target_index: z.number().int().nonnegative(),
  text: z.string().min(1)
}).strict();

const DeleteEditSchema = z.object({
  operation: z.literal('delete'),
  indexes_to_delete: z.array(z.number().int().nonnegative()).min(1)
}).strict();

const SingleEditSchema = z.discriminatedUnion('operation', [
  InsertEditSchema,
  DeleteEditSchema
]);

const RevisionFilterInputSchema = z.object({
  authors: z.array(z.string().min(1)).min(1).optional(),
  types: z.array(z.string().min(1)).min(1).optional()
}).strict().refine(
  (value) => value.authors !== undefined || value.types !== undefined,
  { message: 'filter exige authors ou types.' }
);

const ReviewInputSchema = z.union([
  z.object({
    action: z.literal('show'),
    snapshot: z.string().min(1),
    index: z.number().int().positive()
  }).strict(),
  z.object({
    action: z.literal('display'),
    markup: z.enum(['none', 'simple', 'all']).optional(),
    view: z.enum(['original', 'final']).optional(),
    reviewers: z.enum(['all', 'none']).optional()
  }).strict().refine(
    (value) => value.markup !== undefined
      || value.view !== undefined
      || value.reviewers !== undefined,
    { message: 'display exige markup, view ou reviewers.' }
  ),
  z.object({
    action: z.enum(['accept', 'reject']),
    snapshot: z.string().min(1),
    indexes: z.array(z.number().int().positive()).min(1)
  }).strict(),
  z.object({
    action: z.enum(['accept', 'reject']),
    snapshot: z.string().min(1),
    filter: RevisionFilterInputSchema,
    confirm: z.literal(true)
  }).strict(),
  z.object({
    action: z.enum(['accept_all', 'reject_all']),
    snapshot: z.string().min(1),
    confirm: z.literal(true)
  }).strict()
]);

const EditDocSchema = z.union([
  z.object({
    paneId: PaneIdSchema,
    operation: z.enum(['insert_before', 'insert_after']),
    target_index: z.number().int().nonnegative(),
    text: z.string().min(1),
    track_changes: z.boolean().optional().default(true)
  }).strict(),
  z.object({
    paneId: PaneIdSchema,
    operation: z.literal('delete'),
    indexes_to_delete: z.array(z.number().int().nonnegative()).min(1),
    track_changes: z.boolean().optional().default(true)
  }).strict(),
  z.object({
    paneId: PaneIdSchema,
    edits: z.array(SingleEditSchema).min(1).max(50),
    track_changes: z.boolean().optional().default(true)
  }).strict(),
  z.object({ paneId: PaneIdSchema, review: ReviewInputSchema }).strict()
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

  if (toolName === 'open_doc') {
    const server = await ensurePieceMakerServer(PIECEMAKER_SERVER_URL);
    if (!server.ready) {
      throw new Error(`Serveur PieceMaker inaccessible à ${PIECEMAKER_SERVER_URL}. Démarrez le serveur configuré puis rappelez open_doc.`);
    }
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

  const paneId = toolName === 'read_doc' || toolName === 'edit_doc' ? toolArgs.paneId : null;
  const forwardedArgs = paneId ? { ...toolArgs } : toolArgs;
  if (paneId) delete forwardedArgs.paneId;

  const response = await fetchPieceMaker(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...documentRoutingHeaders(paneId),
    },
    body: JSON.stringify(forwardedArgs)
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage = data.error || 'Erreur inconnue';

    if (toolName === 'open_doc' && response.status === 504) {
      throw new Error(errorMessage);
    }

    // Si l'erreur contient déjà "<error>" (erreur de validation métier),
    // ne pas ajouter les instructions serveur
    if (errorMessage.includes('<error>')) {
      throw new Error(errorMessage);
    }

    // Sinon, c'est probablement un problème de connexion/serveur
    throw new Error(`${errorMessage}\n\nVérifiez que le complément Word est installé et que son volet peut se connecter au serveur local.`);
  }

  if (typeof data === 'string') return data;

  if (toolName === 'open_doc') {
    return JSON.stringify({ paneId: data.paneId });
  }

  return JSON.stringify(data);
}

function editDocSuccessPayload(result) {
  let parsed = result;
  if (typeof result === 'string') {
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = null;
    }
  }

  if (parsed?.error || parsed?.success === false) {
    throw new Error(parsed.error || 'Échec de la modification Word.');
  }

  return JSON.stringify({ success: true });
}

function editDocFailurePayload(message) {
  return JSON.stringify({
    success: false,
    message: String(message || 'Échec de la modification Word.')
  });
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
        const message = `Requête ${toolName} identique détectée il y a ${ageMs}ms. Pour éviter les insertions en double, cette requête est ignorée.`;
        return {
          content: [{ type: 'text', text: editDocFailurePayload(message) }],
          isError: true
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
    if (toolName === 'edit_doc') {
      return {
        content: [{ type: 'text', text: editDocSuccessPayload(result) }]
      };
    }
    return {
      content: [{ type: 'text', text: result }]
    };
  } catch (error) {
    if (toolName === 'edit_doc') {
      return {
        content: [{ type: 'text', text: editDocFailurePayload(error.message) }],
        isError: true
      };
    }
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

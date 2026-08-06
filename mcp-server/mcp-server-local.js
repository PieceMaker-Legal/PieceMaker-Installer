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
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chemin de sortie configuré (passé via variable d'environnement)
const OUTPUT_PATH = process.env.OUTPUT_PATH;
if (OUTPUT_PATH) {
  console.error('[MCP Local] Chemin de sortie configuré:', OUTPUT_PATH);
} else {
  console.error('[MCP Local] Utilisation du chemin de sortie par défaut (addon/output)');
}

// Désactiver la vérification SSL pour localhost
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Outils proxy Word disponibles
const LOCAL_TOOLS = [
        {
        name: 'read_doc',
        description: `Read Word document with Markdown formatting and index-based navigation.
Modes:
1. Full doc: {} - Returns all paragraphs with index numbers
2. Structure: { list_headings: true } - Returns heading hierarchy
3. Section: { heading: "#Title#" } - Returns heading + its content
4. Specific: { indexes: [5, 10, 15] } - Returns selected indexes only

Output format (NOT JSON):
INDEX -> [Markdown content]

Features:
- Headings: # Title, ## Heading1, ### Heading2, etc.
- Lists with indentation
- Bold, italic, underline
- Footnotes: [^footnote: text]
- Page breaks: [^page_break]
- Track changes: excluded by default (use include_track_changes: true)
- Word numbering automatically removed from headings

IMPORTANT: Always use this tool before edit_doc to verify current indexes.`,
            inputSchema: {
            type: 'object',
            properties: {
                list_headings: {
                type: 'boolean',
                description: 'Return only document structure (headings list with indexes)',
                default: false
                },
                heading: {
                type: 'string',
                description: 'Fetch specific heading and all its content. Format: "Heading 1: Title" or just index number'
                },
                indexes: {
                type: 'array',
                items: { type: 'number' },
                description: 'Fetch specific paragraph indexes only. Returns selected paragraphs with their content'
                },
                include_track_changes: {
                type: 'boolean',
                description: 'Include deleted track changes (default: false, deleted content is hidden)',
                default: false
                }
            }
            }
        },
        {
        name: 'edit_doc',
        description: `Edit Word document using index-based targeting. All edits applied with track changes.

Operations:
1. insert_before: { operation: "insert_before", target_index: 5, text: "## New heading\\nParagraph text" }
2. insert_after: { operation: "insert_after", target_index: 5, text: "Content here" }
3. delete: { operation: "delete", indexes_to_delete: [5, 7, 9] }

Text format:
- Use Markdown (## heading, **bold**, *italic*, <u>underline</u>, - lists)
- Markdown is CONVERTED to Word formatting (not displayed as-is)
- Multi-line: separate with \\n (each line = new paragraph)
- Placeholders: {{NAME}} can be used in any operation
- Comments: <!-- your comment --> - converted to Word comments (inserted at position)

Placeholder handling:
- CAN be used to replace/fill placeholders (alternative to draft tool's fill_placeholder)
- If a placeholder {{NAME}} is detected in the operation, tool automatically:
  * Marks the placeholder as filled
  * Returns next_placeholder and next_placeholder_guideline (like draft tool)
- Use this when you need more control than fill_placeholder (e.g., delete + insert, complex edits)

IMPORTANT:
- Must call read_doc first to verify indexes (enforced by tool)
- Only successful edits reset the read_doc requirement
- NO numbering for headings (automatically carried)
- Footnotes can be added using [^footnote: text] syntax for proper citations

Returns: success status + next_placeholder & next_placeholder_guideline if placeholder was used`,
            inputSchema: {
            type: 'object',
            properties: {
                operation: {
                type: 'string',
                enum: ['insert_before', 'insert_after', 'delete'],
                description: 'Edit operation type'
                },
                target_index: {
                type: 'number',
                description: 'Target paragraph index (required for insert_before/insert_after operations)'
                },
                text: {
                type: 'string',
                description: 'Content to insert (Markdown format). Use \\n for multi-line.'
                },
                indexes_to_delete: {
                type: 'array',
                items: { type: 'number' },
                description: 'Array of paragraph indexes to delete (required for delete operation)'
                }
            },
            required: ['operation']
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
                description: "Validation rules for this placeholder (for action='create'). Format: { enabled: true/false, rules: [{ type: 'contains', patterns: ['[^footnote:', '[^1'], operator: 'OR', message: 'Error message' }] }"
            },
            new_validation: {
                type: "object",
                description: "New validation rules (for action='edit'). Format: { enabled: true/false, rules: [{ type: 'contains', patterns: ['[^footnote:'], operator: 'OR'/'AND', message: 'Error message' }] }"
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

// ============================================================================
// PROMPTS MANAGEMENT
// ============================================================================

let promptsData = { prompts: [], metadata: {} };

/**
 * Load prompts from mcp-prompts.json
 */
function loadPrompts() {
  try {
    const promptsPath = path.join(__dirname, '..', 'mcp-prompts.json');
    const data = fs.readFileSync(promptsPath, 'utf-8');
    promptsData = JSON.parse(data);
    console.error(`[MCP Local] ${promptsData.prompts.length} prompts chargés depuis mcp-prompts.json`);
  } catch (error) {
    console.error('[MCP Local] Erreur chargement prompts:', error.message);
    promptsData = { prompts: [], metadata: {} };
  }
}

/**
 * List all available prompts
 */
function listPrompts() {
  return promptsData.prompts.map(prompt => ({
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments || []
  }));
}

/**
 * Get a specific prompt by name with argument interpolation
 */
function getPrompt(name, args = {}) {
  const prompt = promptsData.prompts.find(p => p.name === name);

  if (!prompt) {
    throw new Error(`Prompt '${name}' not found`);
  }

  let promptText = prompt.prompt;

  // Interpolate arguments
  for (const [key, value] of Object.entries(args)) {
    const placeholder = `{${key}}`;
    promptText = promptText.replace(new RegExp(placeholder, 'g'), value);
  }

  return {
    name: prompt.name,
    description: prompt.description,
    prompt: promptText,
    sequence: prompt.sequence || [],
    absolute_rules: prompt.absolute_rules || []
  };
}

// Schémas Zod pour validation des arguments
const ReadDocSchema = z.object({
  list_headings: z.boolean().optional().default(false),
  heading: z.string().optional(),
  indexes: z.array(z.number()).optional(),
  include_track_changes: z.boolean().optional().default(false)
});

const EditDocSchema = z.object({
  operation: z.enum(['insert_before', 'insert_after', 'replace', 'delete']),
  target_index: z.number().optional(),
  placeholder: z.string().optional(),
  text: z.string().optional(),
  indexes_to_delete: z.array(z.number()).optional()
});

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

  let endpoint;
  switch (toolName) {
    case 'read_doc':
      endpoint = 'https://localhost:43098/api/word/read-doc';
      break;
    case 'edit_doc':
      endpoint = 'https://localhost:43098/api/word/edit-doc';
      break;
    case 'read_case':
      endpoint = 'https://localhost:43098/api/word/search-case';
      break;
    case 'get_resource':
      endpoint = 'https://localhost:43098/api/word/get-resource';
      break;
    case 'draft':
      endpoint = 'https://localhost:43098/api/word/draft-conclusions';
      break;
    case 'template_library':
      endpoint = 'https://localhost:43098/api/word/template-library';
      break;
    case 'Stamping':
      endpoint = 'https://localhost:43098/api/word/Stamping';
      break;
    case 'Call_Ollama':
      endpoint = 'https://localhost:43098/api/word/call-ollama';
      break;
    default:
      throw new Error(`Outil inconnu: ${toolName}`);
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
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

  return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

// Système anti-doublons pour edit_doc et draft uniquement
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
      prompts: {},
    },
  }
);

// Handler pour tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: LOCAL_TOOLS
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};

  console.error(`[MCP] 📥 Requête reçue - Tool: ${toolName}`);

  // Anti-doublons UNIQUEMENT pour edit_doc et draft (éviter les insertions en double)
  if (toolName === 'edit_doc' || toolName === 'draft') {
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

  const isLocalTool = LOCAL_TOOLS.some(t => t.name === toolName);
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

// ============================================================================
// PROMPTS HANDLERS
// ============================================================================

// Handler pour prompts/list
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  const prompts = listPrompts();
  return {
    prompts: prompts
  };
});

// Handler pour prompts/get
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;
  const promptArgs = request.params.arguments || {};

  try {
    const promptData = getPrompt(promptName, promptArgs);

    // Format MCP response
    return {
      description: promptData.description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: promptData.prompt
          }
        }
      ]
    };
  } catch (error) {
    throw new Error(`Prompt error: ${error.message}`);
  }
});

// Démarrer le serveur avec stdio transport
async function main() {
  await loadMcpConfig();
  loadPrompts(); // Charger les prompts au démarrage

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MCP Local] Serveur MCP local démarré avec SDK officiel v2.0');
  console.error('[MCP Local] - Tools: Enabled');
  console.error('[MCP Local] - Prompts: Enabled');
}

main().catch((error) => {
  console.error('[MCP Local] Erreur fatale:', error);
  process.exit(1);
});

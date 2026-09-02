/**
 * Surface des commandes du binaire `piecemaker`.
 *
 * Isolée dans son propre module parce que `installer/bin/piecemaker.mjs`
 * lance `main()` dès son import : rien ne peut l'importer sans ouvrir le menu
 * interactif et donc toucher aux services réels de la machine. Ce module-ci
 * est importable sans effet de bord, ce qui permet au test anti-dérive
 * (`test/commandes-templates.test.mjs`) de confronter cette surface aux
 * outils MCP et aux commandes citées dans les templates.
 */

export const COMMANDS = new Set(['open', 'start', 'stop', 'restart', 'status', 'logs', 'chronology', 'conversion', 'graph', 'proxy', 'install', 'doctor', 'check', 'update']);
export const GRAPH_ACTIONS = new Set(['build', 'query', 'status']);
export const PROXY_ACTIONS = new Set(['bypass']);

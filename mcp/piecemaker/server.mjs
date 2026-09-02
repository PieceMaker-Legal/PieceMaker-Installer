#!/usr/bin/env node
/**
 * Serveur MCP « piecemaker » — outils de graphe juridique, de conversion et
 * de chronologie exposés à Claude Code (et à tout client MCP) sans passer
 * par du texte injecté dans un CLAUDE.md.
 *
 * Chaque outil lance le binaire `piecemaker` en sous-processus plutôt que
 * d'importer les modules internes : c'est ce qui garantit l'absence de
 * dérive entre la commande shell documentée et l'outil MCP — même analyse
 * d'arguments, même localisation de dossier, une seule implémentation
 * (voir `installer/bin/piecemaker.mjs`).
 *
 * Les commandes lancées ici (`graph query`, `graph … --json`,
 * `conversion --json`, `chronology --json`) court-circuitent toutes le
 * bandeau, la vérification de mise à jour et le menu interactif
 * (`installer/bin/piecemaker.mjs:1006-1009`) : aucun service PieceMaker
 * n'est démarré, arrêté ni redémarré par ce serveur.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** Racine du dépôt, déduite de l'emplacement de ce fichier (mcp/piecemaker/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_PATH = path.join(REPO_ROOT, 'installer', 'bin', 'piecemaker.mjs');

/**
 * Lance réellement le binaire `piecemaker` et capture sa sortie. Isolé dans
 * sa propre fonction pour rester injectable dans les tests — aucun test ne
 * doit dépendre de ce chemin d'exécution réel pour ses assertions.
 */
function spawnPiecemaker(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Exécute une commande `piecemaker <args>` et rend `{ code, stdout, stderr }`.
 * `execFn` est injectable par les tests, pour ne jamais avoir à lancer un
 * vrai sous-processus.
 */
export function runPiecemakerCommand(args, { cwd = process.cwd(), execFn = spawnPiecemaker } = {}) {
  return execFn(args, cwd);
}

/**
 * Transforme le résultat du sous-processus en réponse d'outil MCP.
 *
 * Le CLI n'écrit pas toujours ses erreurs sur stderr (`log.error` écrit sur
 * stdout, voir `installer/lib/ui.mjs`) : on retient stderr s'il dit quelque
 * chose, sinon on retombe sur stdout, jamais sur un message vide. Sur succès,
 * stdout est renvoyé tel quel — `graph query` sort du texte, pas du JSON, et
 * les autres outils sortent déjà du JSON mis en forme par le CLI (`--json`).
 */
export function toToolResult(result) {
  if (result.code !== 0) {
    const message = (result.stderr && result.stderr.trim())
      || (result.stdout && result.stdout.trim())
      || `Échec de la commande piecemaker (code de sortie ${result.code}).`;
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
  return { content: [{ type: 'text', text: result.stdout }] };
}

// --- Construction des arguments, un constructeur pur par outil -----------
//
// Chaque fonction reproduit exactement une ligne du tableau du plan : même
// commande, mêmes options, dans le même ordre. `dossier` doit déjà être
// résolu (jamais undefined) par l'appelant — voir `resolveDossier` ci-dessous.

export function graphQuestionArgs({ question, dossier, budget }) {
  const args = ['graph', 'query', question, '--case', dossier];
  if (budget !== undefined && budget !== null) args.push('--budget', String(budget));
  return args;
}

export function graphBuildArgs({ dossier, force }) {
  const args = ['graph', 'build', '--json', '--case', dossier];
  if (force) args.push('--force');
  return args;
}

export function graphStatusArgs({ dossier }) {
  return ['graph', 'status', '--json', '--case', dossier];
}

export function conversionArgs({ dossier, pieces, force }) {
  const args = ['conversion', '--json', '--case', dossier];
  for (const piece of pieces || []) args.push(piece);
  if (force) args.push('--force');
  return args;
}

export function chronologyArgs({ dossier }) {
  return ['chronology', '--json', '--case', dossier];
}

/** Dossier ciblé par un appel d'outil : celui demandé, sinon la session en cours. */
export function resolveDossier(dossier) {
  return dossier && String(dossier).trim() ? dossier : process.cwd();
}

const DOSSIER_SCHEMA = z.string()
  .optional()
  .describe('Chemin absolu du dossier juridique ciblé. Par défaut, le répertoire de la session Claude Code en cours.');

/**
 * Construit le serveur MCP et y enregistre les cinq outils. Séparé de
 * `main()` pour rester testable sans jamais brancher de transport stdio.
 */
export function createServer({ execFn } = {}) {
  const server = new McpServer({ name: 'piecemaker', version: '1.0.0' });
  const run = (args, dossier) => runPiecemakerCommand(args, { cwd: dossier, execFn });

  server.registerTool('graphe_question', {
    description: 'Interroge le graphe sémantique juridique du dossier (liens de droit entre les pièces) '
      + 'et renvoie du texte, pas du JSON. Si le graphe est absent, il est construit automatiquement à la '
      + 'première question. S\'il existe mais est périmé, l\'outil renvoie une erreur qui le dit explicitement '
      + '— il ne le reconstruit pas lui-même : relancez alors l\'outil « graphe_construire ».',
    inputSchema: {
      question: z.string().min(1).describe('Question posée en langage naturel au graphe juridique du dossier.'),
      dossier: DOSSIER_SCHEMA,
      budget: z.number().int().positive().optional()
        .describe('Budget de tokens du contexte renvoyé (défaut côté CLI : 4000).'),
    },
  }, async ({ question, dossier, budget }) => {
    const resolved = resolveDossier(dossier);
    const result = await run(graphQuestionArgs({ question, dossier: resolved, budget }), resolved);
    return toToolResult(result);
  });

  server.registerTool('graphe_construire', {
    description: 'Construit ou actualise le graphe sémantique juridique du dossier. N\'a rien à faire si le '
      + 'graphe est déjà à jour, sauf avec force=true qui force une reconstruction complète.',
    inputSchema: {
      dossier: DOSSIER_SCHEMA,
      force: z.boolean().optional().describe('Reconstruit le graphe même s\'il est déjà à jour.'),
    },
  }, async ({ dossier, force }) => {
    const resolved = resolveDossier(dossier);
    const result = await run(graphBuildArgs({ dossier: resolved, force }), resolved);
    return toToolResult(result);
  });

  server.registerTool('graphe_etat', {
    description: 'Indique si le graphe sémantique juridique du dossier existe et s\'il est à jour, sans le '
      + 'construire ni le modifier.',
    inputSchema: {
      dossier: DOSSIER_SCHEMA,
    },
  }, async ({ dossier }) => {
    const resolved = resolveDossier(dossier);
    const result = await run(graphStatusArgs({ dossier: resolved }), resolved);
    return toToolResult(result);
  });

  server.registerTool('conversion', {
    description: 'Convertit les pièces du dossier en Markdown ET les scanne pour détecter les données '
      + 'personnelles (GLiNER), en une seule passe — les deux ne sont pas séparables. Opération longue : '
      + 'plusieurs minutes selon le nombre et la taille des pièces. Un seul scan PieceMaker tourne à la fois, '
      + 'tous dossiers confondus ; si un autre est déjà en cours, cet outil échoue au lieu d\'attendre.',
    inputSchema: {
      dossier: DOSSIER_SCHEMA,
      pieces: z.array(z.string()).optional()
        .describe('Noms ou chemins relatifs des pièces à convertir. Par défaut, toutes les pièces pas encore prêtes.'),
      force: z.boolean().optional().describe('Reconvertit et rescanne même les pièces déjà prêtes.'),
    },
  }, async ({ dossier, pieces, force }) => {
    const resolved = resolveDossier(dossier);
    const result = await run(conversionArgs({ dossier: resolved, pieces, force }), resolved);
    return toToolResult(result);
  });

  server.registerTool('chronologie', {
    description: 'Affiche la chronologie pseudonymisée du dossier juridique (dates, pièces, événements), en JSON.',
    inputSchema: {
      dossier: DOSSIER_SCHEMA,
    },
  }, async ({ dossier }) => {
    const resolved = resolveDossier(dossier);
    const result = await run(chronologyArgs({ dossier: resolved }), resolved);
    return toToolResult(result);
  });

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

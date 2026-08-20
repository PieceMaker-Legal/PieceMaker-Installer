#!/usr/bin/env node
/**
 * PreToolUse hook — rétablit les vrais noms sur tout ce que l'IA produit
 * **et** sur les chemins qu'elle passe en entrée d'une lecture.
 *
 * Symétrique d'`anonymize-read.mjs` : le modèle ne voit et ne manipule que des
 * codes, mais ce qui atterrit chez un humain doit être lisible. La réécriture
 * se fait sur `updatedInput`, donc avant que l'outil s'exécute — le fichier
 * écrit, le message Telegram envoyé portent le nom réel, sans qu'il soit jamais
 * repassé par l'API.
 *
 * `Edit` réécrit **les deux** chaînes. C'est structurel : le modèle a lu le
 * fichier à travers le mapping, son `old_string` porte donc des codes, alors
 * que le disque porte les noms réels. Ne reverter que `new_string` ferait
 * échouer chaque édition sur « chaîne introuvable ».
 *
 * Telegram passe par l'outil MCP `reply` du plugin officiel
 * (`telegram/server.ts`), pas par le canal du harnais : `updatedInput` suffit
 * donc, sans rien savoir des internes du plugin.
 *
 * **Chemins en entrée d'une lecture.** `anonymize-read.mjs` code aussi les NOMS
 * DE FICHIERS listés dans un résultat : le modèle voit donc un chemin codé
 * (« 06_..._SOCIETE_SA_02_SA.md ») alors que le disque porte le vrai nom. Sans
 * symétrie, le `Read`/`Grep`/`Glob`/`Bash` qui suit vise un chemin codé
 * introuvable (« file does not exist »). Ce hook rétablit donc aussi le vrai
 * chemin en entrée : `file_path`/`path` pour Read/Grep/Glob, et la `command`
 * entière pour Bash (un code est un identifiant unique, le reverter au complet
 * est sûr et symétrique du codage de la sortie Bash par anonymize-read).
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPieceMakerConfig, readHookPayload, runHook, noop } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { resolveConfiguredCaseMapping, revertMapping } = require('./lib/mapping.cjs');

/**
 * Champs textuels à rétablir, par outil. Deux familles, même traitement (un
 * `revertMapping` code → entité) :
 *  - production (Write/Edit/Telegram) : le contenu qui atterrit chez un humain ;
 *  - lecture (Read/Grep/Glob/Bash) : le chemin ou la commande en entrée, pour
 *    qu'un chemin codé vu par le modèle résolve vers le vrai fichier sur disque.
 */
const FIELDS_BY_TOOL = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  Read: ['file_path'],
  Grep: ['path'],
  Glob: ['path'],
  Bash: ['command'],
};

/** Outils MCP Telegram porteurs d'un message sortant. */
const TELEGRAM_TOOLS = /^mcp__[^_]*telegram[^_]*__(reply|edit_message)$/;

function absolutePath(value, cwd) {
  if (!value) return null;
  const raw = String(value);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

function fieldsFor(toolName) {
  if (FIELDS_BY_TOOL[toolName]) return FIELDS_BY_TOOL[toolName];
  if (TELEGRAM_TOOLS.test(toolName)) return ['text'];
  return null;
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;

  const toolName = String(payload.tool_name || '');
  const fields = fieldsFor(toolName);
  if (!fields) return null;

  const config = loadPieceMakerConfig();
  if (config.anonymization?.enabled === false) return null;
  const cwd = payload.cwd || process.cwd();
  // Le dossier vient du chemin visé quand l'outil en porte un (`file_path` pour
  // Read/Write/Edit, `path` pour Grep/Glob) — le chemin codé suffit à localiser
  // le dossier, seul son préfixe de répertoire compte. À défaut (Bash, Telegram),
  // le répertoire de travail, qui est celui de l'assistant du dossier.
  const hint = absolutePath(payload.tool_input?.file_path || payload.tool_input?.path, cwd) || cwd;
  const legalCase = resolveConfiguredCaseMapping(config, hint);
  if (!legalCase) return null;

  const updatedInput = {};
  for (const field of fields) {
    const value = payload.tool_input?.[field];
    if (typeof value !== 'string' || !value) continue;
    const reverted = revertMapping(value, legalCase.reverse_mapping);
    if (reverted !== value) updatedInput[field] = reverted;
  }
  if (!Object.keys(updatedInput).length) return null;

  // Réserve d'affichage (Défaut B). `updatedInput` porte forcément les vrais
  // noms : c'est ce que l'outil exécute (le fichier écrit doit être lisible par
  // le cabinet, « le cabinet ne voit que des noms »). Or le harnais Claude Code
  // construit son aperçu local (« Wrote N lines ») À PARTIR de ce même
  // `updatedInput` : l'écran et le journal de session affichent donc les vrais
  // noms, alors que le modèle, lui, n'a reçu que « File created successfully… »
  // — AUCUNE fuite API ni de contexte modèle, seulement une exposition à
  // l'affichage local. Le contrat PreToolUse n'a qu'un seul canal (`updatedInput`
  // est à la fois exécuté ET affiché) : il n'existe pas de « exécuter X, afficher
  // Y ». Coder l'aperçu tout en écrivant les vrais noms suppose un correctif
  // CÔTÉ CLIENT (masquer/coder l'aperçu de contenu Write/Edit dans un dossier
  // PieceMaker) ; aucun hook ne peut l'obtenir sans casser soit `Edit` (dont
  // l'`old_string` codé doit être rétabli pour matcher le disque en clair), soit
  // l'invariant « le disque porte les vrais noms ».
  //
  // Pas de `permissionDecision` : ce hook réécrit, il n'autorise pas. Émettre
  // `allow` ici approuverait en silence toutes les écritures du dossier.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...payload.tool_input, ...updatedInput },
    },
  };
}

runHook(main, { timeoutMs: 5000 }).catch(() => noop());

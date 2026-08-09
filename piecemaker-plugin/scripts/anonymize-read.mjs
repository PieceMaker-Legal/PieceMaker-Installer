#!/usr/bin/env node
/**
 * PostToolUse hook — applique le mapping du dossier à tout ce que l'IA lit.
 *
 * C'est le point unique où l'anonymisation a lieu. Le Markdown reste en clair
 * sur le disque, pour le cabinet ; seul le résultat d'outil transmis au modèle
 * est codé, via `updatedToolOutput`. Aucun nom réel ne part donc vers l'API,
 * sans qu'aucun fichier ne soit réécrit.
 *
 * Ce hook ne scanne rien : il n'appelle ni GLiNER ni Presidio. Le mapping est
 * produit par le pipeline de l'administration
 * (`POST /api/admin/originals/pipeline`), qui est le seul endroit où les
 * modèles NER sont chargés. Un hook qui les chargerait à chaque lecture rendrait
 * la session inutilisable.
 *
 * Sans mapping pour le dossier, ou si la substitution ne change rien, le hook
 * ne renvoie rien : le résultat d'outil garde alors son format natif
 * (numérotation des lignes de Read, structure des résultats de Grep).
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { loadPieceMakerConfig, readHookPayload, runHook, noop } from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { applyMapping, resolveConfiguredCaseMapping } = require('./lib/mapping.cjs');

const HANDLED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);

function absolutePath(value, cwd) {
  if (!value) return null;
  const raw = String(value);
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
}

/**
 * Texte d'un résultat d'outil. La forme varie selon l'outil et les versions du
 * harnais ; on prend le premier champ porteur de texte et, à défaut, la
 * sérialisation complète — mieux vaut coder un JSON verbeux que laisser passer
 * un nom en clair.
 */
function resultText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return null;

  const direct = toolResponse.file?.content
    ?? toolResponse.content
    ?? toolResponse.output
    ?? toolResponse.text;
  if (typeof direct === 'string') return direct;

  // Bash : stdout et stderr portent tous deux du contenu de pièce.
  if (typeof toolResponse.stdout === 'string' || typeof toolResponse.stderr === 'string') {
    return [toolResponse.stdout, toolResponse.stderr].filter(Boolean).join('\n');
  }

  try {
    return JSON.stringify(toolResponse, null, 2);
  } catch {
    return null;
  }
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload) return null;
  if (!HANDLED_TOOLS.has(payload.tool_name)) return null;

  const config = loadPieceMakerConfig();
  if (config.anonymization?.enabled === false) return null;
  const cwd = payload.cwd || process.cwd();
  // Le dossier vient du chemin visé quand l'outil en a un ; sinon du répertoire
  // de travail, qui est le dossier juridique lui-même pour les assistants par
  // dossier. Deux dossiers ont des compteurs de codes indépendants : mélanger
  // leurs mappings attribuerait un même code à deux personnes différentes.
  const hint = absolutePath(payload.tool_input?.file_path || payload.tool_input?.path, cwd) || cwd;
  const legalCase = resolveConfiguredCaseMapping(config, hint);
  if (!legalCase) return null;

  const text = resultText(payload.tool_response);
  if (!text) return null;

  const anonymized = applyMapping(text, legalCase.mapping);
  if (anonymized === text) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: anonymized,
    },
  };
}

runHook(main, { timeoutMs: 5000 }).catch(() => noop());

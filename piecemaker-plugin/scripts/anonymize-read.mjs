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

import fs from 'node:fs';
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

/** Au-delà, une commande ne cite pas un chemin : on ne la scanne pas. */
const MAX_COMMAND_LENGTH = 20_000;

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * Chemins existants cités par une commande shell — mêmes règles de découpage que
 * `protect-originals` : chaque mot (guillemets respectés) est un candidat. Sert à
 * retrouver le dossier juridique d'un `cat`/`grep` : sans lui, la sortie Bash
 * retombe sur `cwd` (le dossier de travail de la session, pas le dossier
 * juridique) et le nom réel passe en clair.
 */
function commandPaths(command, cwd) {
  const text = String(command || '');
  if (!text || text.length > MAX_COMMAND_LENGTH) return [];
  const candidates = new Set();
  const tokens = text.match(/"[^"]*"|'[^']*'|[^\s;|&<>()]+/g) || [];
  for (const token of tokens) {
    const bare = token.replace(/^["']|["']$/g, '');
    if (!bare || bare.startsWith('-')) continue;
    candidates.add(bare);
    const equals = bare.indexOf('=');
    if (equals > 0 && equals < bare.length - 1) candidates.add(bare.slice(equals + 1));
  }
  // Fichier OU dossier : un `cd "<dossier juridique>"` ne cite qu'un répertoire,
  // et il suffit à localiser le cas. On ne cherche pas à prouver une protection
  // ici (rôle de protect-originals) — seulement à quel dossier appartient la sortie.
  return [...candidates]
    .map((candidate) => absolutePath(candidate, cwd))
    .filter((candidate) => candidate && statSafe(candidate));
}

/**
 * Dossier juridique dont le mapping s'applique au résultat. Un `Read`/`Grep`/
 * `Glob` porte le chemin visé ; une commande `Bash` ne l'a pas (elle a
 * `command`), on la résout donc depuis les chemins qu'elle cite, avec repli sur
 * `cwd` (cas de l'assistant par dossier, où `cwd` est le dossier juridique).
 */
function resolveLegalCase(payload, config, cwd) {
  if (payload.tool_name === 'Bash') {
    for (const candidate of commandPaths(payload.tool_input?.command, cwd)) {
      const found = resolveConfiguredCaseMapping(config, candidate);
      if (found) return found;
    }
    return resolveConfiguredCaseMapping(config, cwd);
  }
  const hint = absolutePath(payload.tool_input?.file_path || payload.tool_input?.path, cwd) || cwd;
  return resolveConfiguredCaseMapping(config, hint);
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
  const legalCase = resolveLegalCase(payload, config, cwd);
  if (!legalCase) return null;

  const raw = payload.tool_response;
  const text = resultText(raw);
  if (!text) return null;

  const anonymized = applyMapping(text, legalCase.mapping);
  if (anonymized === text) return null;

  // `updatedToolOutput` est validé par le harnais contre le schéma de sortie de
  // l'outil : un Read produit un objet `{ type, file: { content, … } }`, pas une
  // chaîne. Renvoyer une chaîne brute est rejeté (« does not match ») et le nom
  // réel passe. On préserve donc la forme exacte du résultat et on ne code que
  // les chaînes à l'intérieur — l'objet reste un résultat d'outil valide.
  const updatedToolOutput = anonymizeShape(raw, legalCase.mapping);

  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput,
    },
  };
}

/** Applique le mapping à toutes les chaînes d'une valeur en préservant sa forme
 *  (objets, tableaux, nombres et booléens intacts), pour rester un résultat
 *  d'outil valide aux yeux du harnais. */
function anonymizeShape(value, mapping) {
  if (typeof value === 'string') return applyMapping(value, mapping);
  if (Array.isArray(value)) return value.map((item) => anonymizeShape(item, mapping));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = anonymizeShape(val, mapping);
    return out;
  }
  return value;
}

runHook(main, { timeoutMs: 5000 }).catch(() => noop());

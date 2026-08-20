#!/usr/bin/env node
/**
 * Hook central global d'anonymisation — indépendant des autres hooks PieceMaker.
 *
 * Installé de façon autonome dans `~/.claude/hooks/` et câblé directement dans
 * `~/.claude/settings.json`. Contrairement aux hooks du plugin (scopés à un
 * dossier de cas enregistré), celui-ci s'applique à *tout* fichier lu ou écrit,
 * dans n'importe quelle session Claude, où qu'elle tourne — c'est le « hook
 * central qui fonctionne toujours ».
 *
 * Il applique le mapping central `~/.piecemaker/central-mapping.json`, produit et
 * dé-conflicté par `central-mapping.cjs` (fusion de tous les mappings de dossiers,
 * codes renumérotés pour qu'un même code ne désigne jamais deux personnes) :
 *   - PostToolUse (Read|Grep|Glob|Bash)  → anonymise le résultat (entité → code) ;
 *   - PreToolUse  (Write|Edit|telegram)  → dé-anonymise l'entrée (code → entité).
 *
 * Le disque n'est jamais réécrit : seul le résultat d'outil remis au modèle est
 * codé, et seule l'entrée d'outil sur le point de s'exécuter est restituée.
 *
 * Autonomie : il ne require que `~/.piecemaker/lib/substitution.cjs`, copie
 * stable du moteur du plugin (le chemin du plugin marketplace est mouvant). Il
 * échoue toujours ouvert — pas de moteur, pas de mapping, une erreur interne,
 * un délai dépassé : sortie 0, stdout vide, la session n'est pas affectée.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HOME_DIR = process.env.PIECEMAKER_HOME
  ? path.resolve(process.env.PIECEMAKER_HOME)
  : path.join(os.homedir(), '.piecemaker');
const CENTRAL_FILE = path.join(HOME_DIR, 'central-mapping.json');
const SUBSTITUTION_LIB = path.join(HOME_DIR, 'lib', 'substitution.cjs');
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash']);
const WRITE_FIELDS = { Write: ['content'], Edit: ['old_string', 'new_string'] };
const TELEGRAM_TOOLS = /^mcp__[^_]*telegram[^_]*__(reply|edit_message)$/;
/** Un mapping/scan ne doit jamais être « anonymisé » puis relu : on n'y touche pas. */
const MAPPING_FILE_PATTERNS = [/^mapping.*\.json$/i, /_sensitive_map\.json$/i, /^central-mapping\.json$/i];
const FLUSH_TIMEOUT_MS = 2000;
const MAX_COMMAND_LENGTH = 20_000;

function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { clearTimeout(timer); finish(); });
      process.stdin.on('error', () => { clearTimeout(timer); finish(); });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function anonymizationEnabled() {
  const config = readJson(CONFIG_FILE);
  return !(config && config.anonymization && config.anonymization.enabled === false);
}

/** Sortie 0 + JSON, avec garde-fou de drain (voir hook-io.mjs du plugin). */
function emit(output) {
  let payload;
  try {
    if (!output || typeof output !== 'object') { process.exit(0); }
    payload = JSON.stringify(output);
  } catch {
    process.exit(0);
    return;
  }
  const guard = setTimeout(() => process.exit(0), FLUSH_TIMEOUT_MS);
  guard.unref?.();
  process.stdout.write(payload, () => { clearTimeout(guard); process.exit(0); });
}

function isMappingBasename(filePath) {
  const base = path.basename(String(filePath || ''));
  return MAPPING_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/** Applique une fonction de substitution à toutes les chaînes d'une valeur, en
 *  préservant sa forme (le harnais valide `updatedToolOutput`/`updatedInput`
 *  contre le schéma de l'outil : renvoyer une chaîne à la place d'un objet est
 *  rejeté et le nom réel passerait en clair). */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = mapStrings(val, fn);
    return out;
  }
  return value;
}

function resultText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return null;
  const direct = toolResponse.file?.content ?? toolResponse.content ?? toolResponse.output ?? toolResponse.text;
  if (typeof direct === 'string') return direct;
  if (typeof toolResponse.stdout === 'string' || typeof toolResponse.stderr === 'string') {
    return [toolResponse.stdout, toolResponse.stderr].filter(Boolean).join('\n');
  }
  return null;
}

function fieldsFor(toolName) {
  if (WRITE_FIELDS[toolName]) return WRITE_FIELDS[toolName];
  if (TELEGRAM_TOOLS.test(toolName)) return ['text'];
  return null;
}

async function main() {
  if (!anonymizationEnabled()) return;

  const raw = await readStdin(2000);
  if (!raw || !raw.trim()) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const central = readJson(CENTRAL_FILE);
  const mapping = central && central.mapping && typeof central.mapping === 'object' ? central.mapping : null;
  const reverse = central && central.reverse_mapping && typeof central.reverse_mapping === 'object'
    ? central.reverse_mapping : null;
  if (!mapping && !reverse) return;

  let substitution;
  try {
    substitution = require(SUBSTITUTION_LIB);
  } catch {
    return; // moteur absent → échec ouvert
  }
  const { applyMapping, revertMapping } = substitution;

  const toolName = String(payload.tool_name || '');
  const event = String(payload.hook_event_name || '');

  // ── Lecture : anonymise le résultat d'outil (entité → code) ────────────────
  if (event === 'PostToolUse' && READ_TOOLS.has(toolName) && mapping && Object.keys(mapping).length) {
    // On ne code pas le contenu d'un fichier de mapping/scan (il est de toute
    // façon refusé en amont) : l'y appliquer produirait un charabia trompeur.
    const targetPath = payload.tool_input?.file_path || payload.tool_input?.path;
    if (targetPath && isMappingBasename(targetPath)) return;

    const responseText = resultText(payload.tool_response);
    if (!responseText) return;
    const coded = applyMapping(responseText, mapping);
    if (coded === responseText) return; // rien changé → on garde la forme native
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: mapStrings(payload.tool_response, (s) => applyMapping(s, mapping)),
      },
    });
    return;
  }

  // ── Écriture : dé-anonymise l'entrée (code → entité) ───────────────────────
  const fields = fieldsFor(toolName);
  if (event === 'PreToolUse' && fields && reverse && Object.keys(reverse).length) {
    const updated = {};
    for (const field of fields) {
      const value = payload.tool_input?.[field];
      if (typeof value !== 'string' || !value) continue;
      if (field === 'command' && value.length > MAX_COMMAND_LENGTH) continue;
      const reverted = revertMapping(value, reverse);
      if (reverted !== value) updated[field] = reverted;
    }
    if (!Object.keys(updated).length) return;
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, ...updated },
      },
    });
    return;
  }
}

// Garde-fou global : un délai dépassé ne doit pas figer la session.
const hardStop = setTimeout(() => process.exit(0), 5000);
hardStop.unref?.();
main().then(() => process.exit(0)).catch(() => process.exit(0));

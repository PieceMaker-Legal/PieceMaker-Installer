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
 *   - PreToolUse  (Write|Edit|telegram)  → dé-anonymise l'entrée (code → entité) ;
 *   - PreToolUse  (Read|Grep|Glob|Bash)  → rétablit le vrai CHEMIN en entrée
 *     (code → entité), symétrique du codage des noms de fichiers listés à la
 *     lecture : sans lui un chemin codé est introuvable sur disque (défaut A).
 *
 * Le disque n'est jamais réécrit : seul le résultat d'outil remis au modèle est
 * codé, et seule l'entrée d'outil sur le point de s'exécuter est restituée.
 *
 * Frontière RGPD invariante au volume : un payload d'ENTRÉE non vide mais
 * illisible (tronqué au tampon du tube) échoue FERMÉ côté lecture — on code au
 * mieux ce qu'on récupère plutôt que de laisser filer l'original en clair
 * (défaut C).
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
// Défaut A — chemins/commandes EN ENTRÉE des outils de lecture : le modèle a vu
// un nom de fichier CODÉ (anonymize-read code les noms listés), un Read/Grep/
// Glob/Bash sur ce chemin codé est donc introuvable sur disque. On rétablit le
// vrai chemin (code → entité), symétrique du codage de la sortie.
const READ_INPUT_FIELDS = { Read: ['file_path'], Grep: ['path'], Glob: ['path'], Bash: ['command'] };
const TELEGRAM_TOOLS = /^mcp__[^_]*telegram[^_]*__(reply|edit_message)$/;
/** Un mapping/scan ne doit jamais être « anonymisé » puis relu : on n'y touche pas. */
const MAPPING_FILE_PATTERNS = [/^mapping.*\.json$/i, /_sensitive_map\.json$/i, /^central-mapping\.json$/i];
const FLUSH_TIMEOUT_MS = 2000;
const MAX_COMMAND_LENGTH = 20_000;

/**
 * Lit stdin en distinguant un EOF PROPRE d'une lecture partielle (timeout /
 * erreur de flux). `complete` n'est vrai que sur `end` : un flux tronqué au
 * tampon du tube (défaut C du rapport) le marque `false`, ce qui interdit de
 * faire aveuglément confiance à un payload potentiellement coupé.
 */
function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve({ data: '', complete: true }); return; }
    let data = '';
    let done = false;
    const finish = (complete) => { if (!done) { done = true; resolve({ data, complete }); } };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => { clearTimeout(timer); finish(true); });
      process.stdin.on('error', () => { clearTimeout(timer); finish(false); });
    } catch {
      clearTimeout(timer);
      finish(false);
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

/**
 * Écrit le JSON de sortie et RÉSOUT seulement une fois stdout drainé. Le
 * `process.exit(0)` est laissé au lanceur en pied de fichier : émettre puis
 * exiter aussitôt (comme le faisait `main().then(process.exit)`) coupait la
 * sortie au tampon de 64 Ko du tube — un résultat > 64 Ko repartait tronqué,
 * donc illisible pour le harnais, qui retombait sur l'original EN CLAIR
 * (défaut C, côté sortie). On attend donc le drain avant de rendre la main.
 */
function emit(output) {
  return new Promise((resolve) => {
    let payload;
    try {
      if (!output || typeof output !== 'object') { resolve(); return; }
      payload = JSON.stringify(output);
    } catch {
      resolve();
      return;
    }
    const guard = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    guard.unref?.();
    process.stdout.write(payload, () => { clearTimeout(guard); resolve(); });
  });
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
  if (READ_INPUT_FIELDS[toolName]) return READ_INPUT_FIELDS[toolName];
  if (TELEGRAM_TOOLS.test(toolName)) return ['text'];
  return null;
}

/**
 * Extrait la première valeur chaîne d'une clé JSON même si le JSON global est
 * cassé (payload tronqué). Tolère une valeur finale non terminée : on prend
 * alors jusqu'à la fin du texte. Les noms réels y figurent littéralement, donc
 * `applyMapping` les code quand même.
 */
function extractJsonString(raw, key) {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
  const m = opener.exec(raw);
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '\\') { out += c + (raw[i + 1] || ''); i += 1; continue; }
    if (c === '"') return out;
    out += c;
  }
  return out;
}

/** Toutes les valeurs chaîne porteuses de contenu d'outil récupérables du brut. */
function salvageResponseText(raw) {
  const parts = [];
  for (const key of ['content', 'stdout', 'stderr', 'output', 'text']) {
    const opener = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
    let m;
    while ((m = opener.exec(raw))) {
      let out = '';
      let i = m.index + m[0].length;
      for (; i < raw.length; i += 1) {
        const c = raw[i];
        if (c === '\\') { out += c + (raw[i + 1] || ''); i += 1; continue; }
        if (c === '"') break;
        out += c;
      }
      if (out) parts.push(out);
      opener.lastIndex = i + 1;
    }
  }
  return parts.join('\n');
}

/** Forme de résultat d'outil crédible pour le harnais, déduite du brut. Une
 *  chaîne nue serait rejetée pour un Read et laisserait passer l'original. */
function shapeFromRaw(raw, coded) {
  if (/"stdout"\s*:/.test(raw) || /"stderr"\s*:/.test(raw)) return { stdout: coded, stderr: '' };
  if (/"file"\s*:/.test(raw) && /"content"\s*:/.test(raw)) return { file: { content: coded } };
  return { content: coded };
}

/** Le brut ressemble-t-il à une LECTURE (PostToolUse) ? Seule direction où un
 *  fail-open laisserait fuiter des noms réels ; une écriture illisible n'expose
 *  que des codes. */
function looksLikeReadPost(raw) {
  if (/"hook_event_name"\s*:\s*"PostToolUse"/.test(raw)) return true;
  if (/"old_string"\s*:/.test(raw)) return false; // signature d'un Edit
  return /"tool_response"\s*:/.test(raw) || /"stdout"\s*:/.test(raw) || /"file"\s*:/.test(raw);
}

/**
 * Fail-closed (défaut C) : un payload de LECTURE non vide mais illisible ne doit
 * pas faire retomber le harnais sur le résultat d'outil ORIGINAL en clair. On
 * code au mieux ce qu'on récupère du brut. Sans changement (aucune entité), ou
 * si le chemin visé est un fichier de mapping, on s'efface comme la voie normale.
 */
function readFailClosed(raw, mapping, applyMapping) {
  const fp = extractJsonString(raw, 'file_path') || extractJsonString(raw, 'path');
  if (fp && isMappingBasename(fp)) return null;
  const recovered = salvageResponseText(raw);
  if (!recovered) return null;
  const coded = applyMapping(recovered, mapping);
  if (coded === recovered) return null;
  return {
    hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: shapeFromRaw(raw, coded) },
  };
}

async function main() {
  if (!anonymizationEnabled()) return;

  const { data: raw, complete } = await readStdin(2000);
  if (!raw || !raw.trim()) return; // stdin vide / TTY → vraiment rien à faire

  // Mapping et moteur chargés AVANT le parse : le fail-closed (défaut C) en a
  // besoin même quand le payload est illisible.
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

  const hasMapping = mapping && Object.keys(mapping).length;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Fail-CLOSED (défaut C) : un payload NON VIDE mais illisible (tronqué au
    // tampon du tube) ne doit pas faire retomber le harnais sur le résultat
    // d'outil ORIGINAL en clair. Pour la LECTURE seulement (la frontière RGPD),
    // on code au mieux ce qu'on récupère ; une écriture illisible n'expose que
    // des codes, fail-open y reste acceptable.
    if (hasMapping && looksLikeReadPost(raw)) {
      const out = readFailClosed(raw, mapping, applyMapping);
      if (out) return emit(out);
    }
    return;
  }

  const toolName = String(payload.tool_name || '');
  const event = String(payload.hook_event_name || '');

  // Parse réussi mais flux marqué incomplet : par sécurité, on code quand même
  // (défaut C, côté défense en profondeur) au lieu de faire confiance au flux.
  if (!complete && hasMapping && event === 'PostToolUse' && READ_TOOLS.has(toolName)) {
    const targetPath = payload.tool_input?.file_path || payload.tool_input?.path;
    if (!(targetPath && isMappingBasename(targetPath))) {
      const text = resultText(payload.tool_response);
      if (text) {
        const coded = applyMapping(text, mapping);
        if (coded !== text) {
          return emit({
            hookSpecificOutput: {
              hookEventName: 'PostToolUse',
              updatedToolOutput: mapStrings(payload.tool_response, (s) => applyMapping(s, mapping)),
            },
          });
        }
      }
    }
  }

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
    return emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: mapStrings(payload.tool_response, (s) => applyMapping(s, mapping)),
      },
    });
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
    return emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, ...updated },
      },
    });
  }
}

// Garde-fou global : un délai dépassé ne doit pas figer la session.
const hardStop = setTimeout(() => process.exit(0), 5000);
hardStop.unref?.();
main().then(() => process.exit(0)).catch(() => process.exit(0));

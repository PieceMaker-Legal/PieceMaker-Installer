#!/usr/bin/env node
/**
 * PostToolUse hook (Write) — compile un rapport de recherche juridique.
 *
 * L'agent `recherche-legifrance` écrit un « payload » JSON dans
 * `~/.piecemaker/recherche-pending/<id>.json` (question initiale, décisions
 * trouvées, citation, rapport de tri Haiku, liens Legifrance). Ce hook le
 * détecte, en tire un document Markdown au gabarit fixe puis un PDF — de façon
 * *déterministe*, jamais par un LLM — et les dépose dans
 * `<dossier>/recherche/`. Le PDF est délégué à un process détaché pour ne pas
 * bloquer la session.
 *
 * Fail-open comme tous les hooks du plugin : hors payload de recherche, hors
 * cas enregistré, ou sur la moindre erreur → exit 0, stdout vide.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOME_DIR,
  loadPieceMakerConfig,
  noop,
  readHookPayload,
  runHook,
} from './lib/hook-io.mjs';

const require = createRequire(import.meta.url);
const { locateConfiguredCase } = require('./lib/case-folders.cjs');
const { resolveConfiguredCaseMapping, revertMapping } = require('./lib/mapping.cjs');
const { renderMarkdown, reportSlug } = require('./lib/recherche-report.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENDING_DIR = path.join(HOME_DIR, 'recherche-pending');

function isPendingPayload(filePath) {
  if (!filePath || !filePath.endsWith('.json')) return false;
  const rel = path.relative(PENDING_DIR, path.resolve(filePath));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function main() {
  const payload = await readHookPayload(2000);
  if (!payload || payload.tool_name !== 'Write') return null;
  if (payload.tool_response?.success === false) return null;

  const cwd = payload.cwd || process.cwd();
  const written = payload.tool_input?.file_path;
  if (!written) return null;
  const absolute = path.isAbsolute(written) ? written : path.resolve(cwd, written);
  if (!isPendingPayload(absolute)) return null;

  // Le payload vient d'être écrit : on le relit depuis le disque.
  let data;
  try {
    data = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }

  // Le cas cible est porté par le payload (l'agent sait dans quel dossier il
  // travaille) : un chemin absolu situé dans le dossier enregistré.
  const config = loadPieceMakerConfig();
  const caseHint = data.caseRoot || data.case || data.dossier;
  if (!caseHint || !path.isAbsolute(caseHint)) return null;
  const located = locateConfiguredCase(config, caseHint);
  if (!located) return null;

  const rechercheDir = path.join(located.caseRoot, 'recherche');
  const slug = reportSlug(data);
  const mdPath = path.join(rechercheDir, `${slug}.md`);
  const pdfPath = path.join(rechercheDir, `${slug}.pdf`);

  // Le modèle n'a vu que des codes ; l'historique du cabinet doit rester
  // lisible → on ré-identifie le Markdown final avant écriture disque (même
  // logique que commit-track sur les libellés). Idempotent.
  let markdown = renderMarkdown(data, { caseName: located.caseName });
  const legalCase = resolveConfiguredCaseMapping(config, located.caseRoot);
  if (legalCase?.reverse_mapping) markdown = revertMapping(markdown, legalCase.reverse_mapping);

  fs.mkdirSync(rechercheDir, { recursive: true });
  fs.writeFileSync(mdPath, markdown, 'utf8');

  // PDF : process détaché, ne bloque pas la session, échoue en silence.
  try {
    const child = spawn(process.execPath, [path.join(HERE, 'build-recherche-pdf.mjs'), mdPath, pdfPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* best-effort : le .md est déjà produit */
  }

  // Le payload transient a fait son office.
  try {
    fs.rmSync(absolute, { force: true });
  } catch {
    /* best-effort */
  }

  return null;
}

runHook(main, { timeoutMs: 8000 }).catch(() => noop());

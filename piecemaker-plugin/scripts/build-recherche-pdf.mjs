#!/usr/bin/env node
/**
 * Construit le PDF d'un rapport de recherche à partir de son Markdown.
 *
 * Lancé *détaché* par le hook `compile-recherche.mjs` (jamais par un agent) :
 * la génération du PDF ne doit pas bloquer la session, et surtout ne doit pas
 * être confiée à un LLM. Chaîne déterministe, avec ce qui est réellement
 * installé sur la machine :
 *
 *     pandoc  <rapport>.md  ->  <rapport>.docx      (mise en forme)
 *     soffice <rapport>.docx ->  <rapport>.pdf      (rendu PDF)
 *
 * Best-effort : sans pandoc ou sans LibreOffice, le .md reste produit et une
 * note `<rapport>.pdf.log` explique l'échec. Overridables par
 * `PIECEMAKER_PANDOC` / `PIECEMAKER_SOFFICE`.
 *
 * Usage : node build-recherche-pdf.mjs <chemin.md> <chemin.pdf>
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , mdPath, pdfPath] = process.argv;

function fail(message) {
  try {
    if (pdfPath) fs.writeFileSync(`${pdfPath}.log`, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
  process.exit(0); // ne jamais faire échouer la session
}

if (!mdPath || !pdfPath || !fs.existsSync(mdPath)) {
  fail(`Markdown source introuvable : ${mdPath}`);
}

const pandoc = process.env.PIECEMAKER_PANDOC || 'pandoc';
const soffice = process.env.PIECEMAKER_SOFFICE || (os.platform() === 'win32' ? 'soffice.exe' : 'soffice');

const outDir = path.dirname(pdfPath);
const stem = path.basename(pdfPath, '.pdf');
const docxPath = path.join(outDir, `${stem}.docx`);

// 1) Markdown -> DOCX (pandoc)
const toDocx = spawnSync(pandoc, [mdPath, '-o', docxPath], { timeout: 30000, encoding: 'utf8' });
if (toDocx.status !== 0 || !fs.existsSync(docxPath)) {
  fail(`Échec pandoc md->docx : ${toDocx.error?.message || toDocx.stderr || `code ${toDocx.status}`}`);
}

// 2) DOCX -> PDF (LibreOffice headless). soffice écrit `<stem>.pdf` dans --outdir.
// Un profil utilisateur dédié évite les conflits avec une instance Writer ouverte.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-soffice-'));
const toPdf = spawnSync(
  soffice,
  [
    `-env:UserInstallation=file://${profileDir}`,
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    outDir,
    docxPath,
  ],
  { timeout: 90000, encoding: 'utf8' },
);

try {
  fs.rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* best-effort */
}
try {
  fs.rmSync(docxPath, { force: true });
} catch {
  /* best-effort */
}

if (toPdf.status !== 0 || !fs.existsSync(pdfPath)) {
  fail(`Échec LibreOffice docx->pdf : ${toPdf.error?.message || toPdf.stderr || `code ${toPdf.status}`}`);
}

// Succès : purge une éventuelle note d'échec d'une tentative précédente.
try {
  fs.rmSync(`${pdfPath}.log`, { force: true });
} catch {
  /* best-effort */
}
process.exit(0);

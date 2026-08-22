'use strict';

/**
 * docx-autoopen.cjs — embed the OOXML "web extension task pane" parts into a
 * .docx so Microsoft Word auto-opens the PieceMaker add-in the first time the
 * document is opened, with no ribbon click. Pure Node (jszip) so it runs
 * identically on macOS and Windows — never shell out to `zip`.
 *
 * A .docx is an OPC (zip) package. Auto-open needs five things wired together:
 *   1. word/webextensions/taskpanes.xml        — "show this pane, docked right, visible"
 *   2. word/webextensions/webextension1.xml    — which add-in (by manifest GUID) + AutoShow property
 *   3. word/webextensions/_rels/taskpanes.xml.rels — taskpane -> webextension link
 *   4. word/_rels/document.xml.rels            — document -> taskpanes link
 *   5. [Content_Types].xml                     — content types for the two new parts
 *
 * The load-bearing trigger is the property
 *   Office.AutoShowTaskpaneWithDocument = true
 * on an installed/sideloaded add-in whose GUID matches `taskpane/manifest.xml`.
 *
 * The `store` / `storeType` fields on <we:reference> depend on how the add-in
 * is installed (dev sideload on Mac vs Windows registry). We emit a primary
 * reference plus <we:alternateReferences> so one file covers both OSes, and we
 * expose everything via env so it can be tuned without code changes. When the
 * synthesized reference does not match a machine's install, use TEMPLATE mode
 * (`injectFromTemplate`): copy the webextensions parts verbatim from a docx you
 * produced once by inserting the add-in in real Word and saving — that is the
 * bulletproof path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

// Add-in identity — must match taskpane/manifest.xml <Id>. Overridable so a
// re-GUID'd manifest doesn't require a code edit.
const ADDIN_ID = process.env.PIECEMAKER_ADDIN_ID || '12345678-1234-1234-1234-123456789abc';
const ADDIN_VERSION = process.env.PIECEMAKER_ADDIN_VERSION || '1.0.0.0';
// Store reference. Proven value (see word-taskpane-autoopen-mechanism memory):
// store="developer" storeType="Registry" is what triggers auto-open on BOTH
// macOS and Windows, resolved against the one-time dev-registration (wef folder
// on mac / HKCU registry on win). storeType="FileSystem" does NOT work — this is
// the exact reference used by office-addin-dev-settings'
// templates/WordDocumentWithTaskPane.docx.
const PRIMARY_STORE = process.env.PIECEMAKER_ADDIN_STORE || 'developer';
const PRIMARY_STORE_TYPE = process.env.PIECEMAKER_ADDIN_STORE_TYPE || 'Registry';

const NS = {
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  taskpanesRel: 'http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes',
  webextensionRel: 'http://schemas.microsoft.com/office/2011/relationships/webextension',
};

const PART = {
  contentTypes: '[Content_Types].xml',
  documentRels: 'word/_rels/document.xml.rels',
  taskpanes: 'word/webextensions/taskpanes.xml',
  taskpanesRels: 'word/webextensions/_rels/taskpanes.xml.rels',
  webextension: 'word/webextensions/webextension1.xml',
};

function newGuid() {
  // OOXML wants a braced, upper-case GUID for the webextension instance id.
  return '{' + crypto.randomUUID().toUpperCase() + '}';
}

// Structure mirrors office-addin-dev-settings' golden template
// (WordDocumentWithTaskPane.docx). visibility="1" is what makes Word show the
// pane on open; the `r` namespace is declared on the root exactly as the golden.
function taskpanesXml(webextRelId) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<wetp:taskpanes xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11">
  <wetp:taskpane dockstate="" visibility="1" width="350" row="1">
    <wetp:webextensionref r:id="${webextRelId}"/>
  </wetp:taskpane>
</wetp:taskpanes>`;
}

function taskpanesRelsXml(webextRelId) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS.rel}">
  <Relationship Id="${webextRelId}" Type="${NS.webextensionRel}" Target="webextension1.xml"/>
</Relationships>`;
}

function webextensionXml() {
  const instanceId = newGuid();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="${instanceId}">
  <we:reference id="${ADDIN_ID}" version="${ADDIN_VERSION}" store="${PRIMARY_STORE}" storeType="${PRIMARY_STORE_TYPE}"/>
  <we:alternateReferences/>
  <we:properties>
    <we:property name="Office.AutoShowTaskpaneWithDocument" value="true"/>
  </we:properties>
  <we:bindings/>
</we:webextension>`;
}

/** True if the package already carries the webextension taskpane parts. */
function hasAutoOpen(zip) {
  return zip.file(PART.taskpanes) != null && zip.file(PART.webextension) != null;
}

/** Regexp des parties `word/webextensions/webextensionN.xml` (hors _rels). */
const WEBEXT_PART_RE = /^word\/webextensions\/webextension\d+\.xml$/;

/**
 * Vrai seulement si les parties d'auto-ouverture sont déjà *canoniques* :
 * exactement une partie `webextension1.xml` qui référence notre add-in, et un
 * unique volet en `visibility="1"`. Avoir des parties ne suffit pas — Word
 * réécrit `visibility="0"` quand l'utilisateur ferme le volet et sauvegarde, et
 * un ancien passage peut laisser un `webextension2.xml` en double avec un GUID
 * périmé. Dans ces cas il faut réparer, pas court-circuiter.
 */
async function isAutoOpenHealthy(zip) {
  if (!hasAutoOpen(zip)) return false;
  const weParts = Object.keys(zip.files).filter((n) => WEBEXT_PART_RE.test(n));
  if (weParts.length !== 1 || weParts[0] !== PART.webextension) return false;
  const we = await zip.file(PART.webextension).async('string');
  if (!we.includes(`id="${ADDIN_ID}"`)) return false;
  if (!we.includes('Office.AutoShowTaskpaneWithDocument')) return false;
  const tp = await zip.file(PART.taskpanes).async('string');
  if ((tp.match(/<wetp:taskpane\b/g) || []).length !== 1) return false;
  if (!/visibility="1"/.test(tp)) return false;
  return true;
}

function ensureContentTypes(xml) {
  const overrides = [
    { part: '/word/webextensions/taskpanes.xml', type: 'application/vnd.ms-office.webextensiontaskpanes+xml' },
    { part: '/word/webextensions/webextension1.xml', type: 'application/vnd.ms-office.webextension+xml' },
  ];
  let out = xml;
  for (const o of overrides) {
    if (out.includes(`PartName="${o.part}"`)) continue;
    const override = `<Override PartName="${o.part}" ContentType="${o.type}"/>`;
    out = out.replace('</Types>', `  ${override}\n</Types>`);
  }
  return out;
}

/**
 * Add the document -> taskpanes relationship to word/_rels/document.xml.rels,
 * choosing an rId that does not collide with existing ones.
 */
function ensureDocumentRel(xml) {
  if (xml.includes(NS.taskpanesRel)) return xml; // already linked
  const existing = [...xml.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
  const nextId = 'rId' + (existing.length ? Math.max(...existing) + 1 : 1);
  const rel = `<Relationship Id="${nextId}" Type="${NS.taskpanesRel}" Target="webextensions/taskpanes.xml"/>`;
  return xml.replace('</Relationships>', `  ${rel}\n</Relationships>`);
}

/**
 * Inject the synthesized auto-open parts into `docxPath` in place.
 * Idempotent : renvoie { injected:false, reason:'already-present' } uniquement
 * si les parties existantes sont déjà canoniques (voir `isAutoOpenHealthy`).
 * Si elles sont présentes mais cassées — `visibility="0"` laissé par Word, ou
 * un `webextensionN.xml` en double au GUID périmé — elles sont **réparées** :
 * on force `visibility="1"` et on ramène à une **référence unique** correcte
 * ({ injected:true, reason:'repaired' }). Throws si le fichier n'est pas un
 * paquet .docx valide.
 */
async function injectAutoOpen(docxPath, opts = {}) {
  const buf = await fs.promises.readFile(docxPath);
  const zip = await JSZip.loadAsync(buf);

  if (!zip.file('word/document.xml')) {
    throw new Error(`Not a Word document (no word/document.xml): ${docxPath}`);
  }
  const wasPresent = hasAutoOpen(zip);
  if (wasPresent && !opts.force && (await isAutoOpenHealthy(zip))) {
    return { injected: false, reason: 'already-present' };
  }

  // Réparation : supprimer tout `webextensionN.xml` parasite (passage antérieur
  // ou réécriture de Word) pour retomber sur une référence unique. taskpanes.xml
  // et taskpanes.xml.rels sont réécrits intégralement juste après.
  for (const name of Object.keys(zip.files)) {
    if (WEBEXT_PART_RE.test(name) && name !== PART.webextension) {
      zip.remove(name);
    }
  }

  const webextRelId = 'rId1';

  // The two rels for the taskpane part and the content-types/document rels.
  zip.file(PART.taskpanes, taskpanesXml(webextRelId));
  zip.file(PART.taskpanesRels, taskpanesRelsXml(webextRelId));
  zip.file(PART.webextension, webextensionXml());

  const ct = await zip.file(PART.contentTypes).async('string');
  zip.file(PART.contentTypes, ensureContentTypes(ct));

  const docRelsFile = zip.file(PART.documentRels);
  if (!docRelsFile) {
    throw new Error(`Missing ${PART.documentRels} — cannot wire taskpane relationship`);
  }
  const docRels = await docRelsFile.async('string');
  zip.file(PART.documentRels, ensureDocumentRel(docRels));

  const out = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  await writeAtomically(docxPath, out);
  return { injected: true, reason: wasPresent ? 'repaired' : 'synthesized' };
}

/**
 * TEMPLATE mode — copy the webextensions parts verbatim from a known-good docx
 * (`templatePath`, produced once by inserting the add-in in real Word and
 * saving) onto `docxPath`. Use this when the synthesized store/storeType does
 * not match a given machine's install; a Word-authored reference always does.
 */
async function injectFromTemplate(docxPath, templatePath, opts = {}) {
  const [targetBuf, tmplBuf] = await Promise.all([
    fs.promises.readFile(docxPath),
    fs.promises.readFile(templatePath),
  ]);
  const zip = await JSZip.loadAsync(targetBuf);
  const tmpl = await JSZip.loadAsync(tmplBuf);

  if (!tmpl.file(PART.taskpanes) || !tmpl.file(PART.webextension)) {
    throw new Error(`Template has no webextensions parts: ${templatePath}`);
  }
  if (hasAutoOpen(zip) && !opts.force) {
    return { injected: false, reason: 'already-present' };
  }

  // Copy every webextensions part (there may be more than one webextensionN.xml).
  const names = Object.keys(tmpl.files).filter((n) => n.startsWith('word/webextensions/'));
  for (const name of names) {
    const f = tmpl.file(name);
    if (!f || f.dir) continue;
    zip.file(name, await f.async('nodebuffer'));
  }

  const ct = await zip.file(PART.contentTypes).async('string');
  zip.file(PART.contentTypes, ensureContentTypes(ct));

  const docRels = await zip.file(PART.documentRels).async('string');
  zip.file(PART.documentRels, ensureDocumentRel(docRels));

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeAtomically(docxPath, out);
  return { injected: true, reason: 'template' };
}

async function writeAtomically(target, buf) {
  const tmp = target + '.autoopen.' + process.pid + '.tmp';
  await fs.promises.writeFile(tmp, buf);
  await fs.promises.rename(tmp, target);
}

module.exports = {
  injectAutoOpen,
  injectFromTemplate,
  hasAutoOpen,
  ADDIN_ID,
  _internal: { ensureContentTypes, ensureDocumentRel, taskpanesXml, webextensionXml, PART },
};

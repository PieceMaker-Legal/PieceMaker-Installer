/**
 * Rendu d'un export PieceMaker (HTML produit par `export-render.cjs`) en PDF
 * ou DOCX — chronologie, historique des actes.
 *
 * À ne pas confondre avec `office-to-pdf.cjs` (`convertToPdf`), qui convertit
 * les PIÈCES DU CLIENT (.xlsx, .doc, .ppt, .rtf, .odt) avant tamponnage.
 * Là-bas, LibreOffice est obligatoire et le reste : pandoc *re-compose* le
 * document (il perd largeurs de colonnes, fusions, zones d'impression), là où
 * LibreOffice le *reproduit* — et pour une pièce versée aux débats, la
 * fidélité à ce que le client voit à l'écran est l'objet même du tamponnage.
 * NE PAS brancher le tamponnage sur ce module.
 *
 * Ici c'est l'inverse : le HTML est produit par PieceMaker lui-même, pas
 * apporté par le client. pandoc y est meilleur — vrais styles Word natifs,
 * PDF composé par typst (rapide, pas de profil LibreOffice jetable à créer/
 * détruire à chaque export) — quand il est disponible. Le repli LibreOffice
 * (`officeToPdf`) reste le comportement actuel pour les postes qui n'ont pas
 * pandoc : aucune régression n'est acceptable sur ce chemin.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { execFilePromise, officeToPdf } = require('./office-to-pdf.cjs');

// Pas d'équivalent de `SOFFICE_HINT` ici, et c'est volontaire : ce message
// existe là-bas parce que `officeToPdf` LÈVE quand LibreOffice manque. Ici,
// l'absence de pandoc ou de typst ne produit jamais d'erreur — elle change
// seulement de chaîne. Un message d'installation n'aurait donc aucun endroit
// où s'afficher ; c'est l'étape `installer/steps/10-pandoc.mjs` qui le porte.

/** Sonde un binaire selon la même logique que `findSoffice` : variable
 * d'environnement, chemins usuels, puis nom nu sondé par `--version`. */
function findBinary(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const isPathLike = candidate.includes('/') || candidate.includes('\\');
    if (isPathLike) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 30000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function findPandoc() {
  return findBinary([
    process.env.PANDOC_PATH,
    '/opt/homebrew/bin/pandoc',
    '/usr/local/bin/pandoc',
    'C:\\Program Files\\Pandoc\\pandoc.exe',
    'pandoc',
  ]);
}

function findTypst() {
  return findBinary([
    process.env.TYPST_PATH,
    '/opt/homebrew/bin/typst',
    '/usr/local/bin/typst',
    'typst',
  ]);
}

/**
 * Choix de chaîne, PUR (aucun accès disque/process) : `pandoc`/`typst` sont
 * les valeurs déjà résolues par `findPandoc`/`findTypst` (chemin ou falsy).
 */
function chooseChain({ pandoc, typst, format }) {
  if (format === 'docx') return pandoc ? 'pandoc' : 'soffice';
  if (format === 'pdf') {
    if (pandoc && typst) return 'pandoc-typst';
    if (pandoc) return 'pandoc-soffice';
    return 'soffice';
  }
  throw new Error(`Format d'export inconnu : ${format}`);
}

/**
 * Le lecteur HTML de pandoc jette intégralement le CSS : le `@page { size:
 * A4; margin: 2cm }` du gabarit (`export-render.cjs`) n'atteint donc jamais
 * typst. La mise en page passe forcément par ces métadonnées, consommées via
 * `--metadata-file` plutôt que `-V margin:x=...` (syntaxe ambiguë : x/y au
 * même niveau que les autres clés prête à confusion). Clés du gabarit typst
 * par défaut de pandoc 3.8 (`pandoc --print-default-template=typst`).
 */
function metadataYaml() {
  return `papersize: a4
margin:
  x: 2cm
  y: 2cm
lang: fr
fontsize: 10pt
page-numbering: "1"
`;
}

/**
 * PURE : ne fait qu'assembler les arguments. `typst`, si fourni, doit être le
 * CHEMIN RÉSOLU du binaire (pas seulement `'typst'`) — trouvé via
 * `TYPST_PATH`, il n'est pas forcément sur le PATH que pandoc utilisera.
 * Jamais de guillemets : `spawn` ne passe pas par un shell (même piège que
 * `sofficeArgs`, office-to-pdf.cjs:88).
 *
 * `--metadata title=` neutralise un doublon vérifié à l'exécution : le gabarit
 * de `export-render.cjs` porte le titre DEUX fois, dans `<title>` (pour
 * l'onglet du navigateur et les propriétés du document) et dans le `<h1>` du
 * corps. pandoc lit le `<title>` comme métadonnée et, en sortie autonome
 * (toujours le cas en DOCX et en PDF), le compose en tête sous le style
 * `Title` — juste avant le `<h1>` devenu `Heading1`. Sans ce drapeau, « Historique
 * des actes » apparaît donc deux fois de suite. On garde le `<h1>` (seul
 * visible par le repli LibreOffice) et on supprime la métadonnée : le gabarit
 * typst, lui, teste `#if title != none` et n'imprime alors aucun bloc de titre.
 */
function pandocArgs(htmlPath, outPath, { metadataPath, typst } = {}) {
  const ext = path.extname(outPath).toLowerCase();
  const sansTitreDouble = ['--metadata', 'title='];
  if (ext === '.docx') {
    return ['--from=html', '--to=docx', ...sansTitreDouble, '--metadata-file', metadataPath, '--output', outPath, htmlPath];
  }
  if (ext === '.pdf') {
    const args = ['--from=html', '--to=pdf'];
    if (typst) args.push(`--pdf-engine=${typst}`);
    args.push(...sansTitreDouble, '--metadata-file', metadataPath, '--output', outPath, htmlPath);
    return args;
  }
  throw new Error(`Extension de sortie non prise en charge pour pandoc : ${ext}`);
}

/**
 * Rend `html` en PDF ou DOCX dans `workDir`.
 * @returns {Promise<{path: string, engine: string}>}
 */
async function generateDocument(html, workDir, { format = 'pdf', timeout = 120000 } = {}) {
  if (format !== 'pdf' && format !== 'docx') {
    throw new Error(`Format d'export inconnu : ${format} (attendu 'pdf' ou 'docx')`);
  }

  fs.mkdirSync(workDir, { recursive: true });
  const htmlPath = path.join(workDir, 'export.html');
  fs.writeFileSync(htmlPath, html, 'utf8');

  const pandoc = findPandoc();
  const typst = findTypst();
  const chain = chooseChain({ pandoc, typst, format });

  if (chain === 'soffice') {
    const pdfPath = await officeToPdf(htmlPath, workDir, { format, timeout });
    return { path: pdfPath, engine: 'libreoffice' };
  }

  // Chaînes pandoc : le fichier de métadonnées est requis dans les deux cas.
  const metadataPath = path.join(workDir, 'export-meta.yaml');
  fs.writeFileSync(metadataPath, metadataYaml(), 'utf8');

  if (chain === 'pandoc-soffice') {
    const docxPath = path.join(workDir, 'export.docx');
    await runPandoc(pandoc, pandocArgs(htmlPath, docxPath, { metadataPath }), timeout);
    const pdfPath = await officeToPdf(docxPath, workDir, { format: 'pdf', timeout });
    return { path: pdfPath, engine: 'pandoc+libreoffice' };
  }

  // 'pandoc' (docx direct) ou 'pandoc-typst' (pdf via typst)
  const outPath = path.join(workDir, `export.${format}`);
  await runPandoc(pandoc, pandocArgs(htmlPath, outPath, { metadataPath, typst }), timeout);
  return { path: outPath, engine: chain === 'pandoc-typst' ? 'pandoc+typst' : 'pandoc' };
}

/** Lance pandoc et lève en français avec stderr si la conversion échoue — un
 * pandoc présent qui échoue est un vrai bug, on NE retombe PAS sur LibreOffice
 * ici (le choix de chaîne s'est déjà fait, en amont, sur la présence des
 * binaires). */
async function runPandoc(pandoc, args, timeout) {
  const result = await execFilePromise(pandoc, args, { timeout });
  if (result.status === 0) return;
  const detail = (result.stderr || result.stdout || '').trim()
    || (result.timedOut ? `interrompu après ${Math.round(timeout / 1000)} s` : `code ${result.status}`);
  throw new Error(`Conversion pandoc échouée (${detail})`);
}

module.exports = {
  findPandoc,
  findTypst,
  chooseChain,
  pandocArgs,
  metadataYaml,
  generateDocument,
};

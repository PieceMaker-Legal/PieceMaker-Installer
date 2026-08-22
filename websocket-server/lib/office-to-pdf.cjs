/**
 * Conversion d'une pièce vers PDF, préalable au tamponnage (`/api/stamping`).
 *
 * Les formats bureautiques (Excel en tête) passent par LibreOffice en mode
 * headless — c'est l'outil retenu par les skills documentaires officielles
 * d'Anthropic (`anthropics/skills`, `skills/xlsx/scripts/office/soffice.py`),
 * et le seul moyen fiable de rendre un classeur avec sa mise en page. On
 * reprend d'elles le profil utilisateur isolé (`-env:UserInstallation`) : sans
 * lui, la conversion échoue dès que LibreOffice est déjà ouvert sur le poste.
 *
 * Images et fichiers texte sont rendus directement avec `pdf-lib`, déjà
 * utilisé pour apposer le tampon : aucune dépendance supplémentaire.
 *
 * `pdf-lib` et `mammoth` sont requis paresseusement pour que les fonctions
 * pures restent testables avant `npm install`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const A4 = { width: 595.28, height: 841.89 };

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.log']);
// Tout ce qui doit passer par LibreOffice — les tableurs en premier.
const OFFICE_EXTENSIONS = new Set([
  '.xlsx', '.xlsm', '.xls', '.ods', '.csv',
  '.docx', '.doc', '.odt', '.rtf',
  '.pptx', '.ppt', '.odp',
  '.html', '.htm',
]);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm', '.xls', '.ods', '.csv']);

const SOFFICE_HINT = process.platform === 'darwin'
  ? 'Installez LibreOffice : brew install --cask libreoffice (ou libreoffice.org).'
  : process.platform === 'win32'
    ? 'Installez LibreOffice : winget install TheDocumentFoundation.LibreOffice (ou libreoffice.org).'
    : 'Installez LibreOffice : sudo apt install libreoffice (ou libreoffice.org).';

/** Nature du traitement à appliquer selon l'extension. */
function classify(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

function isSpreadsheet(filePath) {
  return SPREADSHEET_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

/** Chemin d'un binaire LibreOffice utilisable, ou null. */
function findSoffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    'soffice',
    'libreoffice',
  ].filter(Boolean);

  for (const candidate of candidates) {
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

// Filtre LibreOffice par format cible. Pour Word, le filtre nommé explicite
// est plus stable entre versions que le simple « docx » nu.
const SOFFICE_FILTERS = { pdf: 'pdf', docx: 'docx:MS Word 2007 XML' };

/**
 * Arguments d'une conversion via LibreOffice. Le profil isolé évite l'erreur
 * « User installation could not be completed » quand une autre instance de
 * LibreOffice tourne déjà. `format` accepte une extension simple (clé de
 * `SOFFICE_FILTERS`) ou un filtre déjà complet (`docx:MS Word 2007 XML`) — on
 * ne l'entoure jamais de guillemets, `spawn` ne passe pas par un shell et les
 * guillemets finiraient dans le nom de fichier produit.
 */
function sofficeArgs(sourcePath, outDir, profileDir, format = 'pdf') {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless',
    '--norestore',
    '--convert-to', SOFFICE_FILTERS[format] || format,
    '--outdir', outDir,
    sourcePath,
  ];
}

/** Extension du fichier produit par un format/filtre (avant le `:` éventuel). */
function outputExtension(format) {
  return String(format).split(':')[0];
}

/**
 * LibreOffice tourne en processus séparé et asynchrone : une conversion prend
 * plusieurs secondes, et `spawnSync` bloquerait la boucle d'événements de
 * `server.cjs` pendant tout ce temps — plus aucune réponse HTTP ni WebSocket,
 * le navigateur perd la connexion en plein tamponnage.
 *
 * `format` cible le PDF par défaut (usage historique, tamponnage) mais
 * accepte tout format de `SOFFICE_FILTERS` (ex. `'docx'`) pour les futurs
 * exports.
 */
function officeToPdf(sourcePath, workDir, { timeout = 180000, format = 'pdf' } = {}) {
  const soffice = findSoffice();
  if (!soffice) {
    const kind = isSpreadsheet(sourcePath) ? 'Un classeur Excel' : 'Ce format bureautique';
    return Promise.reject(new Error(`${kind} exige LibreOffice pour être converti en ${outputExtension(format).toUpperCase()}. ${SOFFICE_HINT}`));
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-lo-'));
  return execFilePromise(soffice, sofficeArgs(sourcePath, workDir, profileDir, format), { timeout })
    .then((result) => {
      const produced = path.join(workDir, `${path.basename(sourcePath, path.extname(sourcePath))}.${outputExtension(format)}`);
      if (result.status === 0 && fs.existsSync(produced)) return produced;

      const detail = (result.stderr || result.stdout || '').trim()
        || (result.timedOut ? `interrompu après ${Math.round(timeout / 1000)} s` : `code ${result.status}`);
      throw new Error(`Conversion LibreOffice échouée (${detail})`);
    })
    .finally(() => {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // profil temporaire : échec de nettoyage sans conséquence
      }
    });
}

/** `spawn` + collecte de la sortie, avec la sémantique de timeout de spawnSync. */
function execFilePromise(command, args, { timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = timeout ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout) : null;

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

// Caractères représentables par l'encodage WinAnsi de pdf-lib : tout le reste
// ferait lever `drawText`.
const NON_WINANSI = /[^\t\n\r\x20-\x7E\xA0-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g;

function sanitizeForWinAnsi(text) {
  return String(text)
    .normalize('NFC')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2500-\u257F]/g, '-')
    .replace(NON_WINANSI, '?');
}

/** Découpe un texte en lignes qui tiennent dans `maxWidth`. */
function wrapText(text, font, fontSize, maxWidth) {
  const lines = [];
  for (const rawLine of sanitizeForWinAnsi(text).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim()) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of line.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      let chunk = '';
      for (const char of word) {
        if (chunk && font.widthOfTextAtSize(chunk + char, fontSize) > maxWidth) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    }
    lines.push(current);
  }
  return lines;
}

/** PDF A4 paginé à partir de texte brut. */
async function textToPdfBytes(text) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const lineHeight = 15;
  const margin = 56;

  const lines = wrapText(text || '(document vide)', font, fontSize, A4.width - margin * 2);
  let page = pdfDoc.addPage([A4.width, A4.height]);
  let cursor = A4.height - margin;

  for (const line of lines) {
    if (cursor < margin) {
      page = pdfDoc.addPage([A4.width, A4.height]);
      cursor = A4.height - margin;
    }
    if (line) page.drawText(line, { x: margin, y: cursor, size: fontSize, font, color: rgb(0, 0, 0) });
    cursor -= lineHeight;
  }
  return pdfDoc.save();
}

/** PDF d'une page contenant l'image, centrée et mise à l'échelle. */
async function imageToPdfBytes(imageBytes, ext) {
  const { PDFDocument } = require('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const image = ext === '.png' ? await pdfDoc.embedPng(imageBytes) : await pdfDoc.embedJpg(imageBytes);
  const margin = 28;
  const scale = Math.min((A4.width - margin * 2) / image.width, (A4.height - margin * 2) / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;
  pdfDoc.addPage([A4.width, A4.height]).drawImage(image, {
    x: (A4.width - width) / 2,
    y: (A4.height - height) / 2,
    width,
    height,
  });
  return pdfDoc.save();
}

/**
 * Rend `sourcePath` disponible en PDF dans `workDir`.
 * @returns {Promise<{pdfPath: string, engine: string, converted: boolean}>}
 */
async function convertToPdf(sourcePath, workDir) {
  const ext = path.extname(sourcePath).toLowerCase();
  const kind = classify(sourcePath);

  if (kind === 'pdf') return { pdfPath: sourcePath, engine: 'aucune', converted: false };

  fs.mkdirSync(workDir, { recursive: true });
  const target = path.join(workDir, `${path.basename(sourcePath, ext)}.pdf`);

  if (kind === 'office') {
    return { pdfPath: await officeToPdf(sourcePath, workDir), engine: 'libreoffice', converted: true };
  }

  if (kind === 'image') {
    fs.writeFileSync(target, await imageToPdfBytes(fs.readFileSync(sourcePath), ext === '.png' ? '.png' : '.jpg'));
    return { pdfPath: target, engine: 'pdf-lib (image)', converted: true };
  }

  if (kind === 'text') {
    fs.writeFileSync(target, await textToPdfBytes(fs.readFileSync(sourcePath, 'utf8')));
    return { pdfPath: target, engine: 'pdf-lib (texte)', converted: true };
  }

  throw new Error(`Type de fichier non pris en charge pour le tamponnage : ${ext || '(sans extension)'}`);
}

module.exports = {
  OFFICE_EXTENSIONS,
  SOFFICE_HINT,
  SPREADSHEET_EXTENSIONS,
  classify,
  convertToPdf,
  execFilePromise,
  findSoffice,
  imageToPdfBytes,
  isSpreadsheet,
  officeToPdf,
  outputExtension,
  sanitizeForWinAnsi,
  sofficeArgs,
  SOFFICE_FILTERS,
  textToPdfBytes,
};

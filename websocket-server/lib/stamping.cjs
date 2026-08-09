const path = require('node:path');

const STAMPED_PIECES_SUBFOLDER = 'Pièces tamponnées';

function stampedPiecesDirectory(caseFolder) {
  return path.join(caseFolder, STAMPED_PIECES_SUBFOLDER);
}

/**
 * Le fichier historique s'appelle `tampon.png`, mais les anciennes interfaces
 * acceptaient aussi les JPEG sans les convertir. On se fie donc à la signature
 * binaire, jamais à l'extension ni au media type envoyé par le navigateur.
 */
function detectStampImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    throw new Error('Image du tampon vide ou invalide.');
  }

  const isPng = buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) return { format: 'png', mimeType: 'image/png' };

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return { format: 'jpeg', mimeType: 'image/jpeg' };

  throw new Error('Format d’image du tampon non supporté. Utilisez PNG ou JPEG.');
}

function stampDataUrl(buffer) {
  const { mimeType } = detectStampImage(buffer);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

module.exports = {
  STAMPED_PIECES_SUBFOLDER,
  detectStampImage,
  stampDataUrl,
  stampedPiecesDirectory,
};

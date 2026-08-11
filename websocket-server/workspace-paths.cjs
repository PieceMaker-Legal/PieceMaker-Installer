const path = require('path');
const { locateConfiguredCase } = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Resolve a selected path to the registered legal-case folder that contains it. */
function resolveConfiguredLegalCaseFolder(config, selectedFolder) {
  if (!selectedFolder) throw new Error('Dossier de travail manquant.');
  const located = locateConfiguredCase(config || {}, selectedFolder);
  if (!located) {
    throw new Error('Ce dossier de travail n’est pas enregistré dans PieceMaker. Ajoutez-le depuis le panneau d’administration.');
  }
  return located.caseRoot;
}

module.exports = {
  isInside,
  resolveConfiguredLegalCaseFolder,
};

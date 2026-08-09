const fs = require('fs');
const path = require('path');
const { locateConfiguredCase } = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');

function configuredWorkspacePath(homeDir) {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'));
    if (config?.workspacePath) return config.workspacePath;
  } catch {}
  throw new Error('Le dossier racine PieceMaker n’est pas configuré. Relancez l’étape « Dossier racine PieceMaker » de l’installeur.');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Resolve the immediate legal-case directory containing `selectedFolder`.
 * Both the workspace and selected folder must already exist; realpath checks
 * prevent a symlink from escaping the configured workspace.
 */
function resolveLegalCaseFolder(workspacePath, selectedFolder) {
  if (!workspacePath || !selectedFolder) throw new Error('Dossier de travail ou racine PieceMaker manquant.');
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const selected = fs.realpathSync(path.resolve(selectedFolder));
  if (!fs.statSync(workspace).isDirectory() || !fs.statSync(selected).isDirectory()) {
    throw new Error('La racine PieceMaker et le dossier de travail doivent être des dossiers.');
  }
  if (!isInside(workspace, selected)) {
    throw new Error(`Le document doit être enregistré dans un dossier juridique sous la racine PieceMaker : ${workspace}`);
  }
  const caseName = path.relative(workspace, selected).split(path.sep)[0];
  if (!caseName || caseName.startsWith('.')) throw new Error('Dossier juridique invalide.');
  const legalCase = fs.realpathSync(path.join(workspace, caseName));
  if (!isInside(workspace, legalCase) || path.dirname(legalCase) !== workspace) {
    throw new Error('Le dossier juridique doit être un sous-dossier immédiat de la racine PieceMaker.');
  }
  return legalCase;
}

function isLegalCaseFolder(workspacePath, candidate) {
  try {
    return resolveLegalCaseFolder(workspacePath, candidate) === fs.realpathSync(path.resolve(candidate));
  } catch {
    return false;
  }
}

/** Resolve a selected path against explicit caseFolders, then legacy workspace. */
function resolveConfiguredLegalCaseFolder(config, selectedFolder) {
  if (!selectedFolder) throw new Error('Dossier de travail manquant.');
  const located = locateConfiguredCase(config || {}, selectedFolder);
  if (!located) {
    throw new Error('Ce dossier de travail n’est pas enregistré dans PieceMaker. Ajoutez-le depuis le panneau d’administration.');
  }
  return located.caseRoot;
}

module.exports = {
  configuredWorkspacePath,
  isInside,
  isLegalCaseFolder,
  resolveConfiguredLegalCaseFolder,
  resolveLegalCaseFolder,
};

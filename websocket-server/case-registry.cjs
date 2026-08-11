/** Explicit legal-case folder registry used by the local admin and hooks. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  isTechnicalCaseDirectoryName,
} = require('../piecemaker-plugin/scripts/lib/commits.cjs');
const {
  configuredWatchPaths,
  registeredCaseFolders,
} = require('../piecemaker-plugin/scripts/lib/case-folders.cjs');

function readRegistryConfig(configFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function caseFolderId(folder) {
  const digest = crypto.createHash('sha256').update(path.resolve(folder)).digest('hex').slice(0, 20);
  return `folder-${digest}`;
}

function explicitEntries(config) {
  return registeredCaseFolders(config).map((root) => ({
    id: caseFolderId(root),
    name: path.basename(root),
    root,
    casesRoot: path.dirname(root),
    caseName: path.basename(root),
    registered: true,
  }));
}

/**
 * Admin index: only the explicitly registered legal-case folders. There is no
 * longer a workspace root whose immediate children are listed automatically —
 * a matter appears once it has been registered from the admin panel.
 */
function listConfiguredCases(config) {
  return explicitEntries(config).sort((a, b) =>
    a.name.localeCompare(b.name, 'fr') || a.root.localeCompare(b.root, 'fr'));
}

function resolveCaseReference(config, reference) {
  const token = String(reference || '').trim();
  if (!token) throw new Error('Dossier juridique invalide.');
  const explicit = explicitEntries(config).find((entry) => entry.id === token);
  if (!explicit) throw new Error('Ce dossier juridique n’est pas enregistré.');
  return explicit;
}

function validateSelectedCaseFolder(folder) {
  const requested = String(folder || '').trim();
  if (!requested || !path.isAbsolute(requested)) throw new Error('Le dossier sélectionné doit avoir un chemin absolu.');
  let root;
  try {
    root = fs.realpathSync(path.resolve(requested));
  } catch {
    throw new Error('Le dossier sélectionné est introuvable.');
  }
  if (!fs.statSync(root).isDirectory()) throw new Error('La sélection doit être un dossier existant.');
  const name = path.basename(root);
  if (!name || name.startsWith('.') || isTechnicalCaseDirectoryName(name)) {
    throw new Error('Ce dossier ne peut pas être enregistré comme dossier juridique.');
  }
  return root;
}

function registerCaseFolder(config, folder) {
  const root = validateSelectedCaseFolder(folder);
  const existing = registeredCaseFolders(config);
  const caseFolders = [...new Set([...existing, root])];
  const next = { ...config, caseFolders };
  next.anonymization = {
    ...(config?.anonymization || {}),
    watchPaths: configuredWatchPaths(next),
  };
  return { config: next, entry: explicitEntries(next).find((item) => item.root === root) };
}

module.exports = {
  caseFolderId,
  listConfiguredCases,
  readRegistryConfig,
  registerCaseFolder,
  resolveCaseReference,
  validateSelectedCaseFolder,
};

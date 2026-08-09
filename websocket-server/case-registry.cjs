/** Explicit legal-case folder registry used by the local admin and hooks. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  isTechnicalCaseDirectoryName,
  listCases,
  resolveCase,
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
 * Admin index: explicit folders plus historical immediate workspace children.
 * Once a legacy child is explicitly selected, only its registered entry is
 * shown so it has one stable id even if another folder shares its basename.
 */
function listConfiguredCases(config) {
  const explicit = explicitEntries(config);
  const roots = new Set(explicit.map((entry) => entry.root));
  const legacy = [];
  if (config?.workspacePath) {
    let index = null;
    try {
      index = listCases(config.workspacePath);
    } catch {
      index = null;
    }
    for (const folder of index?.folders || []) {
      try {
        const legalCase = resolveCase(index.root, folder.name);
        if (roots.has(legalCase.root)) continue;
        legacy.push({
          id: folder.path,
          name: folder.name,
          root: legalCase.root,
          casesRoot: legalCase.casesRoot,
          caseName: legalCase.name,
          registered: false,
        });
      } catch {
        // A folder disappearing during the scan is simply omitted.
      }
    }
  }
  return [...explicit, ...legacy].sort((a, b) =>
    a.name.localeCompare(b.name, 'fr') || a.root.localeCompare(b.root, 'fr'));
}

function resolveCaseReference(config, reference) {
  const token = String(reference || '').trim();
  if (!token) throw new Error('Dossier juridique invalide.');
  const explicit = explicitEntries(config).find((entry) => entry.id === token);
  if (explicit) return explicit;
  if (!config?.workspacePath) throw new Error('Ce dossier juridique n’est pas enregistré.');
  const legalCase = resolveCase(config.workspacePath, token);
  return {
    id: token,
    name: legalCase.name,
    root: legalCase.root,
    casesRoot: legalCase.casesRoot,
    caseName: legalCase.name,
    registered: false,
  };
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

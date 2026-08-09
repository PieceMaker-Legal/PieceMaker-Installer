/** Registered PieceMaker legal-case folders, including folders outside a common root. */
const fs = require('node:fs');
const path = require('node:path');

const { locateCase } = require('./protection.cjs');

function realDirectory(value) {
  const requested = String(value || '').trim();
  if (!requested || !path.isAbsolute(requested)) return null;
  try {
    const resolved = fs.realpathSync(path.resolve(requested));
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** Absolute, existing and de-duplicated folders explicitly registered by the admin. */
function registeredCaseFolders(config) {
  const folders = Array.isArray(config?.caseFolders) ? config.caseFolders : [];
  return [...new Set(folders.map(realDirectory).filter(Boolean))];
}

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Locate a target inside one of the explicitly registered legal-case folders. */
function locateRegisteredCase(folders, target) {
  if (!target) return null;
  let absolute;
  try {
    absolute = fs.realpathSync(path.resolve(String(target)));
  } catch {
    // Write/Edit may target a file that does not exist yet. Resolve its nearest
    // existing parent, then append the missing tail without following links.
    let current = path.resolve(String(target));
    const tail = [];
    while (path.dirname(current) !== current) {
      try {
        absolute = path.join(fs.realpathSync(current), ...tail);
        break;
      } catch {
        tail.unshift(path.basename(current));
        current = path.dirname(current);
      }
    }
    if (!absolute) return null;
  }

  // A nested registered matter wins over its parent. It prevents a folder
  // intentionally registered as its own case from sharing the parent's map.
  const roots = [...new Set((folders || []).map(realDirectory).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  for (const caseRoot of roots) {
    if (!isInsideOrEqual(caseRoot, absolute)) continue;
    return {
      casesRoot: path.dirname(caseRoot),
      caseName: path.basename(caseRoot),
      caseRoot,
      absolute,
      relative: path.relative(caseRoot, absolute).split(path.sep).join('/'),
      registered: true,
    };
  }
  return null;
}

/**
 * Locate a target using the explicit registry first, with the historical
 * workspace/immediate-child convention retained for existing installations.
 */
function locateConfiguredCase(config, target) {
  const registered = locateRegisteredCase(registeredCaseFolders(config), target);
  if (registered) return registered;
  return config?.workspacePath ? locateCase(config.workspacePath, target) : null;
}

function configuredWatchPaths(config) {
  return [...new Set([
    config?.workspacePath ? realDirectory(config.workspacePath) : null,
    ...registeredCaseFolders(config),
  ].filter(Boolean))];
}

module.exports = {
  configuredWatchPaths,
  locateConfiguredCase,
  locateRegisteredCase,
  registeredCaseFolders,
};

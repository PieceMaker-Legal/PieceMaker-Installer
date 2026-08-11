/** Registered PieceMaker legal-case folders, including folders outside a common root. */
const fs = require('node:fs');
const path = require('node:path');

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
 * Locate a target inside one of the explicitly registered legal-case folders.
 * There is no longer a workspace-root fallback: a matter is protected only once
 * it is explicitly registered, never by mere location under a common root.
 */
function locateConfiguredCase(config, target) {
  return locateRegisteredCase(registeredCaseFolders(config), target);
}

function configuredWatchPaths(config) {
  return registeredCaseFolders(config);
}

module.exports = {
  configuredWatchPaths,
  locateConfiguredCase,
  locateRegisteredCase,
  registeredCaseFolders,
};

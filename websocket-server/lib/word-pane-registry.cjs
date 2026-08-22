'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PANE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createWordPaneRegistry(options = {}) {
  const platform = options.platform || process.platform;
  const realpathSync = options.realpathSync || fs.realpathSync.native;
  const createPaneId = options.createPaneId || randomUUID;
  const panesByPath = new Map();
  const panesById = new Map();
  const panePaths = new WeakMap();
  const paneIds = new WeakMap();
  const identityVersions = new WeakMap();

  function documentKey(docPath) {
    let key = path.resolve(docPath);
    try { key = realpathSync(key); } catch { /* garder le chemin absolu */ }
    key = key.normalize('NFC');
    return platform === 'win32' ? key.toLowerCase() : key;
  }

  function validPaneId(value) {
    return typeof value === 'string' && PANE_ID_PATTERN.test(value.trim());
  }

  function freshPaneId() {
    let paneId;
    do { paneId = createPaneId(); } while (!validPaneId(paneId) || panesById.has(paneId));
    return paneId;
  }

  function remove(client) {
    const panePath = panePaths.get(client);
    if (panePath && panesByPath.get(panePath) === client) panesByPath.delete(panePath);

    const paneId = paneIds.get(client);
    if (paneId && panesById.get(paneId) === client) panesById.delete(paneId);

    panePaths.delete(client);
    paneIds.delete(client);
    identityVersions.delete(client);
  }

  function register(client, docPath, proposedPaneId) {
    if (!client || !docPath) throw new Error('Volet Word ou chemin de document manquant.');

    const panePath = documentKey(docPath);
    const previousPath = panePaths.get(client);
    if (previousPath && previousPath !== panePath && panesByPath.get(previousPath) === client) {
      panesByPath.delete(previousPath);
    }

    let paneId = paneIds.get(client);
    if (!paneId) {
      const requestedId = validPaneId(proposedPaneId) ? proposedPaneId.trim().toLowerCase() : null;
      const currentOwner = requestedId ? panesById.get(requestedId) : null;
      if (currentOwner && currentOwner !== client && currentOwner.readyState !== 1) remove(currentOwner);
      paneId = requestedId && !panesById.has(requestedId) ? requestedId : freshPaneId();
      paneIds.set(client, paneId);
      panesById.set(paneId, client);
    }

    panePaths.set(client, panePath);
    panesByPath.set(panePath, client);
    identityVersions.set(client, (identityVersions.get(client) || 0) + 1);

    return { paneId, panePath };
  }

  return {
    documentKey,
    register,
    remove,
    getByPath(docPath) {
      return docPath ? panesByPath.get(documentKey(docPath)) || null : null;
    },
    getById(paneId) {
      if (!validPaneId(paneId)) return null;
      return panesById.get(paneId.trim().toLowerCase()) || null;
    },
    idFor(client) {
      return paneIds.get(client) || null;
    },
    pathFor(client) {
      return panePaths.get(client) || null;
    },
    identityVersionFor(client) {
      return identityVersions.get(client) || 0;
    },
    get pathCount() {
      return panesByPath.size;
    },
    get idCount() {
      return panesById.size;
    },
  };
}

module.exports = {
  PANE_ID_PATTERN,
  createWordPaneRegistry,
};

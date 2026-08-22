import { startServer } from '../installer/lib/service.mjs';
import { fetchPieceMaker } from './piecemaker-fetch.mjs';

const MANAGED_LOCAL_URL = 'https://localhost:43098';

async function healthResponds(serverUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${serverUrl}/health`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Rend le premier open_doc autonome. Une URL surchargée est considérée comme
 * appartenant à l'appelant : le MCP ne démarre jamais un processus local à sa
 * place. Seule l'instance PieceMaker standard, strictement en loopback, peut
 * être démarrée automatiquement par le gestionnaire de service existant.
 */
export async function ensurePieceMakerServer(serverUrl, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetchPieceMaker;
  const start = dependencies.startServer || startServer;

  if (await healthResponds(serverUrl, fetchImpl)) return { ready: true, started: false };
  if (serverUrl !== MANAGED_LOCAL_URL) return { ready: false, started: false, managed: false };

  try {
    await start();
  } catch (error) {
    throw new Error(`Serveur PieceMaker indisponible ; démarrage automatique impossible : ${error.message}`);
  }

  if (!await healthResponds(serverUrl, fetchImpl)) {
    throw new Error('Serveur PieceMaker démarré, mais /health reste indisponible. Consultez « piecemaker logs ».');
  }
  return { ready: true, started: true };
}

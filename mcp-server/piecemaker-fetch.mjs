import { Agent as HttpsAgent } from 'node:https';
import fetch from 'node-fetch';

const LOOPBACK_HTTPS_AGENT = new HttpsAgent({ rejectUnauthorized: false });

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const match = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && match.slice(1).every((octet) => Number(octet) <= 255));
}

/**
 * Accepte le certificat local PieceMaker uniquement pour HTTPS en loopback.
 * Toutes les autres destinations conservent la validation TLS de Node.
 */
export function pieceMakerHttpsAgent(url) {
  const parsed = new URL(url);
  return parsed.protocol === 'https:' && isLoopbackHostname(parsed.hostname)
    ? LOOPBACK_HTTPS_AGENT
    : undefined;
}

export function fetchPieceMaker(url, options = {}) {
  const agent = pieceMakerHttpsAgent(url);
  return fetch(url, agent ? { ...options, agent } : options);
}

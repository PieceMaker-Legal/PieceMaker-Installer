/**
 * Step 05 — HTTPS certificates for the Word taskpane.
 *
 * The certificate Word's taskpane needs — a CA + a localhost server cert,
 * read directly by server.cjs at
 * websocket-server/localhost.{crt,key} — is produced by
 * websocket-server/generate-ca-certificates.cjs. That is what this step
 * drives; verify-certificates.cjs's checks are reproduced inline via openssl
 * so we get a structured result instead of parsing console output.
 */

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm, nonInteractive } from '../lib/prompt.mjs';
import { commandExists, runCapture, IS_WINDOWS, IS_MAC, REPO_ROOT } from '../lib/platform.mjs';

export const meta = {
  id: '05-certificats',
  label: 'Certificats HTTPS',
  description: 'Génère le certificat local requis par Word pour charger le complément en HTTPS',
};

const CERT_DIR = path.join(REPO_ROOT, 'websocket-server');
const CERT_PATH = path.join(CERT_DIR, 'localhost.crt');
const KEY_PATH = path.join(CERT_DIR, 'localhost.key');
const GEN_SCRIPT = path.join(CERT_DIR, 'generate-ca-certificates.cjs');

// Certs valid for less than this many seconds are treated as "needs renewal".
const EXPIRY_MARGIN_SECONDS = 30 * 24 * 60 * 60; // 30 days

const require = createRequire(import.meta.url);

/**
 * Read-only validity probe. Returns 'missing', 'expiring' (or unreadable), or 'valid'.
 * When openssl is unavailable the expiry check is skipped gracefully — presence
 * of both files is then treated as good enough.
 */
function probeCert() {
  const filesExist = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
  if (!filesExist) return { state: 'missing' };

  if (!commandExists('openssl', ['version'])) {
    return { state: 'valid', opensslMissing: true };
  }

  const checkend = runCapture('openssl', ['x509', '-checkend', String(EXPIRY_MARGIN_SECONDS), '-noout', '-in', CERT_PATH]);
  if (checkend.code === 0) return { state: 'valid' };

  const enddate = runCapture('openssl', ['x509', '-enddate', '-noout', '-in', CERT_PATH]);
  return { state: 'expiring', enddate: enddate.stdout.replace(/^notAfter=/, '') };
}

function installCATrust(caCertPath) {
  if (IS_MAC) {
    // Requires an admin password entered interactively — stdio must be
    // inherited so the user can type it in the real terminal.
    const result = spawnSync(
      'sudo',
      ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', caCertPath],
      { stdio: 'inherit' }
    );
    return result.status === 0;
  }
  if (IS_WINDOWS) {
    const result = spawnSync('certutil', ['-addstore', '-user', 'Root', caCertPath], { stdio: 'inherit' });
    return result.status === 0;
  }
  return false;
}

export async function install(ctx) {
  const probe = probeCert();

  if (probe.state === 'valid') {
    log.ok(`Certificat déjà valide : ${CERT_PATH}`);
    if (probe.opensslMissing) log.detail('openssl absent — expiration non vérifiée, présence des fichiers seulement.');
    return { status: 'done', note: '' };
  }

  if (ctx.dryRun) {
    log.info(`[simulation] Génération du certificat CA + serveur dans ${CERT_DIR}`);
    return { status: 'skipped', note: 'Mode simulation — aucune modification effectuée.' };
  }

  if (!commandExists('openssl', ['version'])) {
    return {
      status: 'failed',
      note: 'OpenSSL introuvable — installez-le (brew install openssl / choco install openssl) puis relancez cette étape.',
    };
  }

  const filesExist = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
  if (filesExist && probe.state === 'expiring') {
    const regenerate = await confirm(
      `Le certificat existant expire bientôt (${probe.enddate || 'date inconnue'}). Le régénérer ?`,
      true
    );
    if (!regenerate) {
      return { status: 'partial', note: 'Certificat existant conservé malgré son expiration prochaine.' };
    }
  }

  if (!fs.existsSync(GEN_SCRIPT)) {
    return { status: 'failed', note: `Script de génération introuvable : ${GEN_SCRIPT}` };
  }

  const { generateCACertificates, verifyCertificate } = require(GEN_SCRIPT);

  const spin = spinner('Génération du certificat CA et du certificat serveur (localhost)...');
  let result;
  try {
    result = await generateCACertificates(CERT_DIR);
  } catch (error) {
    spin.fail('Échec de la génération des certificats');
    return { status: 'failed', note: `${error.message} — vérifiez qu'openssl fonctionne (openssl version).` };
  }
  spin.succeed(`Certificats générés : ${path.basename(CERT_PATH)} / ${path.basename(KEY_PATH)}`);

  try {
    await verifyCertificate(result.serverCert, result.caCert);
  } catch {
    log.warn('La vérification du certificat serveur a échoué — les fichiers sont générés mais non validés.');
  }

  // Trust the CA at the OS level so Word/WebView2 accept the connection
  // without a security warning. Requires admin rights — ask first.
  if (nonInteractive || !process.stdout.isTTY) {
    return {
      status: 'partial',
      note: `Certificats générés mais CA non ajoutée au magasin de confiance (mode non interactif). Exécutez manuellement : node "${GEN_SCRIPT}"`,
    };
  }

  const wantTrust = await confirm(
    'Ajouter ce certificat aux autorités de confiance du système ? Nécessaire pour que Word charge le complément sans avertissement (mot de passe administrateur requis).',
    true
  );

  if (!wantTrust) {
    return {
      status: 'partial',
      note: 'CA non ajoutée au magasin de confiance — Word peut afficher un avertissement de sécurité.',
    };
  }

  log.step('Ajout du certificat CA au magasin de confiance du système...');
  const trusted = installCATrust(result.caCert);
  if (!trusted) {
    return {
      status: 'partial',
      note: 'Échec de l\'ajout au magasin de confiance (droits administrateur ?). Certificats générés mais non approuvés.',
    };
  }
  log.ok('Certificat CA approuvé par le système');

  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const probe = probeCert();
  if (probe.state === 'valid') {
    return { status: 'done', note: probe.opensslMissing ? 'Présence vérifiée (openssl absent, expiration non testée).' : '' };
  }
  if (probe.state === 'expiring') {
    return { status: 'partial', note: `Certificat expire bientôt (${probe.enddate || 'date inconnue'}).` };
  }
  return { status: 'failed', note: `Certificat manquant : ${CERT_PATH}` };
}

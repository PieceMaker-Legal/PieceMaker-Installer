/**
 * Génération d'un certificat d'autorité de certification (CA) et d'un certificat serveur
 * Compatible avec Word Office et les navigateurs
 * Basé sur les spécifications de l'app "GPT localhost"
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const execPromise = promisify(exec);

/**
 * Génère un certificat CA root et un certificat serveur pour localhost
 * @param {string} outputDir - Répertoire de sortie pour les certificats
 * @returns {Promise<{caKey, caCert, serverKey, serverCert, fingerprint}>}
 */
async function generateCACertificates(outputDir) {
  console.log('🔧 Génération du certificat CA et du certificat serveur...');

  // Créer le répertoire de sortie si nécessaire
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const caKeyPath = path.join(outputDir, 'piecemaker-ca.key');
  const caCertPath = path.join(outputDir, 'piecemaker-ca.crt');
  const serverKeyPath = path.join(outputDir, 'localhost.key');
  const serverCertPath = path.join(outputDir, 'localhost.crt');
  const configPath = path.join(outputDir, 'openssl.cnf');

  // Configuration OpenSSL pour le certificat CA
  const caConfig = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
prompt = no

[req_distinguished_name]
C = FR
ST = France
L = Paris
O = PieceMaker
OU = PieceMaker Certificate Authority
CN = PieceMaker Root CA

[v3_ca]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
`;

  // Configuration OpenSSL pour le certificat serveur
  const serverConfig = `
[req]
distinguished_name = req_distinguished_name
req_extensions = v3_req
prompt = no

[req_distinguished_name]
C = FR
ST = France
L = Paris
O = PieceMaker
OU = PieceMaker Web Server
CN = localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;

  try {
    // Étape 1: Générer la clé privée CA (RSA 2048 bits)
    console.log('📝 Génération de la clé privée CA (RSA 2048 bits)...');
    await execPromise(`openssl genrsa -out "${caKeyPath}" 2048`);

    // Écrire la configuration CA
    fs.writeFileSync(configPath, caConfig);

    // Étape 2: Générer le certificat CA auto-signé (valide 10 ans)
    console.log('📝 Génération du certificat CA auto-signé...');
    await execPromise(
      `openssl req -new -x509 -sha256 -days 3650 -key "${caKeyPath}" -out "${caCertPath}" -config "${configPath}"`
    );

    // Étape 3: Générer la clé privée du serveur (RSA 2048 bits)
    console.log('📝 Génération de la clé privée serveur (RSA 2048 bits)...');
    await execPromise(`openssl genrsa -out "${serverKeyPath}" 2048`);

    // Écrire la configuration serveur
    fs.writeFileSync(configPath, serverConfig);

    // Étape 4: Générer une demande de signature de certificat (CSR) pour le serveur
    console.log('📝 Génération de la demande de signature (CSR)...');
    const csrPath = path.join(outputDir, 'localhost.csr');
    await execPromise(
      `openssl req -new -key "${serverKeyPath}" -out "${csrPath}" -config "${configPath}"`
    );

    // Étape 5: Signer le certificat serveur avec le CA (valide 2 ans)
    console.log('📝 Signature du certificat serveur avec le CA...');
    const extConfigPath = path.join(outputDir, 'v3.ext');
    const extConfig = `
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth,clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
IP.1 = 127.0.0.1
IP.2 = ::1
`;
    fs.writeFileSync(extConfigPath, extConfig);

    await execPromise(
      `openssl x509 -req -in "${csrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial -out "${serverCertPath}" -days 730 -sha256 -extfile "${extConfigPath}"`
    );

    // Calculer l'empreinte SHA1 du certificat CA (requis par Windows)
    console.log('📝 Calcul de l\'empreinte SHA1...');
    const { stdout } = await execPromise(`openssl x509 -in "${caCertPath}" -noout -fingerprint -sha1`);
    const fingerprint = stdout.match(/Fingerprint=([A-F0-9:]+)/)?.[1] || '';

    // Nettoyer les fichiers temporaires
    [configPath, csrPath, extConfigPath, path.join(outputDir, 'piecemaker-ca.srl')].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });

    console.log('✅ Certificats générés avec succès!');
    console.log(`   CA Cert: ${caCertPath}`);
    console.log(`   CA Key: ${caKeyPath}`);
    console.log(`   Server Cert: ${serverCertPath}`);
    console.log(`   Server Key: ${serverKeyPath}`);
    console.log(`   SHA1 Fingerprint: ${fingerprint}`);

    return {
      caKey: caKeyPath,
      caCert: caCertPath,
      serverKey: serverKeyPath,
      serverCert: serverCertPath,
      fingerprint: fingerprint
    };

  } catch (error) {
    console.error('❌ Erreur lors de la génération des certificats:', error);
    throw error;
  }
}

/**
 * Installe le certificat CA dans le trust store Windows
 * @param {string} caCertPath - Chemin vers le certificat CA
 * @returns {Promise<boolean>}
 */
async function installCAInWindows(caCertPath) {
  try {
    console.log('🔐 Installation du certificat CA dans le trust store Windows...');

    // Installer dans le store Root (Autorités racines de confiance) pour l'utilisateur actuel
    // Note: Pour une installation système complète, il faudrait utiliser -machineRoot
    await execPromise(`certutil -addstore -user Root "${caCertPath}"`);

    console.log('✅ Certificat CA installé dans le trust store Windows (Root)');
    return true;
  } catch (error) {
    console.error('❌ Erreur installation CA dans Windows:', error);
    throw error;
  }
}

/**
 * Installe le certificat CA dans le trust store macOS
 * @param {string} caCertPath - Chemin vers le certificat CA
 * @returns {Promise<boolean>}
 */
async function installCAInMacOS(caCertPath) {
  try {
    console.log('🔐 Installation du certificat CA dans le trust store macOS...');

    // Ajouter au keychain système
    await execPromise(`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caCertPath}"`);

    console.log('✅ Certificat CA installé dans le keychain macOS');
    return true;
  } catch (error) {
    console.error('❌ Erreur installation CA dans macOS:', error);
    throw error;
  }
}

/**
 * Vérifie la validité du certificat serveur
 * @param {string} serverCertPath - Chemin vers le certificat serveur
 * @param {string} caCertPath - Chemin vers le certificat CA
 */
async function verifyCertificate(serverCertPath, caCertPath) {
  try {
    console.log('🔍 Vérification du certificat serveur...');

    const { stdout } = await execPromise(`openssl verify -CAfile "${caCertPath}" "${serverCertPath}"`);
    console.log('✅ Certificat vérifié:', stdout.trim());

    // Afficher les détails du certificat
    const { stdout: details } = await execPromise(`openssl x509 -in "${serverCertPath}" -noout -text`);
    console.log('📋 Détails du certificat:');
    console.log(details);

    return true;
  } catch (error) {
    console.error('❌ Erreur vérification certificat:', error);
    return false;
  }
}

module.exports = {
  generateCACertificates,
  installCAInWindows,
  installCAInMacOS,
  verifyCertificate
};

// Si exécuté directement
if (require.main === module) {
  const outputDir = path.join(__dirname);

  generateCACertificates(outputDir)
    .then(async (result) => {
      console.log('\n✅ Génération terminée!');
      console.log('Empreinte SHA1:', result.fingerprint);

      // Vérifier le certificat
      await verifyCertificate(result.serverCert, result.caCert);

      // Installer sur Windows si applicable
      if (process.platform === 'win32') {
        await installCAInWindows(result.caCert);
      } else if (process.platform === 'darwin') {
        await installCAInMacOS(result.caCert);
      }
    })
    .catch((error) => {
      console.error('❌ Échec:', error.message);
      process.exit(1);
    });
}

/**
 * Script de vérification des certificats SSL
 * Vérifie que le certificat serveur est correctement signé par le CA
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execPromise = promisify(exec);

async function verifyCertificates() {
  const certDir = __dirname;
  const caCert = path.join(certDir, 'piecemaker-ca.crt');
  const serverCert = path.join(certDir, 'localhost.crt');
  const serverKey = path.join(certDir, 'localhost.key');

  console.log('🔍 Vérification des certificats SSL PieceMaker\n');
  console.log('='.repeat(60));

  // 1. Vérifier la présence des fichiers
  console.log('\n📁 Présence des fichiers:');
  const files = [
    { path: caCert, name: 'Certificat CA' },
    { path: serverCert, name: 'Certificat serveur' },
    { path: serverKey, name: 'Clé privée serveur' }
  ];

  let allFilesExist = true;
  for (const file of files) {
    const exists = fs.existsSync(file.path);
    console.log(`   ${exists ? '✅' : '❌'} ${file.name}: ${path.basename(file.path)}`);
    if (!exists) allFilesExist = false;
  }

  if (!allFilesExist) {
    console.log('\n❌ Certains fichiers sont manquants.');
    console.log('   Exécutez depuis la racine du dépôt: node websocket-server/generate-ca-certificates.cjs');
    return;
  }

  console.log('\n' + '='.repeat(60));

  // 2. Vérifier la signature du certificat serveur
  console.log('\n🔐 Vérification de la signature du certificat serveur:\n');
  try {
    const { stdout } = await execPromise(`openssl verify -CAfile "${caCert}" "${serverCert}"`);
    console.log(`   ${stdout.trim()}`);
    if (stdout.includes('OK')) {
      console.log('   ✅ Le certificat serveur est correctement signé par le CA');
    }
  } catch (error) {
    console.log('   ❌ Erreur de vérification:', error.message);
    return;
  }

  console.log('\n' + '='.repeat(60));

  // 3. Afficher les détails du certificat CA
  console.log('\n📋 Détails du Certificat CA (piecemaker-ca.crt):\n');
  try {
    // Subject
    const { stdout: caSubject } = await execPromise(`openssl x509 -in "${caCert}" -noout -subject`);
    console.log(`   Subject: ${caSubject.trim().replace('subject=', '')}`);

    // Issuer
    const { stdout: caIssuer } = await execPromise(`openssl x509 -in "${caCert}" -noout -issuer`);
    console.log(`   Issuer: ${caIssuer.trim().replace('issuer=', '')}`);

    // Dates
    const { stdout: caStartDate } = await execPromise(`openssl x509 -in "${caCert}" -noout -startdate`);
    const { stdout: caEndDate } = await execPromise(`openssl x509 -in "${caCert}" -noout -enddate`);
    console.log(`   Valide du: ${caStartDate.trim().replace('notBefore=', '')}`);
    console.log(`   Valide jusqu'au: ${caEndDate.trim().replace('notAfter=', '')}`);

    // Empreinte SHA1
    const { stdout: caFingerprint } = await execPromise(`openssl x509 -in "${caCert}" -noout -fingerprint -sha1`);
    console.log(`   ${caFingerprint.trim()}`);

    // Algorithme de signature
    const { stdout: caSigAlg } = await execPromise(`openssl x509 -in "${caCert}" -noout -text | grep "Signature Algorithm" | head -1`);
    console.log(`   Signature Algorithm: ${caSigAlg.trim().split(':')[1]?.trim() || 'N/A'}`);

    // Extensions
    console.log('\n   Extensions du CA:');
    const { stdout: caText } = await execPromise(`openssl x509 -in "${caCert}" -noout -text`);

    if (caText.includes('CA:TRUE')) {
      console.log('   ✅ Basic Constraints: CA=TRUE');
    }
    if (caText.includes('Certificate Sign')) {
      console.log('   ✅ Key Usage: Certificate Signing');
    }
    if (caText.includes('CRL Sign')) {
      console.log('   ✅ Key Usage: CRL Signing');
    }

    // Taille de clé
    const { stdout: caKeySize } = await execPromise(`openssl x509 -in "${caCert}" -noout -text | grep "Public-Key:" | head -1`);
    console.log(`   ${caKeySize.trim()}`);

  } catch (error) {
    console.log('   ⚠️ Erreur lecture certificat CA:', error.message);
  }

  console.log('\n' + '='.repeat(60));

  // 4. Afficher les détails du certificat serveur
  console.log('\n📋 Détails du Certificat Serveur (localhost.crt):\n');
  try {
    // Subject
    const { stdout: serverSubject } = await execPromise(`openssl x509 -in "${serverCert}" -noout -subject`);
    console.log(`   Subject: ${serverSubject.trim().replace('subject=', '')}`);

    // Issuer (devrait être le CA)
    const { stdout: serverIssuer } = await execPromise(`openssl x509 -in "${serverCert}" -noout -issuer`);
    console.log(`   Issuer: ${serverIssuer.trim().replace('issuer=', '')}`);

    if (serverIssuer.includes('PieceMaker Root CA')) {
      console.log('   ✅ Signé par: PieceMaker Root CA');
    }

    // Dates
    const { stdout: serverStartDate } = await execPromise(`openssl x509 -in "${serverCert}" -noout -startdate`);
    const { stdout: serverEndDate } = await execPromise(`openssl x509 -in "${serverCert}" -noout -enddate`);
    console.log(`   Valide du: ${serverStartDate.trim().replace('notBefore=', '')}`);
    console.log(`   Valide jusqu'au: ${serverEndDate.trim().replace('notAfter=', '')}`);

    // Subject Alternative Names
    console.log('\n   Subject Alternative Names (SANs):');
    const { stdout: serverText } = await execPromise(`openssl x509 -in "${serverCert}" -noout -text`);
    const sanMatch = serverText.match(/DNS:([^,\s]+)|IP Address:([^,\s]+)/g);
    if (sanMatch) {
      sanMatch.forEach(san => {
        console.log(`   ✅ ${san}`);
      });
    }

    // Extensions
    if (serverText.includes('CA:FALSE')) {
      console.log('\n   ✅ Basic Constraints: CA=FALSE (certificat serveur)');
    }
    if (serverText.includes('TLS Web Server Authentication')) {
      console.log('   ✅ Extended Key Usage: Server Authentication');
    }
    if (serverText.includes('TLS Web Client Authentication')) {
      console.log('   ✅ Extended Key Usage: Client Authentication');
    }

  } catch (error) {
    console.log('   ⚠️ Erreur lecture certificat serveur:', error.message);
  }

  console.log('\n' + '='.repeat(60));

  // 5. Résumé
  console.log('\n✅ RÉSUMÉ:\n');
  console.log('   1. Le certificat CA (piecemaker-ca.crt) est un certificat racine auto-signé');
  console.log('   2. Le certificat serveur (localhost.crt) est signé par le CA PieceMaker');
  console.log('   3. Le serveur https://localhost:43098 utilisera localhost.crt');
  console.log('   4. Les clients verront localhost.crt signé par PieceMaker Root CA');
  console.log('   5. Si le CA est installé dans les certificats racine, la connexion sera approuvée');
  console.log('');
  console.log('📋 Chaîne de confiance:');
  console.log('   [Certificats Racine Système] → PieceMaker Root CA → localhost.crt → https://localhost:43098');
  console.log('');
  console.log('🔐 Pour installer le CA dans les certificats racine:');
  console.log('   Windows: certutil -addstore -user Root "piecemaker-ca.crt"');
  console.log('   macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "piecemaker-ca.crt"');
  console.log('');
  console.log('='.repeat(60));
}

// Exécuter la vérification
verifyCertificates().catch(error => {
  console.error('❌ Erreur:', error.message);
  process.exit(1);
});

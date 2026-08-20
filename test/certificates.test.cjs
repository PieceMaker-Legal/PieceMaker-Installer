const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('le serveur et le vérificateur utilisent les certificats générés dans websocket-server', () => {
  const server = read('websocket-server/server.cjs');
  const verifier = read('websocket-server/verify-certificates.cjs');
  const installer = read('installer/steps/05-certificats.mjs');
  const generator = read('websocket-server/generate-ca-certificates.cjs');

  assert.match(server, /const caCertPath = path\.join\(__dirname, 'piecemaker-ca\.crt'\)/);
  assert.match(verifier, /const certDir = __dirname/);
  assert.match(verifier, /path\.join\(certDir, 'piecemaker-ca\.crt'\)/);
  assert.match(installer, /const CERT_DIR = path\.join\(REPO_ROOT, 'websocket-server'\)/);
  assert.match(installer, /generate-ca-certificates\.cjs/);
  assert.match(generator, /path\.join\(outputDir, 'piecemaker-ca\.crt'\)/);

  for (const source of [server, verifier]) {
    assert.match(source, /generate-ca-certificates\.cjs/);
    assert.doesNotMatch(source, /generate-ca-certificates\.js/);
    assert.doesNotMatch(source, /Approuver les certificats SSL/);
  }
});

test('le serveur présente la chaîne TLS lorsque la CA locale est disponible', () => {
  const server = read('websocket-server/server.cjs');

  assert.match(server, /options\.cert = serverCert \+ '\\n' \+ caCert/);
  assert.match(server, /seul le certificat serveur sera présenté/);
  assert.match(server, /Le CA doit être installé dans les autorités racines de confiance/);
});

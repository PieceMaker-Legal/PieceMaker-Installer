/**
 * Produit un manifeste de production : le manifeste de développement avec
 * l'origine locale (https://localhost:43098) réécrite vers l'origine HTTPS
 * publique où le volet est déployé.
 *
 * Le manifeste versionné (taskpane/manifest.xml) reste TOUJOURS configuré pour
 * localhost — c'est lui que Word charge en développement et c'est lui que
 * `websocket-server/lib/docx-autoopen.cjs` référence par son <Id>. On n'écrit
 * jamais dedans : la sortie va dans taskpane/dist/.
 *
 *   PIECEMAKER_ADDIN_PUBLIC_URL=https://volet.example.com \
 *     npm run build --prefix taskpane
 */
const fs = require("fs");
const path = require("path");

// Doit rester synchronisé avec l'origine écrite dans taskpane/manifest.xml
// (port par défaut du serveur PieceMaker, cf. websocket-server/server.cjs).
const LOCAL_ORIGIN = process.env.PIECEMAKER_LOCAL_ORIGIN || "https://localhost:43098";

const publicUrlInput = (process.env.PIECEMAKER_ADDIN_PUBLIC_URL || "").trim();
let parsedPublicUrl;
try {
  parsedPublicUrl = new URL(publicUrlInput);
} catch {
  throw new Error(
    "PIECEMAKER_ADDIN_PUBLIC_URL doit être l'origine HTTPS de déploiement du volet Word"
  );
}
if (
  parsedPublicUrl.protocol !== "https:" ||
  parsedPublicUrl.username ||
  parsedPublicUrl.password ||
  parsedPublicUrl.search ||
  parsedPublicUrl.hash ||
  parsedPublicUrl.pathname !== "/"
) {
  throw new Error(
    "PIECEMAKER_ADDIN_PUBLIC_URL doit être une origine HTTPS sans identifiants, chemin, requête ni fragment"
  );
}
const publicUrl = parsedPublicUrl.origin;

const sourcePath = path.resolve(__dirname, "../manifest.xml");
const distPath = path.resolve(__dirname, "../dist");
const outputPath = path.join(distPath, "manifest.xml");

fs.mkdirSync(distPath, { recursive: true });

const manifest = fs.readFileSync(sourcePath, "utf8").replaceAll(LOCAL_ORIGIN, publicUrl);

if (manifest.includes(LOCAL_ORIGIN)) {
  throw new Error("Le manifeste de production contient encore des URLs localhost");
}

fs.writeFileSync(outputPath, manifest);

// Icônes du ruban : le manifeste les sert depuis la même origine, elles doivent
// donc accompagner le manifeste déployé.
const assetOutputPath = path.join(distPath, "assets");
fs.mkdirSync(assetOutputPath, { recursive: true });
for (const filename of ["icon-16.png", "icon-32.png", "icon-64.png", "icon-80.png"]) {
  fs.copyFileSync(
    path.resolve(__dirname, "../assets", filename),
    path.join(assetOutputPath, filename)
  );
}

console.log(`Manifeste de production et icônes du ruban écrits pour ${publicUrl}`);

/**
 * Best-effort `office-addin-debugging stop` before every `npm start` /
 * `npm run dev` (branché via les hooks "prestart" et "predev").
 *
 * Pourquoi : office-addin-debugging enregistre l'add-in en créant un lien dur
 * de manifest.xml dans le dossier de sideload de Word (macOS) ou une valeur
 * sous HKCU\SOFTWARE\Microsoft\Office\16.0\Wef\Developer (Windows). Si une
 * session précédente s'est terminée sans `npm run stop` (plantage, Ctrl-C,
 * terminal tué), le lien reste en place et le lancement suivant meurt sur une
 * erreur opaque :
 *   "EEXIST: file already exists, link 'manifest.xml' -> …/wef/….manifest.xml".
 * Faire un stop d'abord rend les deux commandes de lancement idempotentes.
 *
 * Les échecs sont volontairement avalés : sur une machine propre il n'y a rien
 * à arrêter, et un stop cassé ne doit jamais bloquer le start (le start
 * remontera sa propre erreur, plus actionnable).
 */
const { spawnSync } = require("child_process");

spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "office-addin-debugging", "stop", "manifest.xml"],
  { stdio: "ignore", cwd: __dirname + "/.." }
);
process.exit(0);

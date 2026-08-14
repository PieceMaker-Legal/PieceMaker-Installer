/**
 * Enregistrement des skills et agents PieceMaker auprès de Claude Code.
 *
 * Le plugin `piecemaker` est installé depuis un marketplace : Claude Code en
 * garde une copie figée sous ~/.claude/plugins/cache/…, rafraîchie uniquement
 * par `claude plugin update`. Un skill ou un agent créé depuis
 * l'administration n'apparaîtrait donc dans la liste de Claude Code qu'après
 * publication du dépôt.
 *
 * On complète donc l'installation du plugin par les deux emplacements que
 * Claude Code découvre automatiquement au démarrage d'une session :
 *   ~/.claude/agents/<slug>.md          (agents utilisateur)
 *   ~/.claude/skills/<slug>/SKILL.md    (skills utilisateur)
 *
 * Le lien est symbolique afin que toute modification ultérieure du Markdown
 * dans le dépôt soit immédiatement reflétée. Sur les systèmes qui refusent
 * les liens symboliques (Windows sans droits développeur) on retombe sur une
 * copie, re-synchronisée à chaque enregistrement.
 *
 * Règle de sûreté : on n'écrase jamais un agent ou un skill utilisateur
 * préexistant — le conflit est signalé, pas résolu en silence. Un
 * enregistrement qui provient de PieceMaker, lui, est repris sans question,
 * même s'il vient d'un autre clone du dépôt (dev + installation d'exécution
 * sur la même machine) : sans cela les six skills et agents restaient
 * bloqués en « conflit » avec eux-mêmes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIRECTORY = 'piecemaker-plugin';

/**
 * Reconnaît un chemin appartenant à un clone *quelconque* du dépôt. Un poste
 * a couramment le dépôt de développement et l'installation d'exécution côte à
 * côte : le lien déposé dans ~/.claude par l'un ne doit pas être pris pour un
 * fichier personnel par l'autre (voir l'état `stale` de claudeAssetStatus).
 */
const PLUGIN_ASSET_PATH = /(^|[\\/])piecemaker-plugin[\\/](agents|skills)[\\/][^\\/]+/;

function pluginRoot(repoRoot) {
  return path.join(repoRoot, PLUGIN_DIRECTORY);
}

function claudeDirectory(userHome, kind) {
  return path.join(userHome, '.claude', kind === 'skill' ? 'skills' : 'agents');
}

/**
 * Décrit un asset administrable : chemin relatif dépôt -> source à lier et
 * cible attendue dans ~/.claude. Renvoie null pour tout autre fichier
 * (CLAUDE.md, rapports de facturation…), qui n'est pas un composant Claude.
 */
function claudeAssetOf(repoRoot, userHome, relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
  const agent = normalized.match(/^piecemaker-plugin\/agents\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
  if (agent) {
    return {
      kind: 'agent',
      slug: agent[1],
      source: path.join(pluginRoot(repoRoot), 'agents', `${agent[1]}.md`),
      target: path.join(claudeDirectory(userHome, 'agent'), `${agent[1]}.md`),
      type: 'file',
    };
  }
  const skill = normalized.match(/^piecemaker-plugin\/skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/);
  if (skill) {
    return {
      kind: 'skill',
      slug: skill[1],
      source: path.join(pluginRoot(repoRoot), 'skills', skill[1]),
      target: path.join(claudeDirectory(userHome, 'skill'), skill[1]),
      type: 'dir',
    };
  }
  return null;
}

function linkTarget(entry) {
  try {
    if (!fs.lstatSync(entry).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return path.resolve(path.dirname(entry), fs.readlinkSync(entry));
}

function samePath(a, b) {
  const resolve = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return resolve(a) === resolve(b);
}

function copyTree(source, target, type) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (type === 'dir') {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true, dereference: true });
  } else {
    fs.copyFileSync(source, target);
  }
}

/**
 * Repli sans lien symbolique : une copie déposée dans ~/.claude est
 * indiscernable d'un fichier écrit à la main. On note donc ce qu'on a copié,
 * seul moyen de rafraîchir plus tard une copie devenue obsolète sans risquer
 * d'écraser le travail de l'utilisateur.
 */
function receiptFile(userHome) {
  return path.join(userHome, '.claude', '.piecemaker-assets.json');
}

function readReceipt(userHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(receiptFile(userHome), 'utf8'));
    return parsed && typeof parsed.copies === 'object' && parsed.copies ? parsed.copies : {};
  } catch {
    return {};
  }
}

function rememberCopy(userHome, asset) {
  const copies = readReceipt(userHome);
  copies[`${asset.kind}:${asset.slug}`] = asset.source;
  try {
    fs.writeFileSync(receiptFile(userHome), `${JSON.stringify({ version: 1, copies }, null, 2)}\n`);
  } catch {
    // Le reçu est un confort, pas une dépendance : sans lui une copie
    // obsolète retombe simplement sur un conflit signalé.
  }
}

function ownedCopy(userHome, asset) {
  return Object.hasOwn(readReceipt(userHome), `${asset.kind}:${asset.slug}`);
}

/**
 * État de l'enregistrement, sans rien modifier — utilisé par la liste des
 * fichiers de l'administration.
 *   linked   : lien symbolique vers le dépôt (mise à jour immédiate)
 *   copied   : copie synchronisée (repli sans lien symbolique)
 *   stale    : enregistrement PieceMaker périmé (autre clone du dépôt, ou
 *              copie obsolète que nous avions déposée) — repris sans question
 *   conflict : un fichier utilisateur homonyme existe déjà, non touché
 *   missing  : pas encore enregistré
 */
function claudeAssetStatus(repoRoot, userHome, relativePath) {
  const asset = claudeAssetOf(repoRoot, userHome, relativePath);
  if (!asset) return null;
  const base = { kind: asset.kind, slug: asset.slug, target: asset.target };
  if (!fs.existsSync(asset.source)) return { ...base, state: 'missing' };
  const link = linkTarget(asset.target);
  if (link) {
    if (samePath(link, asset.source)) return { ...base, state: 'linked' };
    // Un lien vers un autre clone du dépôt reste un enregistrement
    // PieceMaker : on le reprend, on ne le déclare pas en conflit.
    return PLUGIN_ASSET_PATH.test(link)
      ? { ...base, state: 'stale', origin: link }
      : { ...base, state: 'conflict' };
  }
  if (!fs.existsSync(asset.target)) return { ...base, state: 'missing' };
  const sourceFile = asset.type === 'dir' ? path.join(asset.source, 'SKILL.md') : asset.source;
  const targetFile = asset.type === 'dir' ? path.join(asset.target, 'SKILL.md') : asset.target;
  if (fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8') === fs.readFileSync(sourceFile, 'utf8')) {
    return { ...base, state: 'copied' };
  }
  return ownedCopy(userHome, asset) ? { ...base, state: 'stale' } : { ...base, state: 'conflict' };
}

/**
 * Rend le skill / l'agent visible par Claude Code. Idempotent : rappelé à
 * chaque enregistrement pour maintenir une éventuelle copie à jour.
 */
function registerClaudeAsset(repoRoot, userHome, relativePath) {
  const asset = claudeAssetOf(repoRoot, userHome, relativePath);
  if (!asset) return null;
  if (!fs.existsSync(asset.source)) {
    return { kind: asset.kind, slug: asset.slug, target: asset.target, state: 'missing' };
  }

  const current = claudeAssetStatus(repoRoot, userHome, relativePath);
  if (current.state === 'linked') return current;
  if (current.state === 'conflict') {
    return {
      ...current,
      note: `Un ${asset.kind === 'skill' ? 'skill' : 'agent'} personnel « ${asset.slug} » existe déjà dans ~/.claude — renommez-le ou supprimez-le pour que celui de PieceMaker soit pris en compte.`,
    };
  }

  const base = { kind: asset.kind, slug: asset.slug, target: asset.target };
  const adopted = current.state === 'stale'
    ? {
      adopted: true,
      note: current.origin
        ? `Enregistrement repris d'un autre clone PieceMaker (${current.origin}).`
        : "Copie PieceMaker obsolète remplacée par la version de ce dépôt.",
    }
    : {};
  fs.mkdirSync(path.dirname(asset.target), { recursive: true });

  // Une copie réelle déjà en place signale une machine sans liens
  // symboliques : on la rafraîchit au lieu de retenter un lien à chaque fois.
  if (!linkTarget(asset.target) && fs.existsSync(asset.target)) {
    copyTree(asset.source, asset.target, asset.type);
    rememberCopy(userHome, asset);
    return { ...base, state: 'copied', ...adopted };
  }

  // Lien laissé par un autre clone : on le retire. Jamais un fichier réel —
  // celui-ci est sorti plus haut en `conflict`.
  if (linkTarget(asset.target)) fs.unlinkSync(asset.target);
  try {
    fs.symlinkSync(asset.source, asset.target, asset.type === 'dir' ? 'dir' : 'file');
    return { ...base, state: 'linked', ...adopted };
  } catch {
    copyTree(asset.source, asset.target, asset.type);
    rememberCopy(userHome, asset);
    return {
      ...base,
      ...adopted,
      state: 'copied',
      note: 'Liens symboliques indisponibles : une copie a été déposée, elle est mise à jour à chaque enregistrement.',
    };
  }
}

/**
 * Inverse de `registerClaudeAsset` : retire le lien/copie que PieceMaker a
 * déposé pour un skill ou un agent, pour honorer un décochage explicite dans
 * le pop-up « Ajouter le plugin legal Claude » (onglet Skills et agents). Ne
 * touche jamais un fichier personnel — seul un état reconnu comme nôtre par
 * `claudeAssetStatus` (`linked`, `copied`, `stale`) est retiré ; `conflict`
 * (fichier personnel homonyme) et `missing` (déjà absent) sont laissés tels
 * quels. Idempotent : rappelable sans effet sur un composant déjà retiré.
 */
function unregisterClaudeAsset(repoRoot, userHome, relativePath) {
  const asset = claudeAssetOf(repoRoot, userHome, relativePath);
  if (!asset) return null;
  const current = claudeAssetStatus(repoRoot, userHome, relativePath);
  const base = { kind: asset.kind, slug: asset.slug, target: asset.target };
  if (current.state === 'missing' || current.state === 'conflict') return { ...base, state: current.state };

  try {
    if (linkTarget(asset.target) || fs.existsSync(asset.target)) {
      fs.rmSync(asset.target, { recursive: true, force: true });
    }
  } catch {
    return { ...base, state: current.state, note: 'Le retrait a échoué — vérifiez les permissions sur ~/.claude.' };
  }

  const copies = readReceipt(userHome);
  const key = `${asset.kind}:${asset.slug}`;
  if (Object.hasOwn(copies, key)) {
    delete copies[key];
    try {
      fs.writeFileSync(receiptFile(userHome), `${JSON.stringify({ version: 1, copies }, null, 2)}\n`);
    } catch {
      // Le reçu est un confort, pas une dépendance.
    }
  }
  return { ...base, state: 'missing', removed: true };
}

/** Liste les assets du dépôt, indépendamment de leur enregistrement. */
function repositoryAssets(repoRoot) {
  const paths = [];
  const agents = path.join(pluginRoot(repoRoot), 'agents');
  if (fs.existsSync(agents)) {
    for (const name of fs.readdirSync(agents).filter((entry) => entry.endsWith('.md')).sort()) {
      paths.push(`${PLUGIN_DIRECTORY}/agents/${name}`);
    }
  }
  const skills = path.join(pluginRoot(repoRoot), 'skills');
  if (fs.existsSync(skills)) {
    for (const name of fs.readdirSync(skills).sort()) {
      if (fs.existsSync(path.join(skills, name, 'SKILL.md'))) {
        paths.push(`${PLUGIN_DIRECTORY}/skills/${name}/SKILL.md`);
      }
    }
  }
  return paths;
}

/**
 * Retire les liens devenus orphelins : uniquement des liens symboliques
 * pointant vers un clone du dépôt dont la cible a disparu (skill/agent
 * supprimé, ou clone effacé). Jamais un fichier réel de l'utilisateur.
 */
function pruneClaudeAssets(repoRoot, userHome) {
  const removed = [];
  for (const kind of ['agent', 'skill']) {
    const directory = claudeDirectory(userHome, kind);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name);
      const link = linkTarget(entry);
      if (!link) continue;
      const inside = link === pluginRoot(repoRoot) || link.startsWith(`${pluginRoot(repoRoot)}${path.sep}`);
      if ((inside || PLUGIN_ASSET_PATH.test(link)) && !fs.existsSync(link)) {
        fs.unlinkSync(entry);
        removed.push(entry);
      }
    }
  }
  return removed;
}

/**
 * Réconcilie l'ensemble des skills et agents du dépôt avec ~/.claude.
 * Appelé au démarrage du serveur et depuis l'administration.
 */
function syncClaudeAssets(repoRoot, userHome = os.homedir()) {
  const pruned = pruneClaudeAssets(repoRoot, userHome);
  const assets = repositoryAssets(repoRoot).map((relativePath) => ({
    path: relativePath,
    ...registerClaudeAsset(repoRoot, userHome, relativePath),
  }));
  return {
    assets,
    pruned,
    registered: assets.filter((asset) => asset.state === 'linked' || asset.state === 'copied').length,
    adopted: assets.filter((asset) => asset.adopted).length,
    conflicts: assets.filter((asset) => asset.state === 'conflict'),
  };
}

module.exports = {
  claudeAssetOf,
  claudeAssetStatus,
  pruneClaudeAssets,
  registerClaudeAsset,
  repositoryAssets,
  syncClaudeAssets,
  unregisterClaudeAsset,
};

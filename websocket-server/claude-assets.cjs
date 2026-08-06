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
 * préexistant qui ne provient pas du dépôt — le conflit est signalé, pas
 * résolu en silence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_DIRECTORY = 'piecemaker-plugin';

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
 * État de l'enregistrement, sans rien modifier — utilisé par la liste des
 * fichiers de l'administration.
 *   linked   : lien symbolique vers le dépôt (mise à jour immédiate)
 *   copied   : copie synchronisée (repli sans lien symbolique)
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
    return samePath(link, asset.source)
      ? { ...base, state: 'linked' }
      : { ...base, state: 'conflict' };
  }
  if (!fs.existsSync(asset.target)) return { ...base, state: 'missing' };
  const sourceFile = asset.type === 'dir' ? path.join(asset.source, 'SKILL.md') : asset.source;
  const targetFile = asset.type === 'dir' ? path.join(asset.target, 'SKILL.md') : asset.target;
  if (fs.existsSync(targetFile) && fs.readFileSync(targetFile, 'utf8') === fs.readFileSync(sourceFile, 'utf8')) {
    return { ...base, state: 'copied' };
  }
  return { ...base, state: 'conflict' };
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

  fs.mkdirSync(path.dirname(asset.target), { recursive: true });
  if (current.state === 'copied') {
    copyTree(asset.source, asset.target, asset.type);
    return { ...current, state: 'copied' };
  }
  try {
    fs.symlinkSync(asset.source, asset.target, asset.type === 'dir' ? 'dir' : 'file');
    return { kind: asset.kind, slug: asset.slug, target: asset.target, state: 'linked' };
  } catch {
    copyTree(asset.source, asset.target, asset.type);
    return {
      kind: asset.kind,
      slug: asset.slug,
      target: asset.target,
      state: 'copied',
      note: 'Liens symboliques indisponibles : une copie a été déposée, elle est mise à jour à chaque enregistrement.',
    };
  }
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
 * pointant vers ce dépôt dont la cible a disparu (skill/agent supprimé).
 * Jamais un fichier réel de l'utilisateur.
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
      if (inside && !fs.existsSync(link)) {
        fs.rmSync(entry, { force: true });
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
};

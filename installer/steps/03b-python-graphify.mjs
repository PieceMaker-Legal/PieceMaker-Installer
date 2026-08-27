/** Environnement virtuel Graphify, séparé de celui de GLiNER. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log, spinner } from '../lib/ui.mjs';
import { confirm } from '../lib/prompt.mjs';
import { run, runCapture, venvPaths, ensureDir } from '../lib/platform.mjs';
import { updateConfig } from '../lib/state.mjs';

export const meta = {
  id: '03b-python-graphify',
  label: 'Graphify (graphe juridique)',
  description: 'Crée un venv dédié et installe le fork Graphify PieceMaker-Legal',
};

// Le checkout local du fork contient encore des changements non publiés pour
// `entity_metadata`. Les refs locales v0.9.48 et le dépôt distant ne prouvent
// donc pas qu'un tag immuable embarque cette capacité. Ne jamais remplacer ce
// bloc par une branche ou un hash deviné.
const GRAPHIFY_RELEASE = Object.freeze({
  state: 'blocked',
  code: 'graphify_fork_tag_unresolved',
  repository: 'https://github.com/PieceMaker-Legal/graphify',
  tag: null,
  version: null,
  reason: 'Aucun tag immuable du fork ne prouve localement ou à distance la prise en charge de entity_metadata.',
});

export function graphifyReleaseState() { return { ...GRAPHIFY_RELEASE }; }

function releaseBlockedResult(suffix = '') {
  return {
    status: 'partial', code: GRAPHIFY_RELEASE.code, blocked: graphifyReleaseState(),
    note: `Graphify bloqué (${GRAPHIFY_RELEASE.code}) : ${GRAPHIFY_RELEASE.reason}${suffix}`,
  };
}

export function graphifyRequirement(release = GRAPHIFY_RELEASE) {
  return release?.tag ? `graphify-doc @ git+${release.repository}.git@${release.tag}` : null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function entityMetadataProbeFixture() {
  return {
    code: 'PARTIE_DEMANDEUR_01',
    mapping: {
      schema_version: 1,
      mapping: { PARTIE_DEMANDEUR_01: 'PARTIE_DEMANDEUR_01' },
      entity_metadata: {
        PARTIE_DEMANDEUR_01: {
          entity_type: 'personne', procedural_role: 'demandeur', side: 'client', is_key_party: true,
        },
      },
    },
  };
}

/** Vérifie la propagation exacte sans dépendre du format d'ID de Graphify. */
export function validateEntityMetadataProbeGraph(graph, expected = entityMetadataProbeFixture()) {
  if (!graph || !Array.isArray(graph.nodes)) return { ok: false, reason: 'sortie graph.json absente ou invalide' };
  const metadata = expected.mapping.entity_metadata[expected.code];
  const node = graph.nodes.find((entry) =>
    entry?.label === expected.code || entry?.canonical === expected.code || entry?.code === expected.code,
  );
  if (!node) return { ok: false, reason: `nœud canonique ${expected.code} absent` };
  for (const [field, value] of Object.entries(metadata)) {
    if (node[field] !== value) return { ok: false, reason: `propagation invalide de ${field} (attendu ${JSON.stringify(value)})` };
  }
  return { ok: true };
}

/**
 * Probe déterministe : corpus et mapping en codes, `--code-only`, aucune
 * variable de fournisseur LLM, puis vérification du graphe produit.
 */
export function probeGraphifyEntityMetadata(graphifyBin, {
  runCaptureFn = runCapture,
  temporaryDirectory = null,
} = {}) {
  const temporary = temporaryDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-probe-'));
  try {
    const fixture = entityMetadataProbeFixture();
    const corpus = path.join(temporary, 'corpus');
    const output = path.join(temporary, 'output');
    const entityMap = path.join(temporary, 'entity-map.json');
    fs.mkdirSync(corpus, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(corpus, 'piece.md'), `${fixture.code}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(entityMap, `${JSON.stringify(fixture.mapping)}\n`, { encoding: 'utf8', mode: 0o600 });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(OPENAI|ANTHROPIC|GOOGLE|AZURE|GRAPHIFY_(?:API|BACKEND|MODEL))/i.test(key)) delete env[key];
    }
    const result = runCaptureFn(graphifyBin, [
      'extract', corpus, '--code-only', '--no-cluster',
      '--entity-map', entityMap, '--entity-map-labels', 'canonical', '--out', output,
    ], { cwd: temporary, env });
    if (result?.code !== 0) {
      return { ok: false, reason: `extract --code-only a échoué (${result?.stderr || result?.stdout || `code ${result?.code}`})` };
    }
    return validateEntityMetadataProbeGraph(readJson(path.join(output, 'graphify-out', 'graph.json')), fixture);
  } finally {
    if (!temporaryDirectory) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function install(ctx) {
  const requirement = graphifyRequirement();
  if (!requirement) return releaseBlockedResult(' L’installation n’est pas tentée tant que ce tag n’est pas publié et vérifié.');
  if (!ctx.python) return { status: 'failed', note: 'Python >= 3.10 introuvable — exécutez d’abord l’étape des prérequis.' };
  const venvDir = ctx.config.graphifyVenvPath;
  const vp = venvPaths(venvDir);
  if (ctx.dryRun) {
    log.info(`[simulation] Création du venv dans ${venvDir}`);
    log.info(`[simulation] pip install "${requirement}"`);
    return { status: 'skipped', note: 'Mode simulation — aucune installation effectuée.' };
  }
  if (!await confirm(`Installer Graphify (fork PieceMaker-Legal, tag ${GRAPHIFY_RELEASE.tag}) depuis GitHub dans un venv dédié ?`, true)) {
    return { status: 'partial', note: 'Graphify non installé — relancez l’étape « 03b-python-graphify » quand vous serez prêt.' };
  }
  if (!vp.exists) {
    ensureDir(path.dirname(venvDir));
    const spin = spinner(`Création de l’environnement virtuel Graphify (${ctx.python.command})…`);
    const code = await run(ctx.python.command, ['-m', 'venv', venvDir]);
    if (code !== 0) { spin.fail('Échec de la création du venv Graphify'); return { status: 'failed', note: `python -m venv a échoué (code ${code}).` }; }
    spin.succeed(`Environnement virtuel Graphify créé : ${venvDir}`);
  }
  const pipSpin = spinner('Mise à jour de pip…');
  if (await run(vp.python, ['-m', 'pip', 'install', '-U', 'pip']) !== 0) {
    pipSpin.fail('Échec de la mise à jour de pip'); return { status: 'failed', note: 'pip install -U pip a échoué.' };
  }
  pipSpin.succeed('pip à jour');
  const installSpin = spinner(`Installation de Graphify (tag ${GRAPHIFY_RELEASE.tag})…`);
  if (await run(vp.python, ['-m', 'pip', 'install', '--upgrade', requirement]) !== 0) {
    installSpin.fail('Échec de l’installation de Graphify'); return { status: 'failed', note: `pip install a échoué. Vérifiez le tag ${GRAPHIFY_RELEASE.tag}.` };
  }
  installSpin.succeed('Graphify installé');
  const graphifyBin = path.join(vp.binDir, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  if (!fs.existsSync(graphifyBin)) return { status: 'failed', note: `Le binaire graphify est introuvable dans ${vp.binDir} après installation.` };
  updateConfig({ graphifyVenvPath: venvDir, graphifyPath: graphifyBin });
  return { status: 'done', note: '' };
}

export async function check(ctx) {
  const vp = venvPaths(ctx.config.graphifyVenvPath);
  const graphifyBin = path.join(vp.binDir, process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  if (!vp.exists || !fs.existsSync(graphifyBin)) {
    return releaseBlockedResult(' Le probe entity_metadata est impossible car le venv Graphify n’est pas installé.');
  }
  const versionResult = runCapture(graphifyBin, ['--version']);
  if (versionResult.code !== 0) return { status: 'failed', note: 'graphify --version a échoué — venv corrompu, relancez cette étape.' };
  const probe = probeGraphifyEntityMetadata(graphifyBin);
  if (!probe.ok) return { ...releaseBlockedResult(` Probe entity_metadata en échec : ${probe.reason}.`), probe };
  if (!GRAPHIFY_RELEASE.tag) {
    const version = `${versionResult.stdout} ${versionResult.stderr}`.trim() || 'la version installée';
    return { ...releaseBlockedResult(` Probe entity_metadata réussi avec ${version}.`), probe };
  }
  return { status: 'done', note: `Graphify ${GRAPHIFY_RELEASE.version}, propagation entity_metadata vérifiée sans LLM.`, probe };
}

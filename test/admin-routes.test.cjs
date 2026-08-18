const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  applyMarketplaceSelection,
  applyPluginComponentSelection,
  checkOllamaModelUpdate,
  createManagedFile,
  deleteManagedAsset,
  deleteManagedFile,
  ensureClaudePluginActive,
  installedPluginSkills,
  isLocalOrigin,
  listDossiers,
  listManagedFiles,
  listMarketplaceConnectors,
  listPluginComponents,
  listRegisteredMarketplaces,
  listSkillAssets,
  managedFileKind,
  normalizeAgentModel,
  normalizeAgentTools,
  readManagedFile,
  registerOfficialMarketplace,
  renameManagedFile,
  revealCommands,
  saveManagedAsset,
  saveManagedFile,
  updateEnvFile,
} = require('../websocket-server/admin-routes.cjs');

test('la vérification Ollama compare le digest local au manifeste distant sans télécharger le modèle', async () => {
  const manifest = Buffer.from('{"schemaVersion":2,"layers":[]}');
  const digest = crypto.createHash('sha256').update(manifest).digest('hex');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/version')) return new Response(JSON.stringify({ version: '1.2.3' }));
    if (url.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: [{ name: 'modele-test:latest', digest, size: 42 }] }));
    }
    if (url.includes('/manifests/')) return new Response(manifest);
    return new Response('', { status: 404 });
  };

  const result = await checkOllamaModelUpdate('modele-test:latest', fetchImpl);
  assert.equal(result.status, 'current');
  assert.equal(calls.filter((url) => url.includes('/manifests/')).length, 1);
  assert.ok(!calls.some((url) => url.includes('/api/pull')), 'aucun téléchargement ni pull ne doit être lancé');
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-admin-test-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'piecemaker-plugin', 'skills', 'redaction'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n');
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'agents', 'analyse.md'), '# Analyse\n');
  fs.writeFileSync(path.join(repo, 'piecemaker-plugin', 'skills', 'redaction', 'SKILL.md'), '# Skill\n');
  return { root, repo, home };
}

test('seuls les fichiers Markdown PieceMaker explicitement prévus sont acceptés', () => {
  assert.equal(managedFileKind('AGENTS.md'), 'instructions');
  assert.equal(managedFileKind('piecemaker-plugin/agents/analyse.md'), 'agent');
  assert.equal(managedFileKind('piecemaker-plugin/skills/redaction/SKILL.md'), 'skill');
  assert.equal(managedFileKind('../secret.md'), null);
  assert.equal(managedFileKind('piecemaker-plugin/agents/nested/secret.md'), null);
});

test('la liste contient les instructions, skills et agents', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const files = listManagedFiles(data.repo, data.home, undefined, { installedSkills: [] });
  assert.deepEqual(files.map((file) => file.path), [
    'AGENTS.md',
    'CLAUDE.md',
    'piecemaker-plugin/agents/analyse.md',
    'piecemaker-plugin/skills/redaction/SKILL.md',
  ]);
  assert.equal(files[0].exists, false);
});

test('la facturation reste hors de la liste des skills et agents', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const billingDir = path.join(data.home, 'billing', 'synthese');
  fs.mkdirSync(billingDir, { recursive: true });
  fs.writeFileSync(path.join(billingDir, 'session-2026.md'), '# Facturation\n');
  fs.writeFileSync(path.join(data.home, 'billing', '2026-08.jsonl'), `${JSON.stringify({
    timestamp: '2026-08-06T08:00:00.000Z', event: 'Stop', task_label: 'Analyse', dossier: 'Martin', duration_ms: 65000,
  })}\n`);
  const files = listManagedFiles(data.repo, data.home, undefined, { installedSkills: [] });
  assert.deepEqual(files.filter((file) => file.kind === 'billing'), []);
  assert.deepEqual([...new Set(files.map((file) => file.kind))], ['instructions', 'agent', 'skill']);
  // La hiérarchie ~/.piecemaker/billing reste lisible en direct, toujours en
  // lecture seule — elle n'est simplement plus proposée dans l'éditeur.
  const preview = readManagedFile(data.repo, 'billing/2026-08.jsonl', data.home);
  assert.equal(preview.readonly, true);
  assert.equal(preview.sourceType, 'billing-ledger');
  assert.match(preview.content, /# Suivi de facturation — 2026-08/);
  assert.match(preview.content, /\| Analyse \| Martin \| 1 min 5 s \|/);
  assert.throws(
    () => saveManagedFile(data.repo, data.home, 'billing/synthese/session-2026.md', 'altéré'),
    /lecture seule/,
  );
});

// ---------------------------------------------------------------------------
// Skills des plugins de marketplace installés (groupe « Skills officiels »).
// On simule un cache de plugin Claude Code sur disque + la sortie de
// `claude plugin list --json` via un faux runCommand.
// ---------------------------------------------------------------------------
function pluginCacheFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-plugincache-'));
  const install = (pluginId, version, skills) => {
    const [name, marketplace] = pluginId.split('@');
    const installPath = path.join(root, marketplace, name, version);
    for (const [slug, front] of Object.entries(skills)) {
      const dir = path.join(installPath, 'skills', slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${front.name}\ndescription: ${front.description}\n---\n# ${front.name}\n`);
    }
    return installPath;
  };
  return { root, install };
}

test('installedPluginSkills lit les skills des plugins installés et activés, hors piecemaker et désactivés', (t) => {
  const cache = pluginCacheFixture();
  t.after(() => fs.rmSync(cache.root, { recursive: true, force: true }));
  const legalPath = cache.install('litigation-legal@claude-for-legal', '1.0.2', {
    'claim-chart': { name: 'claim-chart', description: 'Construit un tableau de prétentions.' },
    'chronology': { name: 'chronology', description: 'Chronologie du dossier.' },
  });
  const disabledPath = cache.install('document-skills@anthropic-agent-skills', 'abc', {
    'pdf': { name: 'pdf', description: 'PDF.' },
  });
  const ownPath = cache.install('piecemaker@piecemaker', '0.2.2', {
    'anonymisation': { name: 'anonymisation', description: 'Ne doit pas apparaître (skill du dépôt).' },
  });
  const runCommand = () => ({ ok: true, output: JSON.stringify([
    { id: 'litigation-legal@claude-for-legal', enabled: true, installPath: legalPath },
    { id: 'document-skills@anthropic-agent-skills', enabled: false, installPath: disabledPath },
    { id: 'piecemaker@piecemaker', enabled: true, installPath: ownPath },
  ]) });

  const skills = installedPluginSkills(runCommand);
  // Triés par nom : « chronology » précède « claim-chart ».
  assert.deepEqual(skills.map((s) => s.path), [
    'official-skill:litigation-legal@claude-for-legal/chronology',
    'official-skill:litigation-legal@claude-for-legal/claim-chart',
  ]);
  const claimChart = skills.find((s) => s.slug === 'claim-chart');
  assert.equal(claimChart.name, 'claim-chart');
  assert.equal(claimChart.description, 'Construit un tableau de prétentions.');
  assert.equal(claimChart.plugin, 'litigation-legal');
  assert.equal(claimChart.marketplace, 'claude-for-legal');
  // Ni le plugin désactivé, ni notre propre plugin ne contribuent.
  assert.ok(!skills.some((s) => s.marketplace === 'anthropic-agent-skills'));
  assert.ok(!skills.some((s) => s.plugin === 'piecemaker'));
});

test('installedPluginSkills reste silencieux si le CLI échoue ou renvoie autre chose', () => {
  assert.deepEqual(installedPluginSkills(() => ({ ok: false, output: '' })), []);
  assert.deepEqual(installedPluginSkills(() => ({ ok: true, output: 'pas du json' })), []);
});

test('listManagedFiles ajoute les skills officiels en lecture seule après ceux du dépôt', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const installedSkills = [{
    path: 'official-skill:litigation-legal@claude-for-legal/claim-chart',
    plugin: 'litigation-legal',
    marketplace: 'claude-for-legal',
    name: 'claim-chart',
    description: 'Construit un tableau de prétentions.',
  }];
  const files = listManagedFiles(data.repo, data.home, undefined, { installedSkills });
  const official = files.find((file) => file.kind === 'official-skill');
  assert.ok(official, 'un skill officiel doit être présent');
  assert.equal(official.readonly, true);
  assert.equal(official.exists, true);
  assert.equal(official.name, 'claim-chart');
  assert.equal(official.plugin, 'litigation-legal');
  // Il vient après les composants du dépôt (skills/agents editables d'abord).
  assert.ok(files.findIndex((f) => f.kind === 'official-skill') > files.findIndex((f) => f.kind === 'skill'));
});

test('un nouveau skill reçoit un front matter et reste dans le dossier autorisé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const created = createManagedFile(data.repo, data.home, {
    kind: 'skill',
    slug: 'analyse-contrat',
    name: 'Analyse de contrat',
    description: 'Analyser les clauses importantes.',
  });
  assert.equal(created.path, 'piecemaker-plugin/skills/analyse-contrat/SKILL.md');
  assert.match(created.content, /^---\nname: analyse-contrat\n/);
  assert.match(created.content, /# Analyse de contrat/);
  assert.throws(() => createManagedFile(data.repo, data.home, {
    kind: 'agent', slug: '../secret', name: 'x', description: 'x',
  }), /identifiant/);
});

test('un nouvel agent reçoit ses propres réglages : outils et modèle', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const created = createManagedFile(data.repo, data.home, {
    kind: 'agent',
    slug: 'analyste-bail',
    name: 'Analyste de bail',
    description: 'Analyser un bail commercial.',
    tools: 'Read, Grep, Bash(git log:*)',
    model: 'opus',
  });
  assert.equal(created.path, 'piecemaker-plugin/agents/analyste-bail.md');
  assert.match(created.content, /^---\nname: analyste-bail\n/);
  assert.match(created.content, /^tools: Read, Grep, Bash\(git log:\*\)$/m);
  assert.match(created.content, /^model: opus$/m);

  // Un skill n'a ni outils ni modèle : son gabarit reste minimal.
  const skill = createManagedFile(data.repo, data.home, {
    kind: 'skill', slug: 'bail', name: 'Bail', description: 'Résumer un bail.',
  });
  assert.doesNotMatch(skill.content, /^(tools|model):/m);

  assert.equal(normalizeAgentTools(''), '');
  assert.equal(normalizeAgentTools(undefined), 'Read, Grep, Glob');
  assert.equal(normalizeAgentTools('Read, Read, Glob'), 'Read, Glob');
  assert.throws(() => normalizeAgentTools('rm -rf /'), /Outil invalide/);
  assert.equal(normalizeAgentModel('SONNET'), 'sonnet');
  assert.throws(() => normalizeAgentModel('gpt'), /Modèle inconnu/);
  assert.throws(() => createManagedFile(data.repo, data.home, {
    kind: 'agent', slug: 'x-y', name: 'x', description: 'x', model: 'inconnu',
  }), /Modèle inconnu/);
});

test('un fichier annexe s’écrit dans le dossier du skill, jamais ailleurs', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const saved = saveManagedAsset(
    data.repo,
    data.home,
    'piecemaker-plugin/skills/redaction/SKILL.md',
    'scripts/../analyse.py',
    Buffer.from('print("ok")\n'),
  );
  // Le nom est réduit à son basename : pas de sous-dossier, pas de remontée.
  assert.equal(saved.name, 'analyse.py');
  assert.equal(saved.path, 'piecemaker-plugin/skills/redaction/analyse.py');
  const onDisk = path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction', 'analyse.py');
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'print("ok")\n');

  // Un binaire est écrit tel quel (pas de réencodage utf8).
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const png = saveManagedAsset(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md', 'logo.png', bytes);
  assert.deepEqual(fs.readFileSync(path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction', png.name)), bytes);

  // Un agent n'a pas de dossier d'annexes ; SKILL.md n'est jamais écrasé ; un
  // corps vide est refusé.
  assert.throws(() => saveManagedAsset(data.repo, data.home, 'piecemaker-plugin/agents/analyse.md', 'x.txt', Buffer.from('x')), /skill/);
  assert.throws(() => saveManagedAsset(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md', 'SKILL.md', Buffer.from('x')), /SKILL\.md/);
  assert.throws(() => saveManagedAsset(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md', 'vide.txt', Buffer.alloc(0)), /vide/i);
});

test('les annexes d’un skill sont listées (nom seul, sous-dossiers inclus) et suppressibles une à une', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const skillDir = path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction');
  fs.writeFileSync(path.join(skillDir, 'modele.docx'), 'x');
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'scripts', 'analyse.py'), 'print("ok")\n');
  // Fichier caché et dossier caché ignorés.
  fs.writeFileSync(path.join(skillDir, '.DS_Store'), 'x');
  fs.mkdirSync(path.join(skillDir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, '.cache', 'ignored.txt'), 'x');

  const assets = listSkillAssets(data.repo, 'piecemaker-plugin/skills/redaction/SKILL.md');
  assert.deepEqual(assets, [
    { name: 'analyse.py', path: 'piecemaker-plugin/skills/redaction/scripts/analyse.py' },
    { name: 'modele.docx', path: 'piecemaker-plugin/skills/redaction/modele.docx' },
  ]);

  // La même liste apparaît sous l'entrée `assets` du skill dans listManagedFiles ;
  // les agents n'ont jamais d'annexes.
  const files = listManagedFiles(data.repo, data.home, undefined, { installedSkills: [] });
  const skillEntry = files.find((file) => file.path === 'piecemaker-plugin/skills/redaction/SKILL.md');
  assert.deepEqual(skillEntry.assets.map((asset) => asset.name), ['analyse.py', 'modele.docx']);
  const agentEntry = files.find((file) => file.path === 'piecemaker-plugin/agents/analyse.md');
  assert.deepEqual(agentEntry.assets, []);

  // Suppression d'une seule annexe : le reste du skill survit, une sauvegarde
  // est déposée.
  const deleted = deleteManagedAsset(data.repo, data.home, 'piecemaker-plugin/skills/redaction/scripts/analyse.py');
  assert.equal(deleted.path, 'piecemaker-plugin/skills/redaction/scripts/analyse.py');
  assert.ok(!fs.existsSync(path.join(skillDir, 'scripts', 'analyse.py')));
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skillDir, 'modele.docx')));
  assert.ok(fs.existsSync(path.join(data.home, 'backups')));

  // SKILL.md n'est jamais une « annexe » supprimable ainsi.
  assert.throws(
    () => deleteManagedAsset(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md'),
    /annexe/,
  );
  // Traversée hors du dépôt refusée.
  assert.throws(
    () => deleteManagedAsset(data.repo, data.home, '../secret.md'),
    /annexe/,
  );
  // Chemin hors de l'arborescence des skills refusé.
  assert.throws(
    () => deleteManagedAsset(data.repo, data.home, 'piecemaker-plugin/agents/analyse.md'),
    /annexe/,
  );
});

test('la suppression retire skill/agent avec sauvegarde, mais jamais les instructions', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Un skill : le dossier entier disparaît, une sauvegarde est conservée.
  const skillDir = path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction');
  assert.ok(fs.existsSync(skillDir));
  const deletedSkill = deleteManagedFile(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md');
  assert.equal(deletedSkill.kind, 'skill');
  assert.ok(!fs.existsSync(skillDir));

  // Un agent : le seul fichier .md disparaît.
  const agentFile = path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyse.md');
  assert.ok(fs.existsSync(agentFile));
  deleteManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyse.md');
  assert.ok(!fs.existsSync(agentFile));

  // Une sauvegarde a bien été déposée sous ~/.piecemaker/backups.
  assert.ok(fs.existsSync(path.join(data.home, 'backups')));

  // Instructions, traversée et fichier absent sont refusés.
  assert.throws(() => deleteManagedFile(data.repo, data.home, 'CLAUDE.md'), /skill ou un agent/);
  assert.throws(() => deleteManagedFile(data.repo, data.home, '../secret.md'), /administrables/);
  assert.throws(() => deleteManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyse.md'), /introuvable/);
});

test('renommer un skill/agent déplace son dossier ou son fichier vers le nouveau slug', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  // Un skill : le dossier entier suit le nouveau nom, ses annexes comprises.
  const skillDir = path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction');
  fs.writeFileSync(path.join(skillDir, 'gabarit.md'), '# annexe\n');
  const skill = renameManagedFile(data.repo, data.home, 'piecemaker-plugin/skills/redaction/SKILL.md', 'redaction-juridique');
  assert.equal(skill.renamed, true);
  assert.equal(skill.path, 'piecemaker-plugin/skills/redaction-juridique/SKILL.md');
  assert.equal(skill.previous, 'piecemaker-plugin/skills/redaction/SKILL.md');
  assert.ok(!fs.existsSync(skillDir));
  const movedDir = path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction-juridique');
  assert.ok(fs.existsSync(path.join(movedDir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(movedDir, 'gabarit.md')));

  // Un agent : le seul fichier .md est renommé.
  const agent = renameManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyse.md', 'analyste-piece');
  assert.equal(agent.path, 'piecemaker-plugin/agents/analyste-piece.md');
  assert.ok(!fs.existsSync(path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyse.md')));
  assert.ok(fs.existsSync(path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyste-piece.md')));

  // Un nom inchangé ne renomme rien ; un slug invalide ou une cible déjà prise
  // sont refusés.
  assert.equal(renameManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyste-piece.md', 'analyste-piece').renamed, false);
  assert.throws(() => renameManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyste-piece.md', 'Analyste Pièce'), /minuscules/);
  createManagedFile(data.repo, data.home, { kind: 'agent', slug: 'occupe', name: 'x', description: 'x' });
  assert.throws(() => renameManagedFile(data.repo, data.home, 'piecemaker-plugin/agents/analyste-piece.md', 'occupe'), /existe déjà/);
});

test('un enregistrement crée une sauvegarde et refuse la traversée de dossiers', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const relative = 'piecemaker-plugin/agents/analyse.md';
  const result = saveManagedFile(data.repo, data.home, relative, '# Nouvelle analyse');
  assert.equal(readManagedFile(data.repo, relative).content, '# Nouvelle analyse\n');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), '# Analyse\n');
  assert.throws(() => saveManagedFile(data.repo, data.home, '../secret.md', 'x'), /administrables/);
});

test('les secrets .env peuvent être remplacés ou effacés sans perdre les commentaires', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const envFile = path.join(data.repo, '.env');
  fs.writeFileSync(envFile, '# PieceMaker\nLEGIFRANCE_CLIENT_SECRET=ancien\n');
  updateEnvFile(envFile, { LEGIFRANCE_CLIENT_SECRET: 'nouveau' });
  let content = fs.readFileSync(envFile, 'utf8');
  assert.match(content, /^# PieceMaker/m);
  assert.match(content, /^LEGIFRANCE_CLIENT_SECRET=nouveau$/m);
  updateEnvFile(envFile, {}, ['LEGIFRANCE_CLIENT_SECRET']);
  content = fs.readFileSync(envFile, 'utf8');
  assert.doesNotMatch(content, /^LEGIFRANCE_CLIENT_SECRET=/m);
});

test('le nom signataire peut être modifié dans le env global protégé', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const envFile = path.join(data.repo, '.env');

  updateEnvFile(envFile, { PIECEMAKER_USER_NAME: 'Alice Martin' });
  assert.match(fs.readFileSync(envFile, 'utf8'), /^PIECEMAKER_USER_NAME=Alice Martin$/m);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

  updateEnvFile(envFile, { PIECEMAKER_USER_NAME: 'Bob Dupont' });
  assert.match(fs.readFileSync(envFile, 'utf8'), /^PIECEMAKER_USER_NAME=Bob Dupont$/m);
  assert.throws(
    () => updateEnvFile(envFile, { PIECEMAKER_USER_NAME: 'Nom <invalide>' }),
    /Nom utilisateur invalide/,
  );
});

test('l’administration refuse les origines web non locales', () => {
  assert.equal(isLocalOrigin('https://localhost:43098'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1:43098'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
});

test('les dossiers tamponnables listent les pièces originales du dossier enregistré, sans le Markdown', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const workspace = path.join(data.root, 'dossiers-juridiques');
  fs.mkdirSync(path.join(workspace, 'Dupont c-Martin'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'Dossier vide'), { recursive: true });
  const legalCase = fs.realpathSync(path.join(workspace, 'Dupont c-Martin'));
  const emptyCase = fs.realpathSync(path.join(workspace, 'Dossier vide'));
  fs.mkdirSync(data.home, { recursive: true });
  fs.writeFileSync(path.join(data.home, 'config.json'), JSON.stringify({ caseFolders: [legalCase, emptyCase] }));

  // Pièces originales à tamponner + dérivés qui ne doivent pas apparaître.
  fs.writeFileSync(path.join(legalCase, 'contrat.pdf'), '%PDF');
  fs.writeFileSync(path.join(legalCase, 'contrat.md'), '# converti');
  fs.writeFileSync(path.join(legalCase, 'compilation_dossier_ABC.json'), '{}');
  fs.mkdirSync(path.join(legalCase, 'annexes'), { recursive: true });
  fs.writeFileSync(path.join(legalCase, 'annexes', 'facture.pdf'), '%PDF');

  const dossiers = await listDossiers(data.repo, data.home);
  assert.equal(dossiers.length, 1);
  assert.equal(dossiers[0].informations.intitule, 'Dupont c-Martin');
  assert.equal(dossiers[0].folder, legalCase);
  assert.equal(dossiers[0].stampedDir, path.join(legalCase, 'Pièces tamponnées'));
  // Identifiée par son chemin relatif au dossier ; ni le `.md` ni le `.json`.
  assert.deepEqual(dossiers[0].documents, [
    { id: 'annexes/facture.pdf', filename: 'annexes/facture.pdf', type_document: 'PDF', date_document: '' },
    { id: 'contrat.pdf', filename: 'contrat.pdf', type_document: 'PDF', date_document: '' },
  ]);
  assert.ok(!dossiers.some((dossier) => dossier.folder === emptyCase), 'un dossier sans pièce est omis');
});

test('les dossiers s’ouvrent avec les commandes du système, sans passer par un shell', () => {
  const mac = revealCommands('darwin', 'files', '/Users/me/Dossiers/Martin');
  assert.deepEqual(mac, [{ command: 'open', args: ['-R', '/Users/me/Dossiers/Martin'] }]);
  assert.deepEqual(revealCommands('darwin', 'terminal', '/Users/me/Dossiers/Martin'), [
    { command: 'open', args: ['-a', 'Terminal', '/Users/me/Dossiers/Martin'] },
  ]);

  const explorer = revealCommands('win32', 'files', 'C:\\Dossiers\\Martin Dupont');
  assert.deepEqual(explorer, [{ command: 'explorer.exe', args: ['/select,C:\\Dossiers\\Martin Dupont'] }]);

  const terminals = revealCommands('win32', 'terminal', "C:\\Dossiers\\O'Neil");
  assert.equal(terminals[0].command, 'wt.exe');
  assert.deepEqual(terminals[0].args, ['-d', "C:\\Dossiers\\O'Neil"]);
  // L’apostrophe du dossier est doublée pour rester dans la chaîne PowerShell.
  assert.match(terminals[1].args[2], /-WorkingDirectory 'C:\\Dossiers\\O''Neil'$/);

  assert.equal(revealCommands('linux', 'files', '/home/me/Dossiers')[0].command, 'xdg-open');
});

test('une action de dossier inconnue ou un chemin relatif sont refusés', () => {
  assert.throws(() => revealCommands('darwin', 'browser', '/Users/me'), /Action de dossier inconnue/);
  assert.throws(() => revealCommands('darwin', 'files', 'Dossiers/Martin'), /Chemin de dossier invalide/);
});

// ---------------------------------------------------------------------------
// Pop-up « Ajouter le plugin legal Claude » (onglet Skills et agents) :
// GET /api/admin/plugin/components et POST /api/admin/plugin/install.
// ---------------------------------------------------------------------------

function pluginFixture() {
  const data = fixture();
  fs.writeFileSync(
    path.join(data.repo, 'piecemaker-plugin', 'agents', 'analyse.md'),
    '---\nname: analyse\ndescription: "Analyse une pièce du dossier."\n---\n# Analyse\n',
  );
  fs.writeFileSync(
    path.join(data.repo, 'piecemaker-plugin', 'skills', 'redaction', 'SKILL.md'),
    '---\nname: redaction\ndescription: "Rédige un acte juridique."\n---\n# Rédaction\n',
  );
  return data;
}

test('listPluginComponents lit le front matter et l’état d’enregistrement de chaque composant', (t) => {
  const data = pluginFixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));

  const components = listPluginComponents(data.repo, data.home);
  assert.deepEqual(components.map((component) => component.path), [
    'piecemaker-plugin/agents/analyse.md',
    'piecemaker-plugin/skills/redaction/SKILL.md',
  ]);
  assert.deepEqual(components.map((component) => component.state), ['missing', 'missing']);
  assert.deepEqual(components.map((component) => component.registered), [false, false]);
  const agent = components.find((component) => component.kind === 'agent');
  assert.equal(agent.name, 'analyse');
  assert.equal(agent.description, 'Analyse une pièce du dossier.');
});

test('applyPluginComponentSelection enregistre les composants cochés et retire ceux décochés, sans jamais toucher un conflit', (t) => {
  const data = pluginFixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const agentPath = 'piecemaker-plugin/agents/analyse.md';
  const skillPath = 'piecemaker-plugin/skills/redaction/SKILL.md';

  // Un fichier personnel homonyme pour le skill : jamais remplacé.
  const personalSkill = path.join(data.home, '.claude', 'skills', 'redaction');
  fs.mkdirSync(personalSkill, { recursive: true });
  fs.writeFileSync(path.join(personalSkill, 'SKILL.md'), '# skill personnel\n');

  const applied = applyPluginComponentSelection(data.repo, data.home, [agentPath, skillPath]);
  assert.equal(applied.registered, 1);
  assert.equal(applied.conflicts.length, 1);
  assert.equal(applied.conflicts[0].path, skillPath);
  assert.equal(fs.readFileSync(path.join(personalSkill, 'SKILL.md'), 'utf8'), '# skill personnel\n');

  let components = listPluginComponents(data.repo, data.home);
  assert.equal(components.find((c) => c.path === agentPath).registered, true);
  assert.equal(components.find((c) => c.path === skillPath).state, 'conflict');

  // Idempotent : ré-appliquer la même sélection ne change rien.
  const reapplied = applyPluginComponentSelection(data.repo, data.home, [agentPath, skillPath]);
  assert.equal(reapplied.registered, 1);

  // Décocher l'agent le retire — la liste reflète l'état réel, coché =
  // enregistré, comme le pop-up le lit à sa réouverture.
  const removed = applyPluginComponentSelection(data.repo, data.home, []);
  assert.equal(removed.removed, 1);
  components = listPluginComponents(data.repo, data.home);
  assert.equal(components.find((c) => c.path === agentPath).registered, false);
});

test('ensureClaudePluginActive installe (marketplace puis plugin) quand rien n’est encore installé', async (t) => {
  const data = pluginFixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('list') && args.includes('--json') && args.includes('marketplace')) return { ok: true, output: '[]' };
    if (args.includes('list') && args.includes('--json')) return { ok: true, output: '[]' };
    if (args.includes('add')) return { ok: true, output: 'ok' };
    if (args.includes('install')) return { ok: true, output: 'ok' };
    return { ok: false, output: 'inattendu' };
  };

  const result = await ensureClaudePluginActive({ repoRoot: data.repo, userHome: data.home, runCommand });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'installed');
  assert.equal(result.installed, true);
  assert.ok(calls.some((call) => call.includes('marketplace add')));
  assert.ok(calls.some((call) => call.includes('plugin install')));
});

test('ensureClaudePluginActive rapporte l’échec sans lever quand le CLI claude est absent', async (t) => {
  const data = pluginFixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const runCommand = () => ({ ok: false, output: '' });

  const result = await ensureClaudePluginActive({ repoRoot: data.repo, userHome: data.home, runCommand });
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.match(result.reason, /Échec/);
});

test('ensureClaudePluginActive délègue à refreshClaudePlugin quand le plugin est déjà installé', async (t) => {
  const data = pluginFixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const runCommand = (command, args) => {
    if (args.includes('list') && args.includes('--json')) {
      return { ok: true, output: JSON.stringify([{ id: 'piecemaker@piecemaker', enabled: true, version: '1.0.0' }]) };
    }
    throw new Error(`commande inattendue en environnement de test : ${[command, ...args].join(' ')}`);
  };
  let refreshCalledWith = null;
  const refreshInstalledPlugin = async (options) => {
    refreshCalledWith = options;
    return { ok: true, refreshed: false, alreadyUpToDate: true };
  };

  const result = await ensureClaudePluginActive({
    repoRoot: data.repo,
    userHome: data.home,
    runCommand,
    refreshInstalledPlugin,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'refresh');
  assert.equal(result.installed, true);
  assert.equal(result.alreadyUpToDate, true);
  assert.equal(refreshCalledWith.userHome, data.home);
  assert.equal(refreshCalledWith.pluginDir, path.join(data.repo, 'piecemaker-plugin'));
});

// ---------------------------------------------------------------------------
// Onglet « Marketplace officiel » du même pop-up : GET /plugin/marketplace,
// POST /plugin/marketplace/register, POST /plugin/marketplace/install.
// Constat d'investigation (voir CLAUDE.md / rapport de fonctionnalité) : la
// CLI `claude` n'a pas de sous-commande de recherche distante — seule
// `claude plugin list --available --json` énumère les plugins non installés
// des marketplaces déjà enregistrées. Ces tests reproduisent sa forme
// réelle (constatée sur un vrai poste) via un faux `runCommand` injecté.
// ---------------------------------------------------------------------------

const FAKE_MARKETPLACES = [
  { name: 'piecemaker', source: 'github', repo: 'PieceMaker-Legal/PieceMaker-Installer' },
  { name: 'claude-plugins-official', source: 'github', repo: 'anthropics/claude-plugins-official' },
];
const FAKE_AVAILABLE = {
  installed: [
    { id: 'telegram@claude-plugins-official', enabled: true, scope: 'user' },
    { id: 'swift-lsp@claude-plugins-official', enabled: false, scope: 'user' },
    { id: 'piecemaker@piecemaker', enabled: true, scope: 'user' },
  ],
  available: [
    {
      pluginId: 'frontend-design@claude-plugins-official',
      name: 'frontend-design',
      description: 'Guidance for distinctive UI design.',
      marketplaceName: 'claude-plugins-official',
      installCount: 12345,
    },
  ],
};

function fakeMarketplaceRunCommand(overrides = {}) {
  return (command, args) => {
    const key = args.join(' ');
    if (overrides[key]) return overrides[key]();
    if (args.includes('marketplace') && args.includes('list')) return { ok: true, output: JSON.stringify(FAKE_MARKETPLACES) };
    if (args.includes('list') && args.includes('--available')) return { ok: true, output: JSON.stringify(FAKE_AVAILABLE) };
    return { ok: false, output: `commande inattendue en test : ${key}` };
  };
}

test('listRegisteredMarketplaces exclut le marketplace piecemaker et détecte le marketplace officiel Anthropic', () => {
  const marketplaces = listRegisteredMarketplaces(fakeMarketplaceRunCommand());
  assert.deepEqual(marketplaces.map((m) => m.name), ['claude-plugins-official']);
  assert.equal(marketplaces[0].official, true);
});

test('listMarketplaceConnectors fusionne le catalogue disponible et les plugins installés, hors piecemaker', () => {
  const state = listMarketplaceConnectors(fakeMarketplaceRunCommand());
  assert.equal(state.officialRegistered, true);
  const ids = state.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    'frontend-design@claude-plugins-official',
    'swift-lsp@claude-plugins-official',
    'telegram@claude-plugins-official',
  ]);
  // Le plugin de notre propre marketplace n'apparaît jamais dans cet onglet.
  assert.ok(!ids.includes('piecemaker@piecemaker'));
  const telegram = state.plugins.find((p) => p.id === 'telegram@claude-plugins-official');
  assert.equal(telegram.installed, true);
  assert.equal(telegram.enabled, true);
  const frontend = state.plugins.find((p) => p.id === 'frontend-design@claude-plugins-official');
  assert.equal(frontend.installed, false);
  assert.equal(frontend.description, 'Guidance for distinctive UI design.');
  assert.equal(frontend.installCount, 12345);
});

test('listMarketplaceConnectors rapporte l’échec sans lever quand la CLI ne répond pas', () => {
  const runCommand = () => ({ ok: false, output: '' });
  const state = listMarketplaceConnectors(runCommand);
  assert.deepEqual(state.plugins, []);
  assert.match(state.reason, /Échec/);
});

test('applyMarketplaceSelection installe/active/désactive selon l’état courant, sans jamais désinstaller', () => {
  const calls = [];
  const runCommand = fakeMarketplaceRunCommand({
    'plugin install frontend-design@claude-plugins-official -y': () => { calls.push('install'); return { ok: true, output: 'ok' }; },
    'plugin enable swift-lsp@claude-plugins-official': () => { calls.push('enable'); return { ok: true, output: 'ok' }; },
    'plugin disable telegram@claude-plugins-official': () => { calls.push('disable'); return { ok: true, output: 'ok' }; },
  });

  // Coché : frontend-design (pas installé) et swift-lsp (installé, désactivé) ;
  // décoché : telegram (actif) — donc install + enable + disable, une fois chacun.
  const result = applyMarketplaceSelection(
    ['frontend-design@claude-plugins-official', 'swift-lsp@claude-plugins-official'],
    runCommand,
  );
  assert.equal(result.installed, 1);
  assert.equal(result.enabled, 1);
  assert.equal(result.disabled, 1);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(calls.sort(), ['disable', 'enable', 'install']);

  // Idempotent : ré-appliquer un état déjà atteint n'invoque aucune commande.
  const calls2 = [];
  const runCommand2 = fakeMarketplaceRunCommand({
    'plugin install frontend-design@claude-plugins-official -y': () => { calls2.push('install'); return { ok: true, output: 'ok' }; },
  });
  // État courant simulé : rien n'a changé côté CLI (toujours le fixture de
  // départ), donc redemander exactement le même état initial (telegram actif
  // seul) ne doit rien invoquer.
  const noop = applyMarketplaceSelection(['telegram@claude-plugins-official'], runCommand2);
  assert.deepEqual(calls2, []);
  assert.equal(noop.installed, 0);
  assert.equal(noop.enabled, 0);
  assert.equal(noop.disabled, 0);
});

test('applyMarketplaceSelection remonte un échec individuel sans lever ni bloquer les autres', () => {
  const runCommand = fakeMarketplaceRunCommand({
    'plugin install frontend-design@claude-plugins-official -y': () => ({ ok: false, output: 'réseau indisponible' }),
    'plugin enable swift-lsp@claude-plugins-official': () => ({ ok: true, output: 'ok' }),
  });
  // telegram reste coché (déjà actif) : aucune commande ne le concerne, seuls
  // frontend-design (échoue) et swift-lsp (réussit) changent d'état.
  const result = applyMarketplaceSelection(
    ['frontend-design@claude-plugins-official', 'swift-lsp@claude-plugins-official', 'telegram@claude-plugins-official'],
    runCommand,
  );
  assert.equal(result.enabled, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'frontend-design@claude-plugins-official');
  assert.match(result.failed[0].reason, /réseau indisponible/);
});

test('registerOfficialMarketplace ajoute le marketplace absent, ou le met à jour s’il est déjà enregistré', () => {
  const addCalls = [];
  const runCommandMissing = (command, args) => {
    if (args.includes('marketplace') && args.includes('list')) {
      return { ok: true, output: JSON.stringify([FAKE_MARKETPLACES[0]]) }; // seul piecemaker enregistré
    }
    if (args.includes('marketplace') && args.includes('add')) { addCalls.push(args); return { ok: true, output: 'ok' }; }
    return { ok: false, output: 'inattendu' };
  };
  const result = registerOfficialMarketplace(runCommandMissing);
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRegistered, false);
  assert.deepEqual(addCalls[0], ['plugin', 'marketplace', 'add', 'anthropics/claude-plugins-official']);

  const updateCalls = [];
  const runCommandPresent = (command, args) => {
    if (args.includes('marketplace') && args.includes('list')) return { ok: true, output: JSON.stringify(FAKE_MARKETPLACES) };
    if (args.includes('marketplace') && args.includes('update')) { updateCalls.push(args); return { ok: true, output: 'ok' }; }
    return { ok: false, output: 'inattendu' };
  };
  const already = registerOfficialMarketplace(runCommandPresent);
  assert.equal(already.alreadyRegistered, true);
  assert.deepEqual(updateCalls[0], ['plugin', 'marketplace', 'update', 'claude-plugins-official']);
});

// ---------------------------------------------------------------------------
// Scoping par marketplace : l'onglet « Plugin legal Claude » (scope legal) ne
// voit que les plugins de claude-for-legal, l'onglet « Marketplace officiel »
// (scope official) que ceux de claude-plugins-official. Fixture partagée avec
// les deux marketplaces Anthropic enregistrés + un plugin legal.
// ---------------------------------------------------------------------------
const FAKE_MARKETPLACES_BOTH = [
  ...FAKE_MARKETPLACES,
  { name: 'claude-for-legal', source: 'github', repo: 'anthropics/claude-for-legal' },
];
const FAKE_AVAILABLE_BOTH = {
  installed: FAKE_AVAILABLE.installed,
  available: [
    ...FAKE_AVAILABLE.available,
    {
      pluginId: 'litigation-legal@claude-for-legal',
      name: 'litigation-legal',
      description: 'Manages litigation portfolios, claim charts, chronologies.',
      marketplaceName: 'claude-for-legal',
      installCount: 42,
    },
  ],
};
function fakeScopedRunCommand(overrides = {}) {
  return (command, args) => {
    const key = args.join(' ');
    if (overrides[key]) return overrides[key]();
    if (args.includes('marketplace') && args.includes('list')) return { ok: true, output: JSON.stringify(FAKE_MARKETPLACES_BOTH) };
    if (args.includes('list') && args.includes('--available')) return { ok: true, output: JSON.stringify(FAKE_AVAILABLE_BOTH) };
    return { ok: false, output: `commande inattendue en test : ${key}` };
  };
}

test('listMarketplaceConnectors scopé sur claude-for-legal ne renvoie que les plugins legal', () => {
  const state = listMarketplaceConnectors(fakeScopedRunCommand(), { marketplaceName: 'claude-for-legal' });
  assert.equal(state.registered, true);
  const ids = state.plugins.map((p) => p.id).sort();
  assert.deepEqual(ids, ['litigation-legal@claude-for-legal']);
  // Aucun plugin de l'officiel ne fuit dans l'onglet legal.
  assert.ok(!ids.some((id) => id.endsWith('@claude-plugins-official')));
});

test('listMarketplaceConnectors scopé sur l’officiel exclut les plugins legal', () => {
  const state = listMarketplaceConnectors(fakeScopedRunCommand(), { marketplaceName: 'claude-plugins-official' });
  const ids = state.plugins.map((p) => p.id);
  assert.ok(ids.every((id) => id.endsWith('@claude-plugins-official')));
  assert.ok(!ids.includes('litigation-legal@claude-for-legal'));
});

test('listMarketplaceConnectors scopé signale registered:false quand le marketplace n’est pas déclaré', () => {
  // Poste n'ayant que le marketplace officiel : le scope legal doit être vu
  // comme non enregistré (bouton « Découvrir » proposé) et son catalogue vide.
  const runCommand = (command, args) => {
    if (args.includes('marketplace') && args.includes('list')) return { ok: true, output: JSON.stringify(FAKE_MARKETPLACES) };
    if (args.includes('list') && args.includes('--available')) return { ok: true, output: JSON.stringify(FAKE_AVAILABLE) };
    return { ok: false, output: 'inattendu' };
  };
  const state = listMarketplaceConnectors(runCommand, { marketplaceName: 'claude-for-legal' });
  assert.equal(state.registered, false);
  assert.deepEqual(state.plugins, []);
});

test('registerOfficialMarketplace enregistre le marketplace legal quand on lui passe son descripteur', () => {
  const addCalls = [];
  const runCommand = (command, args) => {
    if (args.includes('marketplace') && args.includes('list')) return { ok: true, output: JSON.stringify(FAKE_MARKETPLACES) };
    if (args.includes('marketplace') && args.includes('add')) { addCalls.push(args); return { ok: true, output: 'ok' }; }
    return { ok: false, output: 'inattendu' };
  };
  const result = registerOfficialMarketplace(runCommand, { name: 'claude-for-legal', slug: 'anthropics/claude-for-legal' });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyRegistered, false);
  assert.deepEqual(addCalls[0], ['plugin', 'marketplace', 'add', 'anthropics/claude-for-legal']);
});

test('applyMarketplaceSelection scopé sur legal ne touche pas les plugins de l’officiel', () => {
  const calls = [];
  const runCommand = fakeScopedRunCommand({
    'plugin install litigation-legal@claude-for-legal -y': () => { calls.push('install-legal'); return { ok: true, output: 'ok' }; },
    'plugin disable telegram@claude-plugins-official': () => { calls.push('disable-official'); return { ok: true, output: 'ok' }; },
  });
  // On coche uniquement le plugin legal. telegram (officiel, actif) est absent
  // de la sélection mais ne doit PAS être désactivé : il est hors scope.
  const result = applyMarketplaceSelection(
    ['litigation-legal@claude-for-legal'],
    runCommand,
    { marketplaceName: 'claude-for-legal' },
  );
  assert.equal(result.installed, 1);
  assert.deepEqual(calls, ['install-legal']);
  assert.ok(!calls.includes('disable-official'));
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createManagedFile,
  isLocalOrigin,
  listDossiers,
  listManagedFiles,
  managedFileKind,
  normalizeAgentModel,
  normalizeAgentTools,
  readManagedFile,
  revealCommands,
  saveManagedFile,
  updateEnvFile,
} = require('../websocket-server/admin-routes.cjs');

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
  const files = listManagedFiles(data.repo, data.home);
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
  const files = listManagedFiles(data.repo, data.home);
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

test('l’administration refuse les origines web non locales', () => {
  assert.equal(isLocalOrigin('https://localhost:43098'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1:43098'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
});

test('les dossiers tamponnables sont listés par dossier juridique, sans le texte des pièces', (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const workspace = path.join(data.root, 'dossiers-juridiques');
  const legalCase = path.join(workspace, 'Dupont c-Martin');
  fs.mkdirSync(legalCase, { recursive: true });
  fs.mkdirSync(data.home, { recursive: true });
  fs.writeFileSync(path.join(data.home, 'config.json'), JSON.stringify({ workspacePath: workspace }));
  fs.writeFileSync(path.join(legalCase, 'compilation_dossier_ABC.json'), JSON.stringify({
    informations_dossier: { intitule: 'Dupont c/ Martin' },
    documents: [{ id: '0001', filename: 'contrat.pdf', type_document: 'Contrat', texte_integral: 'SECRET' }],
  }));
  fs.writeFileSync(path.join(legalCase, 'compilation_dossier_VIDE.json'), JSON.stringify({ documents: [] }));

  const dossiers = listDossiers(data.repo, data.home);
  assert.equal(dossiers.length, 1);
  assert.equal(dossiers[0].documentId, 'ABC');
  assert.equal(dossiers[0].informations.intitule, 'Dupont c/ Martin');
  assert.equal(dossiers[0].folder, legalCase);
  assert.equal(dossiers[0].stampedDir, path.join(legalCase, 'Pièces tamponnées'));
  assert.deepEqual(dossiers[0].documents, [
    { id: '0001', filename: 'contrat.pdf', type_document: 'Contrat', date_document: '' },
  ]);
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

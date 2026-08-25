const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildLegalGraph,
  enrichLegalQueryOutput,
  legalGraphStatus,
  legalGraphEnvironment,
  legalTopology,
  queryLegalGraph,
} = require('../websocket-server/legal-graph.cjs');
const { documentIndexFile } = require('../websocket-server/document-index.cjs');
const {
  markFilesAnonymized,
  stateKey,
} = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');
const { WORKSPACE_SUBDIR } = require('../piecemaker-plugin/scripts/lib/protection.cjs');

function attestLegalPrompt(options) {
  const prompt = fs.readFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT);
  const digest = crypto.createHash('sha256').update(prompt).digest('hex');
  fs.writeFileSync(options.env.PIECEMAKER_GRAPHIFY_LEGAL_MARKER, digest);
}

function fixture() {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legal-graph-'));
  const original = path.join(caseRoot, 'Contrat et assignation.pdf');
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(caseRoot, '.piecemaker'), { recursive: true });
  fs.writeFileSync(original, 'ORIGINAL');
  fs.writeFileSync(path.join(workspace, 'Contrat et assignation.md'), [
    '# Contrat et litige',
    'Alice Martin a signé un contrat avec BETA SAS.',
    'BETA SAS n’a pas exécuté son obligation. Alice Martin demande réparation.',
    'BETA SAS soutient que le contrat est nul au regard de la loi invoquée.',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'mapping_default.json'), JSON.stringify({
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
    },
  }));
  fs.writeFileSync(documentIndexFile(caseRoot), JSON.stringify({
    version: 1,
    documents: {
      [stateKey('Contrat et assignation.pdf')]: {
        nature: 'assignation',
        nature_confidence: 1,
        doc_date: '2 janvier 2024',
        doc_date_iso: '2024-01-02',
        juridiction: null,
        codes: ['PERSONNE_PHYSIQUE_01', 'SAS_1'],
        updatedAt: '2026-08-25T00:00:00Z',
      },
    },
  }));
  markFilesAnonymized(caseRoot, [original], '2026-08-25T00:00:00Z');
  return { caseRoot, original, workspace };
}

function semanticFragment(sourceFile) {
  return {
    input_tokens: 1200,
    output_tokens: 620,
    nodes: [
      { id: 'piece_source', label: 'Nom de fichier inventé', file_type: 'document', legal_kind: 'document', source_file: sourceFile },
      { id: 'personne_a', label: 'PERSONNE_PHYSIQUE_01', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      { id: 'societe_b', label: 'SAS_1', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      { id: 'contrat_ab', label: 'Contrat entre les parties', file_type: 'concept', legal_kind: 'contrat', source_file: sourceFile, assertion_status: 'ETABLI_PAR_ACTE' },
      { id: 'obligation_b', label: 'Obligation contractuelle de SAS_1', file_type: 'concept', legal_kind: 'obligation', source_file: sourceFile },
      { id: 'inexecution_b', label: 'Inexécution alléguée', file_type: 'concept', legal_kind: 'inexecution', source_file: sourceFile, assertion_status: 'ALLEGUE' },
      { id: 'demande_reparation', label: 'Demande de réparation', file_type: 'concept', legal_kind: 'demande', source_file: sourceFile },
      { id: 'moyen_nullite', label: 'Moyen de nullité', file_type: 'concept', legal_kind: 'argument', source_file: sourceFile, assertion_status: 'CONTESTE' },
      { id: 'question_norme_contrat', label: 'Applicabilité de la norme au contrat', file_type: 'concept', legal_kind: 'question_juridique', source_file: sourceFile, assertion_status: 'INFERRE' },
      { id: 'fait_sans_partie', label: 'Élément à rattacher', file_type: 'concept', legal_kind: 'fait', source_file: sourceFile },
      { id: 'entite_inventee', label: 'PERSONNE_PHYSIQUE_99', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
    ],
    edges: [
      { source: 'personne_a', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 0.4, assertion_status: 'ETABLI_PAR_ACTE', source_file: sourceFile },
      { source: 'societe_b', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'ETABLI_PAR_ACTE', source_file: sourceFile },
      { source: 'contrat_ab', target: 'obligation_b', relation: 'cree_obligation', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'obligation_b', target: 'societe_b', relation: 'a_pour_debiteur', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'obligation_b', target: 'personne_a', relation: 'a_pour_creancier', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'societe_b', target: 'inexecution_b', relation: 'n_execute_pas', confidence: 'INFERRED', confidence_score: 0.71, assertion_status: 'ALLEGUE', source_file: sourceFile },
      { source: 'personne_a', target: 'demande_reparation', relation: 'demande_reparation', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'ALLEGUE', source_file: sourceFile },
      { source: 'societe_b', target: 'moyen_nullite', relation: 'soutient_nullite', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'CONTESTE', source_file: sourceFile },
      { source: 'moyen_nullite', target: 'question_norme_contrat', relation: 'fonde_sur', confidence: 'INFERRED', confidence_score: 0.82, assertion_status: 'INFERRE', source_file: sourceFile },
      { source: 'question_norme_contrat', target: 'contrat_ab', relation: 'porte_sur', confidence: 'INFERRED', confidence_score: 0.75, assertion_status: 'INFERRE', source_file: sourceFile },
      { source: 'entite_inventee', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
    ],
    hyperedges: [],
  };
}

test('le graphe riche relie pièce, personnes et chaîne juridique sans exposer les noms', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let extractions = 0;

  const runner = async (command, args, options) => {
    assert.equal(command, 'graphify-test');
    assert.equal(args[0], 'extract');
    assert.ok(args.includes('--mode') && args.includes('deep'));
    assert.ok(options.env.PIECEMAKER_GRAPHIFY_LEGAL_PROMPT.endsWith('legal-graph-prompt.txt'));
    assert.match(options.env.PYTHONPATH, /bootstrap/);
    attestLegalPrompt(options);
    const corpus = args[1];
    const files = fs.readdirSync(corpus);
    const sourceFile = files.find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const input = fs.readFileSync(path.join(corpus, sourceFile), 'utf8');
    assert.match(input, /PERSONNE_PHYSIQUE_01/);
    assert.match(input, /SAS_1/);
    assert.doesNotMatch(input, /Alice Martin|BETA SAS/);
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragment(sourceFile)));
    extractions += 1;
    return { stdout: '' };
  };

  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  assert.equal(extractions, 1);
  assert.equal(built.cacheHit, false);
  assert.equal(built.graph.piecemaker.documents, 1);
  assert.equal(built.graph.piecemaker.entities, 2);
  assert.equal(built.graph.directed, false);
  assert.ok(built.graph.nodes.some((node) => node.id === 'contrat_ab'));
  assert.ok(!built.graph.nodes.some((node) => node.id === 'entite_inventee'));
  assert.ok(built.graph.edges.some((edge) => edge.relation === 'mentionne'
    && edge.target === 'personne_a'));
  assert.ok(built.graph.edges.some((edge) => edge.relation === 'documente'
    && edge.target === 'contrat_ab'));
  assert.ok(built.graph.edges.some((edge) => edge.source === 'norme_code_civil_1103'
    && edge.target === 'principe_force_obligatoire'));
  assert.ok(built.graph.edges.some((edge) => edge.source === 'contrat_ab'
    && edge.target === 'principe_force_obligatoire'
    && edge.assertion_status === 'CADRE_LEGAL'));
  assert.ok(built.graph.edges.some((edge) => edge.source === 'contrat_ab'
    && edge.target === 'principe_ordre_public'
    && edge.relation === 'soumis_a'));
  assert.equal(built.graph.nodes.find((node) => node.id === 'norme_code_civil_6').mandatory_character, 'ordre_public');
  assert.equal(built.graph.nodes.find((node) => node.id === 'fait_sans_partie').review_required, true);
  assert.equal(built.graph.edges.find((edge) => edge.source === 'personne_a' && edge.relation === 'signe').confidence_score, 1);
  assert.equal(built.graph.edges.find((edge) => edge.source === 'societe_b' && edge.relation === 'n_execute_pas').confidence_score, 0.75);
  assert.doesNotMatch(fs.readFileSync(built.graphFile, 'utf8'), /Alice Martin|BETA SAS|Contrat et assignation/);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(built.graphFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(built.graphFile)).mode & 0o777, 0o700);
  }

  const cached = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  assert.equal(cached.cacheHit, true);
  assert.equal(extractions, 1);
  assert.equal((await legalGraphStatus(data.caseRoot)).stale, false);

  fs.appendFileSync(path.join(data.workspace, 'Contrat et assignation.md'), '\nNouvel élément.');
  assert.equal((await legalGraphStatus(data.caseRoot)).stale, true);
});

test('queryLegalGraph renvoie directement le sous-graphe sélectionné par Graphify', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let queryGraph = '';
  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const output = args[args.indexOf('--out') + 1];
    const sourceFile = fs.readdirSync(args[1]).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragment(sourceFile)));
    return { stdout: '' };
  };
  const runnerQuery = async (_command, args, options) => {
    assert.deepEqual(args.slice(0, 2), ['query', 'Relie le contrat à la norme']);
    queryGraph = args[args.indexOf('--graph') + 1];
    assert.equal(args[args.indexOf('--budget') + 1], '2500');
    assert.equal(options.env.GRAPHIFY_QUERY_LOG_DISABLE, '1');
    assert.equal(options.env.LEGIFRANCE_CLIENT_SECRET, undefined);
    return { stdout: 'Sous-graphe: contrat_ab → question_norme_contrat → norme_code_civil_1162\n' };
  };

  const result = await queryLegalGraph(data.caseRoot, 'Relie le contrat à la norme', {
    budget: 2500,
    command: 'graphify-test',
    env: { LEGIFRANCE_CLIENT_SECRET: 'ne-doit-pas-sortir' },
    runner,
    runnerQuery,
  });
  assert.equal(queryGraph, result.graphFile);
  assert.match(result.output, /question_norme_contrat/);
});

test('le contexte enrichi restitue les statuts que le renderer Graphify masque', () => {
  const graph = {
    nodes: [
      { id: 'personne', label: 'SAS_1', legal_kind: 'personne', assertion_status: 'CONSTATE_DANS_PIECE', source_file: 'a.md' },
      { id: 'moyen', label: 'Moyen de nullité', legal_kind: 'argument', assertion_status: 'CONTESTE', source_file: 'a.md' },
      { id: 'piece', label: 'PIECE_123 — assignation — 2024-01-02', file_type: 'document', source_file: 'a.md' },
    ],
    edges: [
      { source: 'personne', target: 'moyen', relation: 'soutient_nullite', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'CONTESTE', source_file: 'a.md' },
    ],
  };
  const output = enrichLegalQueryOutput([
    'Traversal: BFS',
    'NODE SAS_1 [src=a.md loc= community=]',
    'NODE Moyen de nullité [src=a.md loc= community=]',
    'EDGE SAS_1 --soutient_nullite [EXTRACTED]--> Moyen de nullité',
  ].join('\n'), graph);
  assert.match(output, /LEGAL_NODE id=moyen .*statut=CONTESTE/);
  assert.match(output, /LEGAL_EDGE personne --soutient_nullite--> moyen .*statut=CONTESTE/);
  assert.match(output, /PIECE_123 — assignation — 2024-01-02/);
});

test('la topologie des personnes exclut adresses, SIREN et autres codes PII', (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legal-entities-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const topology = legalTopology(caseRoot, {
    documents: [{
      id: 'Piece.pdf',
      path: 'Piece.pdf',
      scanned: false,
      codes: [
        { code: 'PERSONNE_PHYSIQUE_01', category: 'personne' },
        { code: 'SAS_1', category: 'societe' },
        { code: 'ADRESSE_01', category: 'adresse' },
        { code: 'SIREN_01', category: 'siren' },
        { code: 'EMAIL_01', category: 'autre' },
      ],
    }],
  }, { mapping: {} });
  assert.deepEqual(topology.codes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
  assert.deepEqual(topology.documents[0].codes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
});

test('le processus Graphify ne reçoit pas les secrets MCP, Telegram ou Légifrance', () => {
  const env = legalGraphEnvironment({
    LEGIFRANCE_CLIENT_ID: 'identifiant',
    LEGIFRANCE_CLIENT_SECRET: 'secret',
    MCP_API_KEY: 'mcp',
    TELEGRAM_BOT_TOKEN: 'telegram',
    OPENAI_API_KEY: 'llm-autorise',
  }, '/tmp/bootstrap-piecemaker');
  assert.equal(env.LEGIFRANCE_CLIENT_ID, undefined);
  assert.equal(env.LEGIFRANCE_CLIENT_SECRET, undefined);
  assert.equal(env.MCP_API_KEY, undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, 'llm-autorise');
});

test('une extraction sans attestation du prompt juridique est refusée', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  await assert.rejects(
    buildLegalGraph(data.caseRoot, {
      command: 'graphify-test',
      runner: async () => ({ stdout: '' }),
    }),
    /n’a pas chargé le prompt juridique/,
  );
});

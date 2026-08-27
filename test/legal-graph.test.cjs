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
  LEGAL_FRAMEWORK_FILE,
  queryLegalGraph,
  topologySignature,
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
    // Registre des parties (§ 4 du plan) : le graphe juridique n'est
    // construit que pour les parties sélectionnées ici.
    informations_dossier: {
      parties_clientes: [{
        type: 'personne_physique',
        position: 'demandeur',
        nom: 'Alice Martin',
      }],
      parties_adverses: [{
        type: 'societe',
        position: 'defendeur',
        societe_nom: 'BETA SAS',
      }],
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

function semanticFragmentWithIsolatedNode(sourceFile) {
  const fragment = semanticFragment(sourceFile);
  // Rattaché au cadre général (jamais à la pièce), sans aucune arête ni lien
  // vers un principe du cadre statique : ce nœud n'est atteignable depuis
  // aucune partie sélectionnée et doit donc être élagué par
  // `pruneToPartyConnectivity()` (§ 7.3 du plan). `legal_kind: 'norme'` évite
  // le rattachement automatique à `index_liens_juridiques`, qui relie sinon
  // toute autre notion juridique à l'index — donc indirectement aux parties.
  fragment.nodes.push({
    id: 'notion_isolee',
    label: 'Norme sans lien avec l’affaire',
    file_type: 'concept',
    legal_kind: 'norme',
    source_file: LEGAL_FRAMEWORK_FILE,
  });
  return fragment;
}

/**
 * Fixture complète (§ 10.1 du plan) : un client demandeur et une société
 * adverse défenderesse sélectionnés, le dirigeant de cette société renseigné
 * comme représentant mais non partie, un témoin et une personne accessoire
 * détectés par GLiNER mais non sélectionnés, une partie sélectionnée absente
 * de toute pièce, une pièce ne mentionnant aucune partie sélectionnée, et des
 * données sensibles (adresse, SIREN) qui ne doivent jamais devenir des nœuds.
 */
function fixtureComplete() {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legal-graph-complet-'));
  const originalContrat = path.join(caseRoot, 'Contrat.pdf');
  const originalNote = path.join(caseRoot, 'Note interne.pdf');
  const workspace = path.join(caseRoot, WORKSPACE_SUBDIR);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(caseRoot, '.piecemaker'), { recursive: true });
  fs.writeFileSync(originalContrat, 'ORIGINAL');
  fs.writeFileSync(originalNote, 'ORIGINAL');
  fs.writeFileSync(path.join(workspace, 'Contrat.md'), [
    '# Contrat entre les parties',
    'PERSONNE_PHYSIQUE_01 a signé un contrat avec SAS_1, représentée par PERSONNE_PHYSIQUE_02.',
    'PERSONNE_PHYSIQUE_03 a assisté à la signature en qualité de témoin.',
    'SAS_1 n’a pas exécuté son obligation envers PERSONNE_PHYSIQUE_01.',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'Note interne.md'), [
    '# Note interne',
    'PERSONNE_PHYSIQUE_04 a transmis une remarque sans lien avec la procédure, concernant SIREN_01.',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'mapping_default.json'), JSON.stringify({
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
      'Marc Dupont': 'PERSONNE_PHYSIQUE_02',
      'Jean Temoin': 'PERSONNE_PHYSIQUE_03',
      'Sophie Accessoire': 'PERSONNE_PHYSIQUE_04',
      'Carla Absente': 'PERSONNE_PHYSIQUE_05',
      '12 rue de la Paix': 'ADRESSE_01',
      '123456789': 'SIREN_01',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
      PERSONNE_PHYSIQUE_02: ['Marc Dupont'],
      PERSONNE_PHYSIQUE_03: ['Jean Temoin'],
      PERSONNE_PHYSIQUE_04: ['Sophie Accessoire'],
      PERSONNE_PHYSIQUE_05: ['Carla Absente'],
      ADRESSE_01: ['12 rue de la Paix'],
      SIREN_01: ['123456789'],
    },
    // Vivier GLiNER complet (§ 1 du plan) : sert la pseudonymisation de tout
    // le corpus, pas la construction du graphe juridique riche.
    extracted_data: {
      personnes_physiques: {
        PERSONNE_PHYSIQUE_01: {},
        PERSONNE_PHYSIQUE_02: {},
        PERSONNE_PHYSIQUE_03: {},
        PERSONNE_PHYSIQUE_04: {},
        PERSONNE_PHYSIQUE_05: {},
      },
      societes: { SAS_1: {} },
      adresses: { ADRESSE_01: {} },
      siren: { SIREN_01: {} },
    },
    // Registre des parties (§ 4 du plan) : seuls Alice Martin, BETA SAS et
    // Carla Absente sont sélectionnées ; Marc Dupont n'apparaît qu'en tant que
    // représentant (`field: 'representant'`, jamais `'identite'`), donc il ne
    // devient pas une partie.
    informations_dossier: {
      parties_clientes: [
        { type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin' },
        { type: 'personne_physique', position: 'demandeur', nom: 'Carla Absente' },
      ],
      parties_adverses: [{
        type: 'societe',
        position: 'defendeur',
        societe_nom: 'BETA SAS',
        mapping_assignments: [{ field: 'representant', code: 'PERSONNE_PHYSIQUE_02' }],
      }],
    },
  }));
  fs.writeFileSync(documentIndexFile(caseRoot), JSON.stringify({
    version: 1,
    documents: {
      [stateKey('Contrat.pdf')]: {
        nature: 'contrat',
        nature_confidence: 1,
        doc_date: '2 janvier 2024',
        doc_date_iso: '2024-01-02',
        juridiction: null,
        codes: ['PERSONNE_PHYSIQUE_01', 'SAS_1', 'PERSONNE_PHYSIQUE_02', 'PERSONNE_PHYSIQUE_03', 'ADRESSE_01'],
        updatedAt: '2026-08-25T00:00:00Z',
      },
      [stateKey('Note interne.pdf')]: {
        nature: 'note',
        nature_confidence: 1,
        doc_date: '5 janvier 2024',
        doc_date_iso: '2024-01-05',
        juridiction: null,
        codes: ['PERSONNE_PHYSIQUE_04', 'SIREN_01'],
        updatedAt: '2026-08-25T00:00:00Z',
      },
    },
  }));
  markFilesAnonymized(caseRoot, [originalContrat, originalNote], '2026-08-25T00:00:00Z');
  return { caseRoot, originalContrat, originalNote, workspace };
}

/**
 * Fragment Graphify pour la fixture complète : une seule pièce est retenue
 * (Contrat.pdf), donc un seul `sourceFile`. Le dirigeant et le témoin sont
 * envoyés par le modèle comme des nœuds `legal_kind: 'personne'` — ils
 * doivent être rejetés par `finalizeLegalGraph()` tant qu'ils ne figurent
 * pas dans le registre des parties (§ 7.1 et 7.4 du plan).
 */
function semanticFragmentComplete(sourceFile) {
  return {
    input_tokens: 900,
    output_tokens: 400,
    nodes: [
      { id: 'piece_source', label: 'Nom de fichier inventé', file_type: 'document', legal_kind: 'document', source_file: sourceFile },
      { id: 'personne_a', label: 'PERSONNE_PHYSIQUE_01', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      { id: 'societe_b', label: 'SAS_1', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      // Dirigeant renseigné comme représentant, non partie : doit être rejeté.
      { id: 'dirigeant_c', label: 'PERSONNE_PHYSIQUE_02', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      // Témoin détecté par GLiNER mais non sélectionné : doit être rejeté.
      { id: 'temoin_d', label: 'PERSONNE_PHYSIQUE_03', file_type: 'concept', legal_kind: 'personne', source_file: sourceFile },
      { id: 'contrat_ab', label: 'Contrat entre les parties', file_type: 'concept', legal_kind: 'contrat', source_file: sourceFile, assertion_status: 'ETABLI_PAR_ACTE' },
      { id: 'obligation_b', label: 'Obligation contractuelle de SAS_1', file_type: 'concept', legal_kind: 'obligation', source_file: sourceFile },
      // Rattaché au cadre général (jamais à la pièce) et sans arête : doit
      // être élagué par `pruneToPartyConnectivity()` (§ 7.3 du plan).
      {
        id: 'notion_isolee',
        label: 'Norme sans lien avec l’affaire',
        file_type: 'concept',
        legal_kind: 'norme',
        source_file: LEGAL_FRAMEWORK_FILE,
      },
    ],
    edges: [
      { source: 'personne_a', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'ETABLI_PAR_ACTE', source_file: sourceFile },
      { source: 'societe_b', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 1, assertion_status: 'ETABLI_PAR_ACTE', source_file: sourceFile },
      { source: 'contrat_ab', target: 'obligation_b', relation: 'cree_obligation', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'obligation_b', target: 'societe_b', relation: 'a_pour_debiteur', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'obligation_b', target: 'personne_a', relation: 'a_pour_creancier', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
      { source: 'dirigeant_c', target: 'contrat_ab', relation: 'signe', confidence: 'EXTRACTED', confidence_score: 1, source_file: sourceFile },
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
  const demandeur = built.graph.nodes.find((node) => node.label === 'PERSONNE_PHYSIQUE_01');
  assert.ok(built.graph.edges.some((edge) => edge.relation === 'mentionne'
    && edge.target === demandeur?.id));
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
  assert.ok(built.graph.edges.some((edge) => edge.relation === 'signe' && edge.confidence_score === 1));
  assert.ok(built.graph.edges.some((edge) => edge.relation === 'n_execute_pas' && edge.confidence_score === 0.75));
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
  const mappingDocument = {
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
    },
    informations_dossier: {
      parties_clientes: [{ type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin' }],
      parties_adverses: [{ type: 'societe', position: 'defendeur', societe_nom: 'BETA SAS' }],
    },
  };
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
  }, mappingDocument);
  assert.equal(topology.registry.status, 'ready');
  assert.deepEqual(topology.codes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
  assert.deepEqual(topology.documents[0].codes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
  assert.deepEqual(topology.documents[0].partyCodes, ['PERSONNE_PHYSIQUE_01', 'SAS_1']);
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

test('la topologie écarte du corpus une pièce sans partie sélectionnée mentionnée', (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legal-excluded-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const mappingDocument = {
    mapping: {
      'Alice Martin': 'PERSONNE_PHYSIQUE_01',
      'BETA SAS': 'SAS_1',
    },
    reverse_mapping: {
      PERSONNE_PHYSIQUE_01: ['Alice Martin'],
      SAS_1: ['BETA SAS'],
    },
    informations_dossier: {
      parties_clientes: [{ type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin' }],
      parties_adverses: [{ type: 'societe', position: 'defendeur', societe_nom: 'BETA SAS' }],
    },
  };
  const chronology = {
    documents: [
      {
        id: 'Piece-mentionnee.pdf',
        path: 'Piece-mentionnee.pdf',
        scanned: false,
        codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne' }],
      },
      {
        id: 'Piece-hors-perimetre.pdf',
        path: 'Piece-hors-perimetre.pdf',
        scanned: false,
        codes: [{ code: 'PERSONNE_PHYSIQUE_99', category: 'personne' }],
      },
    ],
  };
  const topology = legalTopology(caseRoot, chronology, mappingDocument);
  assert.equal(topology.registry.status, 'ready');
  assert.equal(topology.documents.length, 1);
  assert.equal(topology.documents[0].key, stateKey('Piece-mentionnee.pdf'));
  assert.deepEqual(topology.excludedDocuments, [
    { key: stateKey('Piece-hors-perimetre.pdf'), reason: 'aucune_partie_selectionnee' },
  ]);
});

test('buildLegalGraph refuse un dossier sans pièce mentionnant une partie sélectionnée', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  fs.writeFileSync(documentIndexFile(data.caseRoot), JSON.stringify({
    version: 1,
    documents: {
      [stateKey('Contrat et assignation.pdf')]: {
        nature: 'assignation',
        nature_confidence: 1,
        doc_date: '2 janvier 2024',
        doc_date_iso: '2024-01-02',
        juridiction: null,
        codes: ['PERSONNE_PHYSIQUE_99'],
        updatedAt: '2026-08-25T00:00:00Z',
      },
    },
  }));
  await assert.rejects(
    buildLegalGraph(data.caseRoot, {
      command: 'graphify-test',
      runner: async () => ({ stdout: '' }),
    }),
    /no_party_documents/,
  );
});

test('une partie sélectionnée absente des pièces reste dans le graphe, signalée pour révision', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const mappingFile = path.join(data.workspace, 'mapping_default.json');
  const mappingDocument = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  mappingDocument.mapping['Carla Absente'] = 'PERSONNE_PHYSIQUE_02';
  mappingDocument.reverse_mapping.PERSONNE_PHYSIQUE_02 = ['Carla Absente'];
  mappingDocument.informations_dossier.parties_adverses.push({
    type: 'personne_physique',
    position: 'defendeur',
    nom: 'Carla Absente',
  });
  fs.writeFileSync(mappingFile, JSON.stringify(mappingDocument));

  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const sourceFile = fs.readdirSync(args[1]).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragment(sourceFile)));
    return { stdout: '' };
  };

  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  const absentNode = built.graph.nodes.find((node) => node.label === 'PERSONNE_PHYSIQUE_02');
  assert.ok(absentNode);
  assert.equal(absentNode.review_required, true);
  assert.ok(absentNode.review_reasons.includes('partie_absente_des_pieces'));
  assert.ok(built.graph.piecemaker.selectedPartiesWithoutMention.includes('PERSONNE_PHYSIQUE_02'));
});

test('un concept sans lien avec les parties est élagué du graphe final', async (t) => {
  const data = fixture();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const sourceFile = fs.readdirSync(args[1]).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(graphDirectory, 'graph.json'),
      JSON.stringify(semanticFragmentWithIsolatedNode(sourceFile)),
    );
    return { stdout: '' };
  };
  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  assert.ok(!built.graph.nodes.some((node) => node.id === 'notion_isolee'));
  assert.ok(built.graph.piecemaker.prunedDisconnectedNodes > 0);
});

test('changer la position d’une partie invalide la signature de la topologie', (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-legal-signature-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const chronology = {
    documents: [{
      id: 'Piece.pdf',
      path: 'Piece.pdf',
      scanned: false,
      codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne' }],
    }],
  };
  const mappingDocumentDemandeur = {
    mapping: { 'Alice Martin': 'PERSONNE_PHYSIQUE_01' },
    reverse_mapping: { PERSONNE_PHYSIQUE_01: ['Alice Martin'] },
    informations_dossier: {
      parties_clientes: [{ type: 'personne_physique', position: 'demandeur', nom: 'Alice Martin' }],
    },
  };
  const mappingDocumentDefendeur = {
    ...mappingDocumentDemandeur,
    informations_dossier: {
      parties_clientes: [{ type: 'personne_physique', position: 'defendeur', nom: 'Alice Martin' }],
    },
  };
  const topologyDemandeur = legalTopology(caseRoot, chronology, mappingDocumentDemandeur);
  const topologyDefendeur = legalTopology(caseRoot, chronology, mappingDocumentDefendeur);
  assert.notEqual(topologySignature(topologyDemandeur), topologySignature(topologyDefendeur));
});

test('fixture complète : seules les parties sélectionnées deviennent des nœuds centraux', async (t) => {
  const data = fixtureComplete();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  let mdFileCount = 0;

  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const files = fs.readdirSync(args[1]);
    const mdFiles = files.filter((file) => /^[a-f0-9]{64}\.md$/.test(file));
    // Seule la pièce mentionnant une partie sélectionnée (Contrat.pdf) entre
    // dans le corpus ; Note interne.pdf, qui n'en mentionne aucune, n'y
    // figure jamais (§ 6.2 du plan).
    mdFileCount = mdFiles.length;
    const sourceFile = mdFiles[0];
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragmentComplete(sourceFile)));
    return { stdout: '' };
  };

  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });

  assert.equal(mdFileCount, 1);

  const partyLabels = built.graph.nodes
    .filter((node) => node.is_key_party === true)
    .map((node) => node.label)
    .sort();
  assert.deepEqual(partyLabels, ['PERSONNE_PHYSIQUE_01', 'PERSONNE_PHYSIQUE_05', 'SAS_1']);

  assert.ok(!built.graph.nodes.some((node) => node.label === 'PERSONNE_PHYSIQUE_02'));
  assert.ok(!built.graph.nodes.some((node) => node.label === 'PERSONNE_PHYSIQUE_03'));
  assert.ok(!built.graph.nodes.some((node) => node.label === 'PERSONNE_PHYSIQUE_04'));

  // La couche documentaire matérialisée conserve tout original ; seul le
  // corpus sémantique reste réduit à la pièce reliée aux parties sélectionnées.
  assert.equal(built.graph.piecemaker.documents, 2);
  assert.equal(built.graph.nodes.filter((node) => node.file_type === 'document').length, 2);
  const excludedKey = stateKey('Note interne.pdf');
  assert.ok(built.graph.piecemaker.excludedDocuments.includes(excludedKey));
  const excludedDocument = built.graph.nodes.find((node) => node.source_file === `${excludedKey}.md`);
  assert.ok(excludedDocument);
  assert.equal(excludedDocument.semantic_scope, 'excluded');

  const absentNode = built.graph.nodes.find((node) => node.label === 'PERSONNE_PHYSIQUE_05');
  assert.ok(absentNode);
  assert.equal(absentNode.review_required, true);
  assert.ok(absentNode.review_reasons.includes('partie_absente_des_pieces'));
  assert.ok(built.graph.piecemaker.selectedPartiesWithoutMention.includes('PERSONNE_PHYSIQUE_05'));

  const serialized = fs.readFileSync(built.graphFile, 'utf8');
  for (const clearName of [
    'Alice Martin', 'BETA SAS', 'Marc Dupont', 'Jean Temoin',
    'Sophie Accessoire', 'Carla Absente', '12 rue de la Paix',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(clearName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('invariant global : tout nœud métier du résultat possède un chemin vers une partie sélectionnée', async (t) => {
  const data = fixtureComplete();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const sourceFile = fs.readdirSync(args[1]).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragmentComplete(sourceFile)));
    return { stdout: '' };
  };
  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });

  const adjacency = new Map(built.graph.nodes.map((node) => [node.id, new Set()]));
  for (const edge of built.graph.edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  }
  const seeds = built.graph.nodes.filter((node) => node.is_key_party === true).map((node) => node.id);
  const reachable = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) || []) {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const businessNodes = built.graph.nodes.filter((node) =>
    node.legal_kind
    && !['document', 'norme', 'procedure'].includes(node.legal_kind)
    && !node.id.startsWith('index_'));
  assert.ok(businessNodes.length > 0);
  for (const node of businessNodes) {
    assert.ok(reachable.has(node.id), `nœud ${node.id} (${node.legal_kind}) non relié à une partie sélectionnée`);
  }
});

test('un dirigeant ajouté séparément comme partie devient un nœud central', async (t) => {
  const data = fixtureComplete();
  t.after(() => fs.rmSync(data.caseRoot, { recursive: true, force: true }));
  const mappingFile = path.join(data.workspace, 'mapping_default.json');
  const mappingDocument = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  // Marc Dupont était jusque-là seulement représentant de la société adverse
  // (§ 2 du plan) ; l'ajouter séparément comme partie cliente en fait une
  // partie à part entière, au même titre que toute autre partie choisie.
  mappingDocument.informations_dossier.parties_clientes.push({
    type: 'personne_physique',
    position: 'demandeur',
    nom: 'Marc Dupont',
  });
  fs.writeFileSync(mappingFile, JSON.stringify(mappingDocument));

  const runner = async (_command, args, options) => {
    attestLegalPrompt(options);
    const sourceFile = fs.readdirSync(args[1]).find((file) => /^[a-f0-9]{64}\.md$/.test(file));
    const output = args[args.indexOf('--out') + 1];
    const graphDirectory = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDirectory, { recursive: true });
    fs.writeFileSync(path.join(graphDirectory, 'graph.json'), JSON.stringify(semanticFragmentComplete(sourceFile)));
    return { stdout: '' };
  };

  const built = await buildLegalGraph(data.caseRoot, { command: 'graphify-test', runner });
  const dirigeant = built.graph.nodes.find((node) => node.label === 'PERSONNE_PHYSIQUE_02');
  assert.ok(dirigeant);
  assert.equal(dirigeant.is_key_party, true);
  assert.equal(dirigeant.procedural_role, 'demandeur');
});

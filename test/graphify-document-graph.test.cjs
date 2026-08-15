const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  GRAPHIFY_CACHE_RELATIVE,
  buildGraphifyDocumentGraph,
  graphifyEnvironment,
} = require('../websocket-server/graphify-document-graph.cjs');
const { stateKey } = require('../piecemaker-plugin/scripts/lib/anonymization-state.cjs');

function chronologyFixture() {
  return {
    documents: [
      {
        id: 'Assignation Bernard.pdf', path: 'Assignation Bernard.pdf', name: 'Assignation Bernard.pdf',
        nature: 'assignation', dateIso: '2024-01-02', protected: true,
        codes: [
          { code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Bernard Gilly' },
          { code: 'PERSONNE_MORALE_01', category: 'societe', label: 'Société du Parc' },
        ],
      },
      {
        id: 'Courrier.pdf', path: 'Courrier.pdf', name: 'Courrier.pdf',
        nature: 'courrier', dateIso: '2024-01-03', protected: false,
        codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Bernard Gilly' }],
      },
    ],
    entities: [
      { code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Bernard Gilly', documentCount: 2 },
      { code: 'PERSONNE_MORALE_01', category: 'societe', label: 'Société du Parc', documentCount: 1 },
    ],
  };
}

test('Graphify construit le graphe depuis les seuls hash et codes GLiNER, sans LLM', async (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-test-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const chronology = chronologyFixture();
  let extractCalls = 0;
  let viewerCalls = 0;
  let temporaryViewerGraph = '';

  const runner = async (command, args, options) => {
    assert.equal(command, 'graphify-test');
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_BASE_URL']) {
      assert.equal(options.env[key], undefined);
    }
    if (args[0] === 'cluster-only') {
      viewerCalls += 1;
      assert.ok(args.includes('--no-label'));
      const graphFile = args[args.indexOf('--graph') + 1];
      temporaryViewerGraph = graphFile;
      const viewerInput = fs.readFileSync(graphFile, 'utf8');
      assert.match(viewerInput, /Bernard Gilly|Société du Parc|Assignation Bernard/);
      assert.doesNotMatch(graphFile, new RegExp(GRAPHIFY_CACHE_RELATIVE));
      fs.writeFileSync(path.join(path.dirname(graphFile), 'graph.html'), `<!doctype html>
<script src="https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js"
        integrity="sha384-Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1"
        crossorigin="anonymous"></script>
<div id="graph"></div><script>new vis.Network(document.getElementById('graph'), {}, {});</script>`);
      return;
    }

    extractCalls += 1;
    assert.ok(args.includes('--code-only'));
    assert.ok(args.includes('--no-cluster'));
    assert.equal(args[args.indexOf('--entity-map-labels') + 1], 'canonical');

    const corpus = args[1];
    const entityMap = args[args.indexOf('--entity-map') + 1];
    const output = args[args.indexOf('--out') + 1];
    const files = fs.readdirSync(corpus).sort();
    const firstKey = stateKey('Assignation Bernard.pdf');
    const secondKey = stateKey('Courrier.pdf');
    assert.deepEqual(files, [`${firstKey}.md`, `${secondKey}.md`].sort());
    const privateInputs = files.map((file) => fs.readFileSync(path.join(corpus, file), 'utf8')).join('\n')
      + fs.readFileSync(entityMap, 'utf8');
    assert.doesNotMatch(privateInputs, /Bernard Gilly|Société du Parc|Assignation Bernard/);
    assert.match(privateInputs, /PERSONNE_PHYSIQUE_01/);

    const graphDir = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify({
      input_tokens: 0,
      output_tokens: 0,
      nodes: [
        { id: 'doc-a', file_type: 'document', source_file: `${firstKey}.md`, label: `${firstKey}.md` },
        { id: 'doc-b', file_type: 'document', source_file: `${secondKey}.md`, label: `${secondKey}.md` },
        { id: 'entity-person', file_type: 'concept', label: 'PERSONNE_PHYSIQUE_01' },
        { id: 'entity-company', file_type: 'concept', label: 'PERSONNE_MORALE_01' },
      ],
      edges: [
        { source: 'doc-a', target: 'entity-person', relation: 'references' },
        { source: 'doc-a', target: 'entity-company', relation: 'references' },
        { source: 'doc-b', target: 'entity-person', relation: 'references' },
      ],
    }, null, 2));
  };

  const graph = await buildGraphifyDocumentGraph(caseRoot, chronology, {
    command: 'graphify-test', runner,
  });
  assert.equal(graph.engine, 'graphify');
  assert.equal(graph.source, 'gliner-document-index');
  assert.equal(graph.llm, false);
  assert.equal(graph.inputTokens, 0);
  assert.equal(graph.outputTokens, 0);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.nodes.filter((node) => node.kind === 'entity').length, 2);
  assert.equal(graph.nodes.find((node) => node.code === 'PERSONNE_PHYSIQUE_01').label, 'Bernard Gilly');
  assert.match(graph.viewerHtml, /src="\/admin\/vendor\/vis-network\.min\.js"/);
  assert.match(graph.viewerHtml, /new vis\.Network/);
  assert.doesNotMatch(graph.viewerHtml, /unpkg\.com/);
  assert.equal(fs.existsSync(temporaryViewerGraph), false);

  const cache = path.join(caseRoot, ...GRAPHIFY_CACHE_RELATIVE.split('/'), 'graph.json');
  const persisted = fs.readFileSync(cache, 'utf8');
  assert.doesNotMatch(persisted, /Bernard Gilly|Société du Parc|Assignation Bernard/);

  // La deuxième lecture rejoint de nouveau les libellés en mémoire, mais ne
  // relance pas Graphify tant que la topologie GLiNER est inchangée.
  const cached = await buildGraphifyDocumentGraph(caseRoot, chronology, {
    command: 'graphify-test', runner,
  });
  assert.equal(extractCalls, 1);
  assert.equal(viewerCalls, 2);
  assert.equal(cached.cacheHit, true);
  assert.equal(cached.edges.length, 3);
  assert.match(cached.viewerHtml, /new vis\.Network/);
});

test('l’environnement Graphify retire explicitement toutes les clés de modèles', () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'secret-test';
  try {
    assert.equal(graphifyEnvironment().OPENAI_API_KEY, undefined);
  } finally {
    if (previous == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test('une sortie Graphify qui déclare des tokens LLM est refusée', async (t) => {
  const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-graphify-token-test-'));
  t.after(() => fs.rmSync(caseRoot, { recursive: true, force: true }));
  const runner = async (_command, args) => {
    const output = args[args.indexOf('--out') + 1];
    const graphDir = path.join(output, 'graphify-out');
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, 'graph.json'), JSON.stringify({
      input_tokens: 1, output_tokens: 0, nodes: [], edges: [],
    }));
  };

  await assert.rejects(
    buildGraphifyDocumentGraph(caseRoot, chronologyFixture(), { command: 'graphify-test', runner }),
    /étape LLM interdite/,
  );
});

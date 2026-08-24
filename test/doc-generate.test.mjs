import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findPandoc,
  findTypst,
  chooseChain,
  pandocArgs,
  metadataYaml,
  applyA4PageLayoutXml,
  generateDocument,
} = require('../websocket-server/lib/doc-generate.cjs');
const { renderHistoryHtml } = require('../websocket-server/lib/export-render.cjs');

const MIN = 60 * 1000;

// --- chooseChain : table de vérité --------------------------------------
// Ce test protège l'invariant central de la bascule : l'absence de pandoc
// ne doit JAMAIS empêcher un export, LibreOffice reste un repli complet
// pour les deux formats. Et typst n'a d'effet que sur le PDF : un poste
// avec pandoc mais sans typst produit quand même du DOCX via pandoc seul.
test('chooseChain — DOCX : pandoc présent choisit pandoc, sinon repli LibreOffice (typst sans effet)', () => {
  assert.equal(chooseChain({ pandoc: true, typst: true, format: 'docx' }), 'pandoc');
  assert.equal(chooseChain({ pandoc: true, typst: false, format: 'docx' }), 'pandoc');
  assert.equal(chooseChain({ pandoc: false, typst: true, format: 'docx' }), 'soffice');
  assert.equal(chooseChain({ pandoc: false, typst: false, format: 'docx' }), 'soffice');
});

test('chooseChain — PDF : les quatre combinaisons pandoc/typst', () => {
  // pandoc + typst : chaîne complète, PDF rendu par typst.
  assert.equal(chooseChain({ pandoc: true, typst: true, format: 'pdf' }), 'pandoc-typst');
  // pandoc seul : le moteur PDF de pandoc manque, LibreOffice prend le relai
  // pour la seule étape HTML -> PDF (pandoc reste inutile ici, mais la
  // combinaison existe dans la table de vérité fournie par le contrat).
  assert.equal(chooseChain({ pandoc: true, typst: false, format: 'pdf' }), 'pandoc-soffice');
  // pas de pandoc du tout : jamais bloquant, repli LibreOffice intégral,
  // même si typst est présent (typst seul ne sait pas partir de HTML ici).
  assert.equal(chooseChain({ pandoc: false, typst: true, format: 'pdf' }), 'soffice');
  assert.equal(chooseChain({ pandoc: false, typst: false, format: 'pdf' }), 'soffice');
});

// --- pandocArgs -----------------------------------------------------------
test('pandocArgs — sortie DOCX : pas de --pdf-engine, --metadata-file présent, source en dernier', () => {
  const args = pandocArgs('/tmp/travail/doc.html', '/tmp/travail/sortie.docx', {
    metadataPath: '/tmp/travail/metadata.yaml',
    typst: '/opt/homebrew/bin/typst',
  });
  assert.deepEqual(args, [
    '--from=html',
    '--to=docx',
    // Neutralise la métadonnée de titre lue dans <title> : sans elle, pandoc
    // compose le titre sous le style "Title" en plus du <h1> du corps, et le
    // document sort avec son titre en double (vérifié sur la sortie réelle).
    '--metadata', 'title=',
    '--metadata-file', '/tmp/travail/metadata.yaml',
    '--output', '/tmp/travail/sortie.docx',
    '/tmp/travail/doc.html',
  ]);
  assert.ok(!args.some((a) => a.startsWith('--pdf-engine')), '--pdf-engine ne doit jamais apparaître pour un .docx');
  assert.equal(args[args.length - 1], '/tmp/travail/doc.html', 'le fichier source est le dernier argument');
});

test('pandocArgs — sortie PDF : --pdf-engine porte le chemin complet de typst, pas son seul nom', () => {
  // Piège réel déjà rencontré : typst peut être trouvé via TYPST_PATH sans
  // être sur le PATH du process qui lance pandoc. Si on passait "typst" nu,
  // pandoc échouerait à le localiser alors que findTypst() l'a bien trouvé.
  const args = pandocArgs('/tmp/travail/doc.html', '/tmp/travail/sortie.pdf', {
    metadataPath: '/tmp/travail/metadata.yaml',
    typst: '/opt/homebrew/bin/typst',
  });
  assert.deepEqual(args, [
    '--from=html',
    '--to=pdf',
    '--pdf-engine=/opt/homebrew/bin/typst',
    '--metadata', 'title=',
    '--metadata-file', '/tmp/travail/metadata.yaml',
    '--output', '/tmp/travail/sortie.pdf',
    '/tmp/travail/doc.html',
  ]);
  assert.equal(args[args.length - 1], '/tmp/travail/doc.html', 'le fichier source est le dernier argument');
});

test('pandocArgs — aucun argument entouré de guillemets (spawn sans shell)', () => {
  // spawn() ne passe pas par un shell : un guillemet littéral dans un
  // argument finirait tel quel dans le nom du fichier produit (piège déjà
  // vu sur sofficeArgs dans office-to-pdf.cjs). Un chemin avec espace doit
  // rester un seul élément du tableau, jamais entre guillemets.
  const args = pandocArgs('/tmp/dossier avec espace/doc.html', '/tmp/dossier avec espace/sortie.pdf', {
    metadataPath: '/tmp/dossier avec espace/metadata.yaml',
    typst: '/opt/homebrew/bin/typst',
  });
  for (const arg of args) {
    assert.ok(!arg.includes('"'), `argument entre guillemets détecté : ${arg}`);
    assert.ok(!arg.startsWith("'") && !arg.endsWith("'"), `argument entre apostrophes détecté : ${arg}`);
  }
  // Le chemin à espace reste un seul élément du tableau (pas de découpage).
  assert.ok(args.includes('/tmp/dossier avec espace/doc.html'));
});

// --- metadataYaml -----------------------------------------------------------
// Le lecteur HTML de pandoc jette intégralement le CSS, y compris les
// règles @page : sans ce YAML de métadonnées, le PDF produit par typst
// n'aurait ni format A4, ni marges, ni numérotation de page.
test('metadataYaml — contient les clés de mise en page attendues par le moteur typst', () => {
  const yaml = metadataYaml();
  assert.match(yaml, /papersize:\s*a4/);
  assert.match(yaml, /margin/);
  assert.match(yaml, /lang:\s*fr/);
  assert.match(yaml, /page-numbering:\s*"1"/);
});

test('applyA4PageLayoutXml — remplace le format Letter et les marges Word par A4 / 2 cm', () => {
  const xml = '<w:document><w:body><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const result = applyA4PageLayoutXml(xml);
  assert.match(result, /<w:pgSz w:w="11906" w:h="16838"\/>/);
  assert.match(result, /<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/);
  assert.doesNotMatch(result, /w:w="12240"|w:h="15840"|w:top="1440"/);
});

test('applyA4PageLayoutXml — ajoute les éléments de mise en page absents', () => {
  const result = applyA4PageLayoutXml('<w:document><w:body><w:sectPr><w:cols w:space="720"/></w:sectPr></w:body></w:document>');
  assert.match(result, /<w:pgSz w:w="11906" w:h="16838"\/><w:pgMar/);
  assert.match(result, /<w:cols w:space="720"\/>/);
});

// --- findPandoc / findTypst ---------------------------------------------
// Test volontairement peu contraignant : il doit passer sur n'importe
// quelle machine, avec ou sans les binaires installés.
test('findPandoc / findTypst — renvoient null ou une chaîne non vide, jamais autre chose', () => {
  const pandoc = findPandoc();
  const typst = findTypst();
  assert.ok(pandoc === null || (typeof pandoc === 'string' && pandoc.length > 0));
  assert.ok(typst === null || (typeof typst === 'string' && typst.length > 0));
});

// --- Intégration pandoc -> DOCX ------------------------------------------
function hasUnzip() {
  const result = spawnSync('unzip', ['-v']);
  return result.status === 0;
}

test('generateDocument — pandoc produit un vrai DOCX avec styles Word (Heading1), pas du texte grossi', async (t) => {
  const pandoc = findPandoc();
  if (!pandoc) return t.skip('pandoc non installé sur cette machine');
  if (!hasUnzip()) return t.skip('unzip absent, impossible de vérifier le contenu du DOCX');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piecemaker-doc-generate-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const entries = [
    {
      hash: 'h1', shortHash: 'h1', author: 'Ted', timestamp: '2026-08-22T10:00:00Z',
      subject: 'Recherche juridique', comment: 'Analyse de la jurisprudence.',
      sessionId: 's1', durationMs: 5 * MIN, files: ['a.md'], filesCount: 1,
    },
  ];
  const html = renderHistoryHtml(entries, { caseName: 'Dupont c/ Martin', month: '2026-08' });

  const result = await generateDocument(html, dir, { format: 'docx' });
  assert.equal(result.engine, 'pandoc');
  assert.ok(fs.existsSync(result.path), 'le fichier DOCX doit exister');

  // Un .docx est un ZIP : signature PK\x03\x04 en tête de fichier.
  const header = Buffer.alloc(4);
  const fd = fs.openSync(result.path, 'r');
  fs.readSync(fd, header, 0, 4, 0);
  fs.closeSync(fd);
  assert.equal(header.toString('latin1'), 'PK\x03\x04');

  // LE gain de la bascule vers pandoc : un vrai style Word "Heading1", là où
  // LibreOffice ne produisait que du texte visuellement grossi sans style.
  const extraction = spawnSync('unzip', ['-p', result.path, 'word/document.xml']);
  assert.equal(extraction.status, 0, 'extraction de word/document.xml échouée');
  const documentXml = extraction.stdout.toString('utf8');
  assert.match(documentXml, /<w:pgSz w:w="11906" w:h="16838"\/>/, 'le document Word doit être en A4 portrait');
  assert.match(documentXml, /<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/, 'les marges Word doivent être de 2 cm');
  assert.match(documentXml, /w:pStyle[^>]*w:val="Heading1"/, 'aucun style Heading1 trouvé dans le document.xml produit');

  // Le gabarit porte le titre deux fois : dans <title> et dans le <h1>. pandoc
  // lit le <title> comme métadonnée et le compose sous le style "Title", juste
  // avant le Heading1 — le titre sortait donc en double. `--metadata title=`
  // (pandocArgs) neutralise la métadonnée ; on vérifie ici le résultat réel,
  // car c'est un défaut invisible en test unitaire d'arguments.
  assert.doesNotMatch(documentXml, /w:pStyle[^>]*w:val="Title"/, 'le style Title réapparaît : le titre est composé en double');
  const occurrences = documentXml.split('Feuille de temps').length - 1;
  assert.equal(occurrences, 1, `le titre doit apparaître une seule fois, vu ${occurrences} fois`);
  assert.match(documentXml, /Auteur : Ted/, 'le nom de l’auteur doit apparaître sous le titre');
  assert.match(documentXml, /Tâches réalisées/, 'le nouveau libellé de colonne doit être conservé');
  assert.match(documentXml, /Analyse de la jurisprudence\./, 'le commentaire du commit doit être conservé');
  assert.match(documentXml, /a\.md/, 'la liste des fichiers modifiés doit être conservée');
});

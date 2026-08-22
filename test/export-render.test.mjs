import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  escapeHtml,
  documentHtml,
  formatDateFr,
  decumulateDurations,
  renderChronologyHtml,
  renderHistoryHtml,
} = require('../websocket-server/lib/export-render.cjs');
const { formatDurationFr } = require('../piecemaker-plugin/scripts/lib/session-timing.cjs');

const MIN = 60 * 1000;

test('decumulateDurations — une session à 5/12/20 min donne 5/7/8 min, somme = 20 min', () => {
  const entries = [
    { sessionId: 's1', timestamp: '2026-08-22T10:00:00Z', durationMs: 5 * MIN },
    { sessionId: 's1', timestamp: '2026-08-22T10:07:00Z', durationMs: 12 * MIN },
    { sessionId: 's1', timestamp: '2026-08-22T10:15:00Z', durationMs: 20 * MIN },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[0].ownMs, 5 * MIN);
  assert.equal(result[1].ownMs, 7 * MIN);
  assert.equal(result[2].ownMs, 8 * MIN);
  const total = result.reduce((sum, r) => sum + r.ownMs, 0);
  assert.equal(total, 20 * MIN);
});

test('decumulateDurations — horodatages identiques : le cumul départage, pas l\'ordre de git log', () => {
  // Cas réel : deux actes commités dans la même seconde (git horodate à la
  // seconde), rendus par `git log` du plus récent au plus ancien. Sans
  // départage par le cumul, tout le temps était imputé au premier de la liste
  // et l'acte antérieur retombait à 0.
  const entries = [
    { sessionId: 's1', timestamp: '2026-08-22T11:54:00Z', durationMs: 12 * MIN },
    { sessionId: 's1', timestamp: '2026-08-22T11:54:00Z', durationMs: 5 * MIN },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[1].ownMs, 5 * MIN, 'l\'acte au cumul le plus faible vient en premier');
  assert.equal(result[0].ownMs, 7 * MIN, 'le suivant ne porte que son propre écart');
  assert.equal(result.reduce((sum, r) => sum + r.ownMs, 0), 12 * MIN);
});

test('decumulateDurations — commit sans sessionId forme sa propre session', () => {
  const entries = [
    { sessionId: '', timestamp: '2026-08-22T10:00:00Z', durationMs: 9 * MIN },
    { sessionId: null, timestamp: '2026-08-22T11:00:00Z', durationMs: 3 * MIN },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[0].ownMs, 9 * MIN);
  assert.equal(result[1].ownMs, 3 * MIN);
});

test('decumulateDurations — commit sans durationMs donne ownMs = 0 sans casser le total', () => {
  const entries = [
    { sessionId: 's1', timestamp: '2026-08-22T10:00:00Z', durationMs: 5 * MIN },
    { sessionId: 's1', timestamp: '2026-08-22T10:05:00Z', durationMs: null },
    { sessionId: 's1', timestamp: '2026-08-22T10:10:00Z', durationMs: 10 * MIN },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[0].ownMs, 5 * MIN);
  // durationMs null traité comme 0 -> écart négatif (0 - 5min) ramené à 0
  assert.equal(result[1].ownMs, 0);
  // le commit suivant repart du cumul réel précédent (5 min), pas de 0 : ce
  // n'est que l'ownMs du commit à durationMs=null qui est ramené à 0.
  assert.equal(result[2].ownMs, 5 * MIN);
});

test('decumulateDurations — commit totalement sans durationMs -> ownMs = 0', () => {
  const entries = [
    { sessionId: '', timestamp: '2026-08-22T10:00:00Z', durationMs: null },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[0].ownMs, 0);
});

test('decumulateDurations — écart négatif (reprise de session) ramené à 0', () => {
  const entries = [
    { sessionId: 's1', timestamp: '2026-08-22T10:00:00Z', durationMs: 15 * MIN },
    // Le compteur repart plus bas : reprise de session, jamais retranché.
    { sessionId: 's1', timestamp: '2026-08-22T10:05:00Z', durationMs: 4 * MIN },
  ];
  const result = decumulateDurations(entries);
  assert.equal(result[0].ownMs, 15 * MIN);
  assert.equal(result[1].ownMs, 0);
});

test('decumulateDurations — deux sessions entrelacées restent séparées', () => {
  const entries = [
    { sessionId: 'a', timestamp: '2026-08-22T10:00:00Z', durationMs: 5 * MIN },
    { sessionId: 'b', timestamp: '2026-08-22T10:01:00Z', durationMs: 2 * MIN },
    { sessionId: 'a', timestamp: '2026-08-22T10:10:00Z', durationMs: 12 * MIN },
    { sessionId: 'b', timestamp: '2026-08-22T10:11:00Z', durationMs: 9 * MIN },
  ];
  const result = decumulateDurations(entries);
  // session a : 5, puis 12-5=7
  assert.equal(result[0].ownMs, 5 * MIN);
  assert.equal(result[2].ownMs, 7 * MIN);
  // session b : 2, puis 9-2=7
  assert.equal(result[1].ownMs, 2 * MIN);
  assert.equal(result[3].ownMs, 7 * MIN);
});

test('decumulateDurations — l\'ordre du tableau renvoyé est celui de l\'entrée', () => {
  const entries = [
    { sessionId: 's1', timestamp: '2026-08-22T10:10:00Z', durationMs: 12 * MIN },
    { sessionId: 's1', timestamp: '2026-08-22T10:00:00Z', durationMs: 5 * MIN },
  ];
  const result = decumulateDurations(entries);
  // entrée 0 a le timestamp le plus tardif -> triée en second en interne,
  // mais reste en première position dans la sortie.
  assert.equal(result[0].durationMs, 12 * MIN);
  assert.equal(result[0].ownMs, 7 * MIN);
  assert.equal(result[1].durationMs, 5 * MIN);
  assert.equal(result[1].ownMs, 5 * MIN);
});

test('decumulateDurations — ne mute pas les entrées d\'origine', () => {
  const entries = [{ sessionId: 's1', timestamp: '2026-08-22T10:00:00Z', durationMs: 5 * MIN }];
  const result = decumulateDurations(entries);
  assert.equal(entries[0].ownMs, undefined);
  assert.equal(result[0].ownMs, 5 * MIN);
  assert.notEqual(result[0], entries[0]);
});

test('escapeHtml — échappe les caractères sensibles et tolère null/undefined', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(`A & "B" 'C'`), 'A &amp; &quot;B&quot; &#39;C&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('formatDateFr — convertit une date ISO, renvoie null si vide/invalide', () => {
  assert.equal(formatDateFr('2024-03-12'), '12/03/2024');
  assert.equal(formatDateFr('2024-03-12T10:00:00Z'), '12/03/2024');
  assert.equal(formatDateFr(''), null);
  assert.equal(formatDateFr(null), null);
  assert.equal(formatDateFr('pas une date'), null);
});

test('documentHtml — squelette valide, titre échappé', () => {
  const html = documentHtml({ title: '<x>', subtitle: 'sous-titre', bodyHtml: '<p>corps</p>' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="fr">'));
  assert.ok(html.includes('&lt;x&gt;'));
  assert.ok(!html.includes('<title><x></title>'));
  assert.ok(html.includes('<p>corps</p>'));
  assert.ok(html.includes('@page { size: A4; margin: 2cm; }'));
});

function forgeChronology() {
  return {
    generatedAt: '2026-08-22T00:00:00Z',
    deanonymized: true,
    mapping: { exists: true, entries: 2 },
    stats: { documents: 2, indexed: 2, dated: 1, entities: 2, span: { from: '2023-02-02', to: '2023-02-02' } },
    documents: [
      {
        id: 'a', path: 'Assignation.pdf', name: 'Assignation <script>alert(1)</script>.pdf',
        extension: '.pdf', status: 'ok', protected: true, resource: 'x', scanned: true,
        indexed: true, edited: false, nature: 'assignation', natureConfidence: 0.9,
        date: '2 février 2023', dateIso: '2023-02-02', juridiction: 'Tribunal judiciaire de Paris',
        fields: [{ label: 'Montant', value: '1 000 €' }],
        codes: [{ code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Jean Dupont' }],
      },
      {
        id: 'b', path: 'Note.pdf', name: 'Note interne.pdf',
        extension: '.pdf', status: 'ok', protected: true, resource: 'y', scanned: true,
        indexed: true, edited: false, nature: 'courrier', natureConfidence: 0.5,
        date: null, dateIso: null, juridiction: null,
        fields: [],
        codes: [],
      },
    ],
    entities: [
      { code: 'PERSONNE_PHYSIQUE_01', category: 'personne', label: 'Jean Dupont', documentCount: 1, documents: ['Assignation.pdf'] },
      { code: 'ADRESSE_01', category: 'adresse', label: null, documentCount: 1, documents: ['Assignation.pdf'] },
    ],
    graph: {
      engine: 'index-fallback', source: 'gliner', llm: false, status: 'ready',
      nodes: [], edges: [],
      // Marqueur reconnaissable : ne doit jamais fuiter dans le rendu papier.
      viewerHtml: '<div id="VIS_NETWORK_MARQUEUR_JAMAIS_DANS_LE_PDF"></div>',
    },
  };
}

test('renderChronologyHtml — lignes attendues, "Sans date" pour les pièces non datées', () => {
  const html = renderChronologyHtml(forgeChronology(), { caseName: 'Dupont c/ Martin' });
  assert.ok(html.includes('Sans date'));
  assert.ok(html.includes('12/03/2024') === false); // pas de fausse date injectée
  assert.ok(html.includes('Note interne.pdf'));
  assert.ok(html.includes('Tribunal judiciaire de Paris'));
  assert.ok(html.includes('Montant : 1 000 €'));
  assert.ok(html.includes('Jean Dupont'));
  assert.ok(html.includes('Dupont c/ Martin'));
  // Catégorie traduite en français.
  assert.ok(html.includes('Personne'));
  assert.ok(html.includes('Adresse'));
});

test('renderChronologyHtml — échappe les noms de pièces (pas de HTML brut injecté)', () => {
  const html = renderChronologyHtml(forgeChronology(), { caseName: 'Test' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderChronologyHtml — n\'émet jamais le contenu de graph.viewerHtml', () => {
  const html = renderChronologyHtml(forgeChronology(), { caseName: 'Test' });
  assert.ok(!html.includes('VIS_NETWORK_MARQUEUR_JAMAIS_DANS_LE_PDF'));
});

test('renderHistoryHtml — le total en pied vaut la somme des temps décumulés', () => {
  const entries = [
    { hash: 'h1', shortHash: 'h1', author: 'Ted', timestamp: '2026-08-22T10:00:00Z', subject: 'Acte 1', sessionId: 's1', durationMs: 5 * MIN, files: ['a.md'], filesCount: 1 },
    { hash: 'h2', shortHash: 'h2', author: 'Ted', timestamp: '2026-08-22T10:07:00Z', subject: 'Acte 2', sessionId: 's1', durationMs: 12 * MIN, files: ['a.md', 'b.md'], filesCount: 2 },
    { hash: 'h3', shortHash: 'h3', author: 'Ted', timestamp: '2026-08-23T09:00:00Z', subject: 'Acte 3', sessionId: '', durationMs: null, files: [], filesCount: 0 },
  ];
  const html = renderHistoryHtml(entries, { caseName: 'Dupont c/ Martin', month: '2026-08' });
  // Total attendu : 5min + 7min (décumulé) + 0 = 12 min.
  const expectedTotal = formatDurationFr(12 * MIN);
  assert.ok(html.includes(`>${expectedTotal}<`), `attendu ${expectedTotal} dans le pied de tableau`);
  assert.ok(html.includes('Acte 1'));
  assert.ok(html.includes('Acte 2'));
  assert.ok(html.includes('Acte 3'));
  assert.ok(html.includes('août 2026'));
  assert.ok(html.includes('—')); // Acte 3 : ownMs = 0 -> tiret
});

test('renderHistoryHtml — dossier vide n\'explose pas et affiche un total nul', () => {
  const html = renderHistoryHtml([], { caseName: 'Vide', month: '2026-08' });
  assert.ok(html.includes('Aucun acte'));
  assert.ok(html.includes('>—<'));
});

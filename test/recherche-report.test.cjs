const assert = require('node:assert/strict');
const test = require('node:test');

const {
  slugify,
  reportSlug,
  renderMarkdown,
} = require('../piecemaker-plugin/scripts/lib/recherche-report.cjs');

test('slugify strips accents, lowercases and hyphenates', () => {
  assert.equal(slugify('Clause pénale — révision du juge'), 'clause-penale-revision-du-juge');
  assert.equal(slugify('   '), 'recherche');
  assert.equal(slugify('Déjà-Vu!!'), 'deja-vu');
});

test('reportSlug prefixes an explicit slug with the payload date', () => {
  assert.equal(
    reportSlug({ slug: 'clause-penale', date: '2026-08-18' }),
    '2026-08-18-clause-penale',
  );
});

test('reportSlug derives from the title when no slug is given', () => {
  assert.equal(
    reportSlug({ titre: 'Prescription quinquennale', date: '2026-01-02' }),
    '2026-01-02-prescription-quinquennale',
  );
});

test('renderMarkdown lays sections in the specified order', () => {
  const md = renderMarkdown(
    {
      titre: 'Clause pénale',
      date: '2026-08-18',
      question: 'Le juge peut-il réduire la clause pénale de PERSONNE_MORALE_1 ?',
      decisions: [
        {
          titre: 'Arrêt de principe',
          juridiction: 'Cass. civ. 1re',
          date: '12/01/2022',
          reference: 'n° 20-18.640',
          lien: 'https://www.legifrance.gouv.fr/juri/id/XYZ',
        },
      ],
      citation: 'Cass. civ. 1re, 12 janvier 2022, n° 20-18.640',
      rapport: 'La référence répond à la question du pouvoir de révision.',
      liens: ['https://www.legifrance.gouv.fr/juri/id/XYZ'],
    },
    { caseName: 'Dossier Test' },
  );

  const order = ['## Question initiale', '## Décision(s)', '## Citation retenue', '## Rapport de tri', '## Liens Legifrance']
    .map((h) => md.indexOf(h));
  assert.ok(order.every((i) => i >= 0), 'toutes les sections présentes');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'sections dans l\'ordre attendu');

  assert.match(md, /# Recherche juridique — Clause pénale/);
  assert.match(md, /\*\*Dossier\*\* : Dossier Test/);
  assert.match(md, /PERSONNE_MORALE_1/); // codes conservés au rendu (revert en aval)
  assert.match(md, /\[Legifrance\]\(https:\/\/www\.legifrance\.gouv\.fr\/juri\/id\/XYZ\)/);
  assert.match(md, /> Cass\. civ\. 1re, 12 janvier 2022, n° 20-18\.640/);
});

test('renderMarkdown degrades gracefully on an empty payload', () => {
  const md = renderMarkdown({});
  assert.match(md, /_Aucune décision ou texte retenu\._/);
  assert.match(md, /_Aucune citation vérifiée\._/);
  assert.match(md, /_Aucun lien fourni\._/);
});

test('renderMarkdown escapes pipe characters in table cells', () => {
  const md = renderMarkdown({
    decisions: [{ titre: 'A | B', juridiction: 'CA', date: '2020', reference: 'n°1' }],
  });
  assert.match(md, /A \\\| B/);
});

test('renderMarkdown reports exhaustive coverage and labels estimated tokens honestly', () => {
  const md = renderMarkdown({
    question: 'Quelles sont les conditions ?',
    analyseLabel: 'Rapport de recherche exhaustive',
    rapport: 'Synthèse issue de toutes les fiches validées.',
    methodologie: 'Corpus fixe sans RAG ; une fiche par décision.',
    metriques: {
      decisionsIdentifiees: 398,
      decisionsScannees: 396,
      fichesValidees: 396,
      echecs: 2,
      tokensEntree: 812345,
      tokensSortie: 54210,
      tokensExacts: false,
      methodeEstimation: 'ceil(caractères/4)',
      tronquee: true,
    },
  });

  assert.match(md, /## Rapport de recherche exhaustive/);
  assert.match(md, /## Méthodologie/);
  assert.match(md, /## Couverture et coût/);
  assert.match(md, /Décisions scannées en texte intégral\*\* : 396/);
  assert.match(md, /Tokens d'entrée estimés\*\* : 812[\s\u202f]345/);
  assert.match(md, /Méthode d'estimation\*\* : ceil\(caractères\/4\)/);
  assert.match(md, /corpus tronqué/);
});

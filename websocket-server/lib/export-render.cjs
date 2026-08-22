/**
 * Rendu HTML imprimable (A4) pour l'export PDF/DOCX.
 *
 * Fonctions pures : aucune lecture disque, aucun appel git, aucun accès
 * réseau — uniquement des données en entrée, une chaîne HTML en sortie. Le
 * HTML produit ici est ensuite converti, ailleurs dans le pipeline
 * (`doc-generate.cjs`) : par pandoc dans le cas nominal, avec un repli
 * intégral sur LibreOffice (headless) si pandoc est absent du poste. C'est
 * précisément ce repli qui oblige à garder le CSS volontairement pauvre
 * (aucun flexbox/grid, aucune ressource externe) et les attributs HTML
 * dupliqués sur chaque `<table>` : le moteur de rendu de LibreOffice ne
 * supporte ni l'un ni l'autre autrement.
 *
 * Attention : le lecteur HTML de pandoc est bien plus strict que celui de
 * LibreOffice et jette intégralement le CSS, `@page` compris — la mise en
 * page du PDF vient donc des métadonnées passées à pandoc, pas de ce
 * fichier. Si le rendu pandoc casse, trois constructions d'ici sont à
 * surveiller en priorité : les `colspan` (séparateur de jour ~ligne 312 et
 * ligne de total ~ligne 340), le `<tfoot>` (~ligne 339), et les `<br>` en
 * cellule (~lignes 239 et 243).
 */

const { formatDurationFr } = require('../../piecemaker-plugin/scripts/lib/session-timing.cjs');

// Mêmes libellés que la vue chronologie de l'admin (admin/app.js, CATEGORY_LABELS)
// — on garde le vocabulaire déjà connu du cabinet plutôt que d'en inventer un autre.
const CATEGORY_LABELS = {
  personne: 'Personne',
  societe: 'Société',
  adresse: 'Adresse',
  siren: 'SIREN',
  autre: 'Autre',
};

/**
 * Échappe une valeur pour insertion dans du HTML. Il n'existe pas d'équivalent
 * serveur : celui d'admin/app.js tourne dans le navigateur (DOM `String.prototype`
 * suffit là-bas), mais ce module est du CommonJS pur côté Node.
 */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `'2024-03-12'` (ou un ISO complet) → `'12/03/2024'`. Entrée vide/invalide → null,
 * pour laisser l'appelant décider de l'affichage de repli (« Sans date », etc.).
 */
function formatDateFr(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  // On valide via Date plutôt que de faire confiance à la seule forme du texte :
  // un "2024-13-40" a la bonne syntaxe mais n'est pas une date.
  const asDate = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(asDate.getTime())) return null;
  return `${day}/${month}/${year}`;
}

/**
 * Décumule le champ `PieceMaker-Temps-Session` : ce trailer de commit est le
 * temps écoulé depuis le DÉBUT de la session (cumulatif), pas le temps propre
 * à l'acte. On restitue `ownMs` = la part imputable à chaque commit, en
 * soustrayant le cumul du commit précédent de la même session.
 *
 * Ne mute jamais l'entrée : on renvoie de nouveaux objets, dans l'ordre du
 * tableau reçu (le tri par session/horodatage est purement interne au calcul).
 */
function decumulateDurations(entries) {
  if (!Array.isArray(entries)) return [];

  // Regroupement par sessionId. Une entrée sans sessionId (vide/null) forme
  // sa propre session à elle seule : son ownMs est directement sa durée.
  const groups = new Map(); // sessionId -> [{ entry, index }]
  const solo = []; // indices des entrées sans sessionId

  entries.forEach((entry, index) => {
    const sessionId = entry && entry.sessionId ? entry.sessionId : null;
    if (!sessionId) {
      solo.push(index);
      return;
    }
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push({ entry, index });
  });

  const ownMsByIndex = new Array(entries.length).fill(0);

  for (const index of solo) {
    const durationMs = entries[index] && Number.isFinite(entries[index].durationMs)
      ? entries[index].durationMs
      : 0;
    ownMsByIndex[index] = durationMs;
  }

  for (const items of groups.values()) {
    // Tri croissant par horodatage : le cumul du trailer ne progresse que dans
    // ce sens ; un ordre différent dans le tableau d'origine ne fausse donc pas
    // le calcul (on ne réordonne que cette copie de travail).
    // Départage par le cumul lui-même quand les horodatages sont identiques :
    // git les stocke à la seconde, et le hook PostToolUse commite à chaque
    // Write/Edit — deux actes tombent donc couramment dans la même seconde.
    // Sans ce départage, l'ordre de `git log` (antichronologique) l'emporte,
    // le décumul part du plus grand cumul et impute tout le temps au premier
    // acte rencontré, les suivants étant ramenés à 0. Le compteur de session
    // ne pouvant que croître, il est ici plus fiable que l'horodatage.
    const sorted = [...items].sort((a, b) => {
      const ta = Date.parse(a.entry.timestamp) || 0;
      const tb = Date.parse(b.entry.timestamp) || 0;
      if (ta !== tb) return ta - tb;
      const da = Number.isFinite(a.entry.durationMs) ? a.entry.durationMs : 0;
      const db = Number.isFinite(b.entry.durationMs) ? b.entry.durationMs : 0;
      return da - db;
    });
    let previousCumulative = 0;
    for (const { entry, index } of sorted) {
      if (!Number.isFinite(entry.durationMs)) {
        // Pas de trailer de temps sur cet acte : on ne peut rien lui imputer.
        // Surtout, on ne touche pas `previousCumulative` — sinon l'acte
        // suivant se retrouverait à tort décumulé depuis 0, et gonflerait
        // artificiellement son propre temps.
        ownMsByIndex[index] = 0;
        continue;
      }
      const cumulative = entry.durationMs;
      // Un écart négatif signale des horodatages désordonnés ou une reprise de
      // session (le compteur repart plus bas) : on ramène à 0 plutôt que de
      // retrancher du temps qui n'existe pas.
      ownMsByIndex[index] = Math.max(0, cumulative - previousCumulative);
      previousCumulative = cumulative;
    }
  }

  return entries.map((entry, index) => ({ ...entry, ownMs: ownMsByIndex[index] }));
}

/** Enveloppe HTML commune : squelette + CSS inline, sobre pour LibreOffice. */
function documentHtml({ title, subtitle, bodyHtml }) {
  const safeTitle = escapeHtml(title || '');
  const safeSubtitle = subtitle ? escapeHtml(subtitle) : '';
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
  @page { size: A4; margin: 2cm; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10pt;
    color: #1a1a1a;
  }
  h1 {
    font-size: 16pt;
    margin: 0 0 4px 0;
  }
  .export-subtitle {
    font-size: 9pt;
    color: #555555;
    margin: 0 0 16px 0;
  }
  h2 {
    font-size: 12pt;
    margin: 20px 0 8px 0;
    border-bottom: 1px solid #999999;
    padding-bottom: 2px;
  }
  /* Le CSS ci-dessous sert à la lecture du HTML dans un navigateur. À
     l'import, LibreOffice ignore la largeur et les bordures déclarées en CSS :
     seuls les attributs HTML width/border/cellspacing posés sur chaque table
     survivent à la conversion. Les deux sont donc nécessaires — ne retirer ni
     l'un ni l'autre. Ces attributs sont inutiles à pandoc (qui jette tout le
     CSS et ignore ces attributs HTML de toute façon), mais indispensables au
     repli LibreOffice : à conserver pour cette seule raison. */
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
    font-size: 9pt;
  }
  th, td {
    border: 1px solid #bbbbbb;
    padding: 4px 6px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background-color: #e8e8e8;
    font-weight: bold;
  }
  tfoot td {
    font-weight: bold;
    background-color: #f2f2f2;
  }
  .export-summary {
    margin-bottom: 16px;
  }
  .export-summary td, .export-summary th {
    border: none;
    padding: 2px 12px 2px 0;
  }
  .export-daysep td {
    background-color: #f2f2f2;
    font-weight: bold;
  }
  .export-empty {
    color: #777777;
    font-style: italic;
  }
</style>
</head>
<body>
<h1>${safeTitle}</h1>
${safeSubtitle ? `<p class="export-subtitle">${safeSubtitle}</p>` : ''}
${bodyHtml}
</body>
</html>`;
}

/** Rendu HTML papier de la chronologie (`buildChronology()` de document-index.cjs). */
function renderChronologyHtml(chronology, { caseName } = {}) {
  const stats = (chronology && chronology.stats) || {};
  const documents = Array.isArray(chronology && chronology.documents) ? chronology.documents : [];
  const entities = Array.isArray(chronology && chronology.entities) ? chronology.entities : [];
  const span = stats.span || null;

  const now = new Date();
  const generatedAtFr = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const subtitle = `${caseName ? `Dossier « ${caseName} » — ` : ''}généré le ${generatedAtFr}`;

  const periode = span ? `${formatDateFr(span.from) || span.from} → ${formatDateFr(span.to) || span.to}` : '—';

  const summaryHtml = `
<table class="export-summary" width="100%" border="0" cellspacing="0" cellpadding="4">
  <tr><th>Pièces</th><td>${escapeHtml(stats.documents ?? 0)}</td>
      <th>Indexées</th><td>${escapeHtml(stats.indexed ?? 0)}</td></tr>
  <tr><th>Datées</th><td>${escapeHtml(stats.dated ?? 0)}</td>
      <th>Entités</th><td>${escapeHtml(stats.entities ?? 0)}</td></tr>
  <tr><th>Période couverte</th><td colspan="3">${escapeHtml(periode)}</td></tr>
</table>`;

  const docRows = documents.map((doc) => {
    const dateLabel = formatDateFr(doc.dateIso) || 'Sans date';
    const fields = Array.isArray(doc.fields) ? doc.fields : [];
    const infosHtml = fields.length
      ? fields.map((field) => `${escapeHtml(field.label)} : ${escapeHtml(field.value)}`).join('<br>')
      : '';
    const codes = Array.isArray(doc.codes) ? doc.codes : [];
    const entitesHtml = codes.length
      ? codes.map((code) => escapeHtml(code.label || code.code)).join('<br>')
      : '';
    return `<tr>
      <td>${escapeHtml(dateLabel)}</td>
      <td>${escapeHtml(doc.nature || '')}</td>
      <td>${escapeHtml(doc.name)}</td>
      <td>${escapeHtml(doc.juridiction || '')}</td>
      <td>${infosHtml}</td>
      <td>${entitesHtml}</td>
    </tr>`;
  }).join('\n');

  const frizeTableHtml = `
<h2>Frise chronologique</h2>
<table width="100%" border="1" cellspacing="0" cellpadding="4">
  <thead>
    <tr><th>Date</th><th>Nature</th><th>Pièce</th><th>Juridiction</th><th>Informations</th><th>Entités</th></tr>
  </thead>
  <tbody>
    ${docRows || '<tr><td colspan="6" class="export-empty">Aucune pièce indexée.</td></tr>'}
  </tbody>
</table>`;

  const entityRows = entities.map((entity) => `<tr>
      <td>${escapeHtml(entity.label || entity.code)}</td>
      <td>${escapeHtml(CATEGORY_LABELS[entity.category] || entity.category || '')}</td>
      <td>${escapeHtml(entity.documentCount ?? 0)}</td>
    </tr>`).join('\n');

  const entitiesTableHtml = `
<h2>Entités</h2>
<table width="100%" border="1" cellspacing="0" cellpadding="4">
  <thead>
    <tr><th>Entité</th><th>Catégorie</th><th>Nombre de pièces</th></tr>
  </thead>
  <tbody>
    ${entityRows || '<tr><td colspan="3" class="export-empty">Aucune entité détectée.</td></tr>'}
  </tbody>
</table>`;

  // Le graphe (chronology.graph, vis-network interactif) n'a pas d'équivalent
  // papier et n'est délibérément jamais utilisé ici.
  const bodyHtml = `${summaryHtml}\n${frizeTableHtml}\n${entitiesTableHtml}`;

  return documentHtml({ title: 'Chronologie du dossier', subtitle, bodyHtml });
}

/** Rendu HTML papier de l'historique des actes (commits) d'un mois donné. */
function renderHistoryHtml(entries, { caseName, month } = {}) {
  const decumulated = decumulateDurations(Array.isArray(entries) ? entries : []);

  const monthLabel = formatMonthFr(month);
  const subtitle = `${caseName ? `Dossier « ${caseName} » — ` : ''}${monthLabel || (month || '')}`;

  let previousDay = '';
  const rows = [];
  let totalMs = 0;

  for (const item of decumulated) {
    const timestamp = item.timestamp ? new Date(item.timestamp) : null;
    const validDate = timestamp && !Number.isNaN(timestamp.getTime());
    const day = validDate
      ? timestamp.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : 'Date inconnue';
    const heure = validDate
      ? timestamp.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : '';

    if (day !== previousDay) {
      rows.push(`<tr class="export-daysep"><td colspan="5">${escapeHtml(day)}</td></tr>`);
      previousDay = day;
    }

    const ownMs = Number.isFinite(item.ownMs) ? item.ownMs : 0;
    totalMs += ownMs;
    const tempsLabel = ownMs > 0 ? (formatDurationFr(ownMs) || '—') : '—';

    rows.push(`<tr>
      <td>${escapeHtml(heure)}</td>
      <td>${escapeHtml(item.subject || '')}</td>
      <td>${escapeHtml(item.author || '')}</td>
      <td>${escapeHtml(item.filesCount ?? (Array.isArray(item.files) ? item.files.length : 0))}</td>
      <td>${escapeHtml(tempsLabel)}</td>
    </tr>`);
  }

  const totalLabel = totalMs > 0 ? (formatDurationFr(totalMs) || '—') : '—';

  const bodyHtml = `
<table width="100%" border="1" cellspacing="0" cellpadding="4">
  <thead>
    <tr><th>Heure</th><th>Acte</th><th>Auteur</th><th>Fichiers</th><th>Temps</th></tr>
  </thead>
  <tbody>
    ${rows.length ? rows.join('\n') : '<tr><td colspan="5" class="export-empty">Aucun acte pour cette période.</td></tr>'}
  </tbody>
  <tfoot>
    <tr><td colspan="4">Total du mois</td><td>${escapeHtml(totalLabel)}</td></tr>
  </tfoot>
</table>`;

  return documentHtml({ title: 'Historique des actes', subtitle, bodyHtml });
}

/** `'2026-08'` → `'août 2026'`. Entrée invalide → null. */
function formatMonthFr(month) {
  if (typeof month !== 'string') return null;
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const [, year, monthNum] = match;
  const asDate = new Date(`${year}-${monthNum}-01T00:00:00Z`);
  if (Number.isNaN(asDate.getTime())) return null;
  return asDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

module.exports = {
  escapeHtml,
  documentHtml,
  formatDateFr,
  decumulateDurations,
  renderChronologyHtml,
  renderHistoryHtml,
};

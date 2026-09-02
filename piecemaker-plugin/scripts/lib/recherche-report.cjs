'use strict';

/**
 * Rendu déterministe d'un rapport de recherche juridique.
 *
 * Ce module est *pur* : il transforme un « payload » produit par
 * l'orchestrateur de recherche en un document Markdown au gabarit fixe. Aucun
 * LLM n'intervient — c'est exactement la partie que l'utilisateur veut sortir
 * de la main d'un agent. Il vit dans `scripts/lib/` parce que le hook
 * `compile-recherche.mjs` ne peut requérir que depuis là (le plugin est livré
 * autonome).
 */

/** Retire les accents et normalise en minuscules pour un slug de fichier. */
function slugify(value, { maxLength = 60 } = {}) {
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base || 'recherche';
}

/** `2026-08-18-clause-penale` — préfixe daté pour un classement chronologique. */
function reportSlug(payload, { date } = {}) {
  const day = (date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const explicit = payload.slug ? slugify(payload.slug) : null;
  const derived = explicit || slugify(payload.titre || payload.question || 'recherche');
  return `${day}-${derived}`;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function decisionRow(entry) {
  if (typeof entry === 'string') {
    return `| ${escapeCell(entry)} | | | | |`;
  }
  const titre = escapeCell(entry.titre || entry.title || entry.intitule);
  const juridiction = escapeCell(entry.juridiction || entry.jurisdiction);
  const date = escapeCell(entry.date);
  const reference = escapeCell(entry.reference || entry.numero || entry.ref);
  const lien = entry.lien || entry.url || entry.legifrance;
  const lienCell = lien ? `[Legifrance](${escapeCell(lien)})` : '';
  return `| ${titre} | ${juridiction} | ${date} | ${reference} | ${lienCell} |`;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function metricLine(label, value) {
  const count = integer(value);
  return count == null ? null : `- **${label}** : ${count.toLocaleString('fr-FR')}`;
}

function renderMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return [];
  const lines = ['## Couverture et coût', ''];
  const counts = [
    metricLine('Décisions identifiées (dédupliquées)', metrics.decisionsIdentifiees ?? metrics.identified),
    metricLine('Décisions scannées en texte intégral', metrics.decisionsScannees ?? metrics.scanned),
    metricLine('Fiches validées', metrics.fichesValidees ?? metrics.validCards),
    metricLine('Échecs', metrics.echecs ?? metrics.failed),
  ].filter(Boolean);
  lines.push(...counts);

  const input = integer(metrics.tokensEntree ?? metrics.inputTokens);
  const output = integer(metrics.tokensSortie ?? metrics.outputTokens);
  const exact = metrics.tokensExacts === true || metrics.exact === true;
  if (input != null) lines.push(`- **Tokens d'entrée ${exact ? 'exacts' : 'estimés'}** : ${input.toLocaleString('fr-FR')}`);
  if (output != null) lines.push(`- **Tokens de sortie ${exact ? 'exacts' : 'estimés'}** : ${output.toLocaleString('fr-FR')}`);
  if (metrics.reasoningTokens != null) {
    const reasoning = integer(metrics.reasoningTokens);
    if (reasoning != null) lines.push(`- **Tokens de raisonnement exacts** : ${reasoning.toLocaleString('fr-FR')}`);
  }
  if (!exact && metrics.methodeEstimation) {
    lines.push(`- **Méthode d'estimation** : ${String(metrics.methodeEstimation).trim()}`);
  }
  if (metrics.tronquee === true || metrics.truncated === true) {
    lines.push('- **Couverture** : ⚠️ corpus tronqué par un plafond explicite');
  }
  if (!counts.length && input == null && output == null) return [];
  lines.push('');
  return lines;
}

/**
 * Construit le Markdown final. L'ordre des sections suit la spécification :
 * question initiale → décision(s)/texte(s) trouvé(s) → citation retenue →
 * rapport de tri (Haiku) → liens Legifrance.
 */
function renderMarkdown(payload, { date, caseName } = {}) {
  const day = (date || payload.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const titre = payload.titre || payload.slug || 'Recherche juridique';
  const decisions = asArray(payload.decisions || payload.textes);
  const liens = asArray(payload.liens || payload.links).filter(Boolean);

  const lines = [];
  lines.push(`# Recherche juridique — ${titre}`);
  lines.push('');
  lines.push(`- **Date de la recherche** : ${day}`);
  if (caseName) lines.push(`- **Dossier** : ${caseName}`);
  if (payload.citation) lines.push(`- **Citation retenue** : ${payload.citation}`);
  lines.push('');

  lines.push('## Question initiale');
  lines.push('');
  lines.push(String(payload.question || '_Non renseignée._').trim());
  lines.push('');

  lines.push('## Décision(s) / texte(s) trouvé(s)');
  lines.push('');
  if (decisions.length) {
    lines.push('| Titre | Juridiction | Date | Référence | Legifrance |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const entry of decisions) lines.push(decisionRow(entry));
  } else {
    lines.push('_Aucune décision ou texte retenu._');
  }
  lines.push('');

  lines.push('## Citation retenue');
  lines.push('');
  lines.push(payload.citation ? `> ${String(payload.citation).trim()}` : '_Aucune citation vérifiée._');
  lines.push('');

  lines.push(`## ${String(payload.analyseLabel || 'Rapport de tri (Haiku)').trim()}`);
  lines.push('');
  lines.push(String(payload.rapport || '_Non renseigné._').trim());
  lines.push('');

  if (payload.methodologie) {
    lines.push('## Méthodologie');
    lines.push('');
    lines.push(String(payload.methodologie).trim());
    lines.push('');
  }

  lines.push(...renderMetrics(payload.metriques || payload.metrics));

  lines.push('## Liens Legifrance');
  lines.push('');
  if (liens.length) {
    for (const lien of liens) lines.push(`- ${lien}`);
  } else {
    lines.push('_Aucun lien fourni._');
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push(
    '_Document compilé automatiquement par PieceMaker (hook `compile-recherche`). '
      + 'Références à vérifier indépendamment par l\'avocat avant toute citation dans un acte._',
  );
  lines.push('');

  return lines.join('\n');
}

module.exports = {
  slugify,
  reportSlug,
  renderMetrics,
  renderMarkdown,
};

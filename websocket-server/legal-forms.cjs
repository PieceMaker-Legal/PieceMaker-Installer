/**
 * Vocabulaire des formes juridiques de sociétés — miroir JS de `_LEGAL_FORMS`
 * dans `scripts/scan_utils.py`.
 *
 * Depuis le choix du cabinet, une société dont le nom porte un sigle est codée
 * avec ce sigle en préfixe : `SA_1`, `SARL_1`, `SCI_1`, `GMBH_1`, `LLC_1`,
 * `LTD_1`… Sans sigle, elle tombe sur `PERS_MORALE_1`. Le pipeline Python
 * (`convert_and_scan_pipeline.py`) et l'administration (`originals-pipeline.cjs`)
 * écrivent le même mapping : ils doivent partager ce vocabulaire, sinon une
 * reconstruction admin dédoublerait une entité déjà codée par le CLI.
 *
 * Ce module ne sert qu'à *classer* un code déjà attribué (à quelle famille
 * appartient `SA_1` ?) et à retrouver sa clé de compteur. La *détection* du sigle
 * dans le texte reste côté Python (scan_utils.extract_legal_form) : c'est elle qui
 * type l'entité `ORGANIZATION_<sigle>`, d'où le préfixe du code sort ensuite.
 *
 * Toute modification de `_LEGAL_FORMS` (ajout d'un sigle) doit être répercutée ici.
 */

// Jetons canoniques, tenus synchronisés avec `_LEGAL_FORMS` (scan_utils.py).
const LEGAL_FORM_TOKENS = new Set([
  // France — exercice libéral / commercial / civil / coopératif / agricole
  'SELARL', 'SELAS', 'SELCA', 'SELCS', 'SASU', 'SARL', 'EURL', 'EARL',
  'SCOP', 'SCIC', 'GAEC', 'SAS', 'SCI', 'SCA', 'SCS', 'SCP', 'SCM', 'SNC',
  'GIE', 'SLP', 'SEL', 'SEM',
  // Royaume-Uni
  'EEIG', 'CIC', 'CIO', 'CLG', 'RTM', 'PLC', 'LTD',
  // États-Unis
  'LLLP', 'PLLC', 'LLC', 'LLP', 'INC', 'CORP', 'LP', 'GP', 'PC', 'PA', 'CO',
  // Allemagne
  'PARTG', 'GMBH', 'KGAA', 'OHG', 'GBR', 'KG', 'AG', 'UG', 'EG', 'EK',
  // Autres formes européennes / internationales
  'SE', 'SA', 'BV', 'NV', 'SPA', 'SRL', 'SL', 'LDA', 'AB', 'OY', 'APS', 'AS',
  'PTYLTD', 'PVTLTD',
]);

/**
 * Clé de compteur d'un code société (le sigle), legacy compris. Miroir de
 * `_societe_counter_key_of_code` (Python). On lit le dernier segment avant le
 * numéro — sauf présence de MORALE, qui signe le repli sans sigle.
 *   SA_3 → 'SA' ; URGOT SA → 'SA' ; CLIENT_DEMANDEUR_SA_1 → 'SA' ;
 *   PERS_MORALE_2 / PERSONNE_MORALE_01 → 'PERS_MORALE'.
 */
function societeCounterKey(code) {
  const tokens = String(code || '')
    .replace(/_\d+$/, '')
    .toUpperCase()
    .split('_')
    .filter(Boolean);
  if (tokens.includes('MORALE')) return 'PERS_MORALE';
  return tokens.length ? tokens[tokens.length - 1] : 'PERS_MORALE';
}

/**
 * Un code désigne-t-il une société ? Vrai pour le repli (`…MORALE…`), le legacy
 * (`SOCIETE_…`) et tout code dont un segment est un sigle connu (`SA_1`,
 * `CLIENT_DEMANDEUR_GMBH_2`). Les familles distinctives (personne, adresse,
 * siren, e-mail…) ne portent aucun sigle : à tester après elles pour lever toute
 * ambiguïté.
 */
function isSocieteCode(code) {
  const normalized = String(code || '').replace(/\s+/g, '_').toUpperCase();
  if (normalized.includes('MORALE') || normalized.includes('SOCIETE')) return true;
  return normalized
    .replace(/_\d+$/, '')
    .split('_')
    .filter(Boolean)
    .some((token) => LEGAL_FORM_TOKENS.has(token));
}

/**
 * Sigle porté par un nom de société, lu comme un jeton entier (avec ou sans
 * points : « SARL », « S.A.R.L. »), sinon null. Heuristique volontairement légère,
 * pour les chemins qui n'ont pas la détection fine de scan_utils (analyse Ollama) :
 * la vraie détection dans le texte reste côté Python. Balaye de la fin vers le
 * début — le sigle suit le plus souvent le nom (« Dupont SARL »).
 */
function detectCompanySigle(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i].replace(/[.’',&]/g, '').toUpperCase();
    if (LEGAL_FORM_TOKENS.has(token)) return token;
  }
  return null;
}

module.exports = { LEGAL_FORM_TOKENS, societeCounterKey, isSocieteCode, detectCompanySigle };

# PieceMaker — composants Claude Code et Codex CLI

Ce dossier regroupe les skills partagés avec Claude Code et Codex CLI, ainsi
que les agents et hooks de garde-fou. Il n'est pas
distribué par un manifest ou un marketplace PieceMaker. Le serveur MCP
Légifrance est maintenu séparément dans
[`PieceMaker-Legal/mcp-legifrance`](https://github.com/PieceMaker-Legal/mcp-legifrance).

## Contenu

- **Skills** (`skills/`) :
  - `conversion-md` — conversion de documents en Markdown
    (`smart_converter.py`, markitdown/MinerU).
  - `redaction-juridique` — rédaction/relecture de documents juridiques
    français, citations sourcées via legifrance (MCP).
  - `tamponnage` — tampon du cabinet et tamponnage numéroté des pièces d'un
    bordereau : conversion de l'original en PDF (LibreOffice pour Excel/Word,
    `pdf-lib` pour images et texte), tampon puis renommage « Pièce n°N » dans
    le sous-dossier « Pièces tamponnées » de chaque dossier juridique.
- **Agents** (`agents/`) :
  - `verificateur-anonymisation` — audit lecture seule avant sortie de
    cabinet, confirme l'absence de PII résiduelle.
  - `analyste-piece` — synthèse structurée d'une pièce du dossier.
- **Hooks** (`hooks/hooks.json`) — protection des pièces et mappings
  (`PreToolUse`), suivi Légifrance et commit Git après écriture (`PostToolUse`),
  compilation des recherches et suivi de session local (`Stop`/`TaskCompleted`).
  Un document créé par l'IA dans un dossier enregistré est classé d'office
  « espace de travail » (`classify-ai-documents.mjs`, `PostToolUse`) : sans
  quoi il naîtrait au coffre-fort et l'IA ne pourrait pas se relire.
  Le mapping PII est appliqué par le proxy LiteLLM, pas par ces hooks. Tous
  les hooks échouent "ouverts" (fail-open) : aucune erreur, timeout ou
  absence de configuration ne bloque jamais une session.

L'installateur enregistre ces composants dans les emplacements utilisateur
découverts par les CLI. Il fusionne tous les hooks dans les réglages Claude
Code et la sentinelle `SessionStart` dans les réglages Codex.

Chaque sous-dossier immédiat de `config.workspacePath` est traité comme un dossier
juridique indépendant. Son historique Git est conservé hors des données client,
dans `~/.piecemaker/case-history/`. Il versionne les Markdown et mappings JSON ;
pour les `.docx`, il conserve une empreinte compacte des parties OOXML afin de
signaler une modification dans l’administration. Le binaire Word n’est jamais
archivé. Pour un DOCX explicitement déprotégé, une représentation textuelle
normalisée et compressée permet d’afficher un vrai diff ; le texte d’une pièce
protégée n’est jamais extrait. Les restaurations n’écrasent aucun DOCX.
L’historique, les restaurations et l’état de protection GLiNER sont accessibles
dans l’interface locale `/admin/`.

## Installation locale

L'étape `09-claude-assets` enregistre, si Claude Code est présent :

- `~/.claude/agents/<slug>.md`
- `~/.claude/skills/<slug>/SKILL.md`

L'étape `09-codex-plugin` enregistre, si Codex CLI est présent :

- `~/.codex/skills/<slug>/SKILL.md`
- `~/.codex/hooks.json` — sentinelle `SessionStart` qui affiche l’état réel du
  proxy : `🔒 Anonymisation PieceMaker active ✓` ou un avertissement explicite.

Ce sont des **liens symboliques** vers `piecemaker-plugin/` : toute
modification du Markdown (administration ou éditeur) est prise en compte à la
session suivante. Une copie rafraîchissable est utilisée si les liens ne sont
pas disponibles. Pour Claude Code, l'enregistrement a aussi lieu :

- à la création d'un skill ou d'un agent dans l'administration ;
- à chaque enregistrement d'un fichier ;
- au démarrage du serveur ;
- après `piecemaker update`.

Un fichier personnel homonyme déjà présent dans `~/.claude` n'est jamais
écrasé : l'administration affiche alors le badge « Conflit ». Les liens
devenus orphelins (skill supprimé du dépôt) sont nettoyés automatiquement.
Implémentations : `websocket-server/claude-assets.cjs` et
`installer/lib/codex-skills.mjs`.

Les hooks décrits par `hooks/hooks.json` sont fusionnés directement dans
`~/.claude/settings.json` avec le chemin absolu des scripts du dépôt. Ils ne
dépendent donc d'aucun cache de plugin. `piecemaker update`, le démarrage du
serveur et l'étape 06 réconcilient cet enregistrement.

Codex ne permet pas encore d’exécuter une commande arbitraire dans sa
`tui.status_line`. PieceMaker utilise donc son hook natif `SessionStart` : le
message figure au début de chaque session et reflète le routage Codex ainsi que
la disponibilité du proxy au moment du lancement. Codex peut demander une fois
de confirmer la confiance accordée à ce hook local.

## Serveur MCP Légifrance

L'étape `07-legifrance` installe le plugin autonome depuis
`PieceMaker-Legal/mcp-legifrance`. Son runtime, ses tests, son venv et sa
configuration MCP ne vivent plus dans ce dépôt. Le plugin conserve
volontairement l'identifiant Claude `piecemaker`, donc le namespace historique
`mcp__plugin_piecemaker_legifrance` utilisé par les agents reste inchangé.

Les identifiants PISTE sont copiés avec des permissions 0600 dans
`~/.config/mcp-legifrance/.env`. Le `.env` PieceMaker reste alimenté pour
l'administration et la migration des installations antérieures.

Deux outils complètent les recherches ponctuelles :

- `Build_Research_Corpus` fige plusieurs requêtes, déduplique, télécharge et
  scanne chaque texte intégral ; un filtre booléen auditable ferme les
  incompatibilités certaines, puis prépare toutes les candidates en lots de
  30 décisions au plus par défaut ;
- `Validate_Research_Cards` exige une fiche par décision, confirme chaque
  citation dans le texte source et produit la matrice ainsi que les métriques
  de couverture et de consommation.

Ce flux n'utilise ni embeddings, ni base vectorielle, ni top-k. Le filtre
statique exige la présence conjointe d'un contexte SA et d'une révocation située
à 300 caractères au plus d'une fonction dirigeante ; chaque cooccurrence d'une
candidate est conservée. Les tokens sont annoncés comme estimés tant qu'un usage
exact du fournisseur n'a pas été passé au validateur. L'implémentation et ses
tests appartiennent désormais au dépôt MCP autonome.

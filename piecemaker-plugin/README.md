# PieceMaker — composants Claude Code et Codex CLI

Ce dossier regroupe les skills partagés avec Claude Code et Codex CLI, ainsi
que les agents et hooks de garde-fou propres à Claude Code. Il n'est pas
distribué par un manifest ou un marketplace PieceMaker.

## Contenu

- **Skills** (`skills/`) :
  - `anonymisation` — scan PII GLiNER/Presidio, lecture/édition de mapping
    d'anonymisation, ré-identification.
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
- **Hooks** (`hooks/hooks.json`) — interdiction de lire les dossiers
  `pièces originales`, avertissement PII avant lecture d'un document
  (`PreToolUse`), scan GLiNER et commit Git complet après écriture (`PostToolUse`),
  puis suivi de session local (`Stop`/`TaskCompleted`). Tous
  les hooks échouent "ouverts" (fail-open) : aucune erreur, timeout ou
  absence de configuration ne bloque jamais une session.

L'installateur enregistre ces composants dans les emplacements utilisateur
découverts par les CLI et fusionne les hooks dans les réglages Claude Code.

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

## Serveur MCP Légifrance

Le serveur MCP supporté est `mcp/legifrance/mcp_stdio_server.py`. Le fichier
`.mcp.json` conserve sa configuration stdio portable pour une installation
explicite du plugin ; l'étape `07-legifrance` configure et valide ses clés
PISTE dans `.env`.

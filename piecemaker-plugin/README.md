# PieceMaker — plugin Claude Code

Ce plugin regroupe tout ce que PieceMaker apporte à Claude Code : skills,
agents et hooks de garde-fou pour travailler sur des dossiers juridiques
(anonymisation, conversion de documents, rédaction française).

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

Tous ces composants sont découverts automatiquement par Claude Code d'après
leur emplacement dans ce dossier — `plugin.json` ne redéclare aucun chemin.

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

## Installation depuis le marketplace

Dans une session Claude Code :

```
/plugin marketplace add PieceMaker-Legal/PieceMaker-Installer
/plugin install piecemaker@piecemaker
```

(équivalent en ligne de commande, hors session interactive :
`claude plugin marketplace add PieceMaker-Legal/PieceMaker-Installer` puis
`claude plugin install piecemaker@piecemaker`.)

L'installeur terminal de PieceMaker (`installer/steps/09-claude-assets.mjs`)
automatise ces deux commandes.

## Skills et agents créés localement

Le plugin installé depuis le marketplace est une **copie figée** du dépôt
publié : un skill ou un agent créé depuis l'administration web (`/admin/`,
onglet Markdown) n'en fait pas partie tant qu'il n'a pas été publié puis
`claude plugin update`.

Pour qu'il soit utilisable tout de suite, PieceMaker l'enregistre aussi dans
les deux emplacements que Claude Code découvre à chaque session :

- `~/.claude/agents/<slug>.md`
- `~/.claude/skills/<slug>/SKILL.md`

Ce sont des **liens symboliques** vers `piecemaker-plugin/` : toute
modification du Markdown (administration ou éditeur) est prise en compte à la
session suivante, sans réinstallation. L'enregistrement a lieu :

- à la création d'un skill ou d'un agent dans l'administration ;
- à chaque enregistrement d'un fichier ;
- au démarrage du serveur et à l'étape `09-claude-assets` de l'installeur ;
- à la demande, via le bouton « ⟳ Claude Code » de l'administration.

Un fichier personnel homonyme déjà présent dans `~/.claude` n'est jamais
écrasé : l'administration affiche alors le badge « Conflit ». Les liens
devenus orphelins (skill supprimé du dépôt) sont nettoyés automatiquement.
Implémentation : `websocket-server/claude-assets.cjs`.

## Mises à jour

- `/plugin marketplace update` rafraîchit le marketplace manuellement.
- Claude Code rafraîchit aussi les marketplaces automatiquement en
  arrière-plan à l'ouverture d'une session — c'est ce qui donne la mise à
  jour automatique du plugin sans action de l'utilisateur.
- La version installée du plugin est fixée par le champ `version` de
  `.claude-plugin/plugin.json` : tant que ce numéro n'est pas incrémenté par
  un mainteneur, les utilisateurs ne reçoivent pas de nouvelle version même
  si le contenu du dépôt évolue. Publier une mise à jour = bumper `version`.

### ⚠️ Dépôt privé + HTTPS = pas de rafraîchissement automatique

Le rafraîchissement automatique en arrière-plan de Claude Code **désactive
les credential helpers Git**. Si ce dépôt reste **privé** et que le
marketplace a été ajouté via une URL **HTTPS** (`https://github.com/...`),
ce rafraîchissement échoue silencieusement à chaque tentative — Claude Code
se rabat alors sur un **clone complet** du dépôt à la prochaine utilisation
explicite (`/plugin marketplace update`), au lieu d'un simple `git pull`
incrémental. Ce n'est pas bloquant, mais ce n'est plus vraiment "automatique"
et c'est plus lent.

**Pour un vrai rafraîchissement automatique sur un dépôt privé**, utilisez
une remote **SSH** avec une clé chargée dans `ssh-agent`
(`git@github.com:PieceMaker-Legal/PieceMaker-Installer.git`) plutôt que
HTTPS — le rafraîchissement en arrière-plan fonctionne alors normalement, y
compris pour un dépôt privé.

Si et quand ce dépôt devient public, cette limitation disparaît : HTTPS
fonctionne sans identifiants pour un accès en lecture seule.

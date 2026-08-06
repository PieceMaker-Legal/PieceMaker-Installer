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
- **Agents** (`agents/`) :
  - `verificateur-anonymisation` — audit lecture seule avant sortie de
    cabinet, confirme l'absence de PII résiduelle.
  - `analyste-piece` — synthèse structurée d'une pièce du dossier.
- **Hooks** (`hooks/hooks.json`) — avertissement PII avant lecture d'un
  document (`PreToolUse`), scan GLiNER après écriture d'un Markdown
  (`PostToolUse`), et suivi de session local (`Stop`/`TaskCompleted`). Tous
  les hooks échouent "ouverts" (fail-open) : aucune erreur, timeout ou
  absence de configuration ne bloque jamais une session.

Tous ces composants sont découverts automatiquement par Claude Code d'après
leur emplacement dans ce dossier — `plugin.json` ne redéclare aucun chemin.

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

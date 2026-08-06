# PieceMaker

Assistant juridique pour professionnels du droit français : anonymisation RGPD
des pièces (GLiNER2 / Presidio, en local), conversion de documents en Markdown,
recherche et rédaction assistées, gestion du dossier et bordereau de pièces.

Le tout s'installe depuis le terminal, sans dépendance autre que Node.js.

## Installation

**macOS / Linux**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/PieceMaker-Legal/PieceMaker-Installer/main/installer/bootstrap/install.sh)
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/PieceMaker-Legal/PieceMaker-Installer/main/installer/bootstrap/install.ps1 | iex
```

> La substitution de processus `bash <(...)` est nécessaire sur macOS/Linux :
> avec `curl … | bash`, l'entrée standard n'est plus un terminal et
> l'installateur bascule en mode non interactif, ce qui saute silencieusement
> toutes les étapes demandant une saisie.

Le script vérifie Node.js, clone le dépôt dans `~/PieceMaker`, installe les
dépendances npm puis ouvre l'installateur interactif. Variables disponibles :
`PIECEMAKER_DIR` (dossier cible), `PIECEMAKER_REF` (branche ou tag).

### Prérequis

| Outil | Version | Nécessaire à |
| --- | --- | --- |
| git | — | amorçage |
| Node.js | 18+ | installateur, serveur |
| Python | 3.10+ | anonymisation, conversion |
| [Claude Code](https://claude.com/claude-code) | — | hooks, plugin, Telegram, superviseur |

Prévoir une vingtaine de minutes et environ 2,5 Go : dépendances npm,
environnement virtuel Python et modèles GLiNER2 + spaCy.

## Ce que fait l'installateur

Dix étapes, exécutables ensemble ou une par une :

| # | Étape | Contenu |
| --- | --- | --- |
| 01 | Prérequis système | Node, Python, git, outils de build |
| 02 | Dépendances Node.js | `npm install` racine et `mcp-server/` |
| 03 | Python, GLiNER & anonymisation | venv, `requirements.txt`, modèles GLiNER2 et spaCy |
| 04 | Conversion en Markdown | markitdown / MinerU pour les PDF scannés |
| 05 | Certificats HTTPS | certificat local requis par Word |
| 06 | Hooks Claude Code | garde-fous PII et suivi de facturation |
| 07 | Serveur MCP Légifrance | clés PISTE, validées en ligne |
| 08 | Plugin Telegram | plugin officiel et token du bot |
| 09 | Plugin Claude Code PieceMaker | marketplace, skills et agents |
| 10 | Superviseur Telegram | une session Claude par projet |

Rien n'est écrit hors de `~/.piecemaker/` et du dépôt ; les secrets vont dans
`.env` en 0600.

## Utilisation directe

Depuis un dépôt déjà cloné :

```bash
npm run install:piecemaker      # menu interactif
npm run check                   # diagnostic, n'installe rien

node installer/bin/piecemaker.mjs --all       # tout installer
node installer/bin/piecemaker.mjs --step 03-python-gliner
node installer/bin/piecemaker.mjs --dry-run --all
```

`--dry-run` affiche les actions sans rien écrire, `--yes` accepte les valeurs
par défaut sans poser de question.

## Plugin Claude Code

Le dépôt est aussi un marketplace de plugin Claude Code. Sans passer par
l'installateur :

```
/plugin marketplace add PieceMaker-Legal/PieceMaker-Installer
/plugin install piecemaker@piecemaker
```

Il apporte les skills d'anonymisation, de conversion et de rédaction
juridique, deux agents dédiés, les hooks de garde-fou PII et le serveur MCP
Légifrance. Voir [`piecemaker-plugin/README.md`](./piecemaker-plugin/README.md).

## Structure

- `installer/` — installateur terminal (aucune dépendance)
- `piecemaker-plugin/` — plugin Claude Code : skills, agents, hooks, MCP
- `orchestrator/` — superviseur Telegram, une session Claude par projet
- `websocket-server/` — serveur HTTPS/WebSocket, API REST et scripts Python
- `taskpane/` — volet Office du complément Word
- `mcp-server/` — serveur MCP exposant les outils document
- `electron/` — enveloppe applicative de bureau

Les repères d'architecture pour contribuer sont dans [`CLAUDE.md`](./CLAUDE.md).

## Licence

MIT — voir [LICENSE](./LICENSE).

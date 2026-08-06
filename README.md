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
dépendances npm, rend la commande `piecemaker` disponible puis ouvre
l'installateur interactif. Variables disponibles :
`PIECEMAKER_DIR` (dossier cible), `PIECEMAKER_REF` (branche ou tag).

### Prérequis

| Outil | Version | Nécessaire à |
| --- | --- | --- |
| git | — | amorçage |
| Node.js | 18+ | installateur, serveur |
| Python | 3.10+ | anonymisation, conversion |
| [Claude Code](https://claude.com/claude-code) | — | hooks, plugin et Assistant Bot Telegram |

Prévoir une vingtaine de minutes et environ 2,5 Go : dépendances npm,
environnement virtuel Python et modèles GLiNER2 + spaCy.

## Ce que fait l'installateur

Dix étapes, exécutables ensemble ou une par une :

| # | Étape | Contenu |
| --- | --- | --- |
| 00 | Dossier racine PieceMaker | choix de la racine contenant un sous-dossier par dossier juridique |
| 01 | Prérequis système | Node, Python, git, outils de build |
| 02 | Dépendances Node.js | `npm install` racine et `mcp-server/` |
| 03 | Python, GLiNER & anonymisation | venv, `requirements.txt`, modèles GLiNER2 et spaCy |
| 04 | Conversion en Markdown | markitdown / MinerU pour les PDF scannés |
| 05 | Certificats HTTPS | certificat local requis par Word |
| 06 | Hooks Claude Code | garde-fous PII et suivi de facturation |
| 07 | Serveur MCP Légifrance | clés PISTE, validées en ligne |
| 08 | Telegram | Assistant Bot à la racine de PieceMaker + daemon de surveillance nommable, sans LLM |
| 09 | Plugin Claude Code PieceMaker | marketplace, skills et agents |

Les secrets Telegram vont dans `~/.claude/channels/` en 0600. Sur macOS, le
daemon est installé comme service utilisateur dans `~/Library/LaunchAgents/`.

## Utilisation

Après l’installation, une seule commande donne accès aux opérations courantes
et au sous-menu d’installation/réparation :

```bash
piecemaker
```

L’interface graphique locale permet de modifier les paramètres, les skills et
les agents Markdown, mais aussi d’inspecter chaque dossier juridique indépendant,
ses pièces originales et leur état de protection GLiNER, ainsi que ses commits
automatiques représentant chacun l’état complet du dossier. La commande suivante démarre le serveur si nécessaire et
ouvre directement cette interface dans le navigateur :

```bash
piecemaker open
```

Commandes directes disponibles :

```bash
piecemaker start          # serveur HTTPS en arrière-plan
piecemaker stop
piecemaker status
piecemaker logs
piecemaker doctor         # diagnostic sans modification
piecemaker install        # installation ou réparation
piecemaker update
```

Le tableau de bord est servi uniquement en local sur
`https://localhost:43098/admin/`. Le volet Word reste disponible sur
`https://localhost:43098/taskpane.html`.

### Depuis un dépôt déjà cloné

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
- `orchestrator/` — Assistant Bot Telegram et daemon de surveillance sans LLM
- `websocket-server/` — serveur HTTPS/WebSocket, API REST et scripts Python
- `admin/` — interface web locale pour les paramètres, skills et agents
- `taskpane/` — volet Office du complément Word
- `mcp-server/` — serveur MCP exposant les outils document
- `electron/` — ancien client de bureau, conservé comme archive mais désactivé

Les repères d'architecture pour contribuer sont dans [`CLAUDE.md`](./CLAUDE.md).

## Licence

MIT — voir [LICENSE](./LICENSE).

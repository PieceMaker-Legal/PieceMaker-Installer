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
| [Claude Code](https://claude.com/claude-code) | — | hooks, skills, agents et Assistant Bot Telegram |

Prévoir une vingtaine de minutes et environ 2,5 Go : dépendances npm,
environnement virtuel Python et modèles GLiNER2 + spaCy.

## Ce que fait l'installateur

Étapes exécutables ensemble ou une par une :

| # | Étape | Contenu |
| --- | --- | --- |
| 00-identite | Identification de l’utilisateur | signe chaque tâche enregistrée dans l’historique avec votre nom |
| 01-prerequis | Prérequis système | vérifie Node.js, npm, git et Python avant toute installation |
| 02-dependances-node | Dépendances Node.js | installe les modules npm de la racine et du serveur MCP |
| 03-python-gliner | Python, GLiNER & anonymisation | venv Python, dépendances et modèles GLiNER |
| 04-conversion-md | Conversion de documents en Markdown | vérifie markitdown/pypdf et propose MinerU pour les PDF scannés |
| 05-certificats | Certificats HTTPS | génère le certificat local requis par Word |
| 06-hooks | Hooks Claude Code (anonymisation, commits & facturation) | configure les garde-fous, les commits PostToolUse et le suivi de facturation |
| 07-legifrance | Serveur MCP Légifrance (clés PISTE) | configure et valide l’accès à l’API Légifrance via PISTE |
| 08-telegram | Telegram — Assistant Bot et daemon | configure le bot conversationnel PieceMaker et son daemon de surveillance séparé |
| 09-claude-assets | Composants Claude Code PieceMaker | enregistre les skills, agents et hooks PieceMaker lorsque Claude Code est présent |
| 09-codex-plugin | Skills Codex PieceMaker | enregistre les skills PieceMaker lorsque la CLI Codex est présente |
| 10-libreoffice | Conversion des pièces en PDF (LibreOffice) | installe LibreOffice, requis pour tamponner les pièces Excel et Word |
| 11-document-skills | Skill docx (documents Word) | installe et active le plugin officiel document-skills |
| 12-word-taskpane | Ouverture automatique du volet Word | permet à PieceMaker d’ouvrir Word avec le volet déjà affiché |
| 13-garde-secrets | Garde-fou secrets (Claude Code) | empêche Claude Code de lire le `.env` du serveur |
| 14-mxc-sandbox | Confinement OS (mxc) | construit microsoft/mxc pour isoler la session Claude Code |

Les secrets Telegram vont dans `~/.claude/channels/` en 0600. Sur macOS, le
daemon est installé comme service utilisateur dans `~/Library/LaunchAgents/`.

## Utilisation

Après l’installation, une seule commande donne accès aux opérations courantes
et au sous-menu d’installation/réparation :

```bash
piecemaker
```

L’interface graphique locale permet de modifier les paramètres et l’identité
qui signe les tâches, configurer
séparément l’Assistant Telegram général et son bot de surveillance sans LLM,
puis lier chaque sous-dossier juridique à son propre Assistant Telegram. Elle
permet aussi de rédiger les skills et agents dans un éditeur Markdown visuel
(sans afficher les marqueurs `#`). Les synthèses de facturation y sont
consultables en lecture seule. Les noms des pièces originales n’y sont affichés
qu’après application du mapping d’anonymisation ; à défaut, un nom générique est
utilisé. L’interface permet enfin d’inspecter chaque dossier juridique
indépendant, de choisir pièce par pièce ce que l’IA n’a pas le droit d’ouvrir
(tout ce qui n’est ni Markdown ni JSON est protégé par défaut) et de consulter
ses commits automatiques représentant chacun l’état complet du dossier. La commande suivante démarre le serveur si
nécessaire et ouvre directement cette interface dans le navigateur :

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

## Claude Code et Codex CLI

PieceMaker n'installe aucun manifest ni marketplace pour ses propres
composants. Lorsque la CLI correspondante est présente, l'installateur lie les
skills dans `~/.claude/skills` et `~/.codex/skills`, ainsi que les agents dans
`~/.claude/agents`. Les hooks Claude sont fusionnés directement dans
`~/.claude/settings.json`. Les fichiers personnels homonymes sont conservés.

Les composants comprennent les skills d'anonymisation, de conversion, de
rédaction juridique et de tamponnage des pièces, deux agents Claude dédiés et
les hooks de garde-fou PII. Voir
[`piecemaker-plugin/README.md`](./piecemaker-plugin/README.md).

## Structure

- `installer/` — installateur terminal (aucune dépendance)
- `piecemaker-plugin/` — composants partagés : skills, agents, hooks, MCP
- `orchestrator/` — Assistant Bot Telegram et daemon de surveillance sans LLM
- `websocket-server/` — serveur HTTPS/WebSocket, API REST et scripts Python
- `admin/` — interface web locale : Telegram, paramètres, éditeur visuel des skills/agents et aperçus de facturation
- `taskpane/` — volet Office du complément Word
- `mcp-server/` — serveur MCP exposant les outils document

Le `CLAUDE.md` racine est versionné dans ce dépôt et contient les repères
d'architecture pour contribuer à la code base. La persona destinée à
l'utilisateur est disponible dans le gabarit versionné
`installer/templates/root-CLAUDE.md`.

## Licence

MIT — voir [LICENSE](./LICENSE).

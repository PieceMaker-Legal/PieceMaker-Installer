# PieceMaker

## Quel est le concept PieceMaker ?

PieceMaker est une **couche locale qui enveloppe un LLM utilisé en ligne de
commande**, comme Claude Code ou Codex CLI. Il ne remplace pas le modèle et
n'impose pas une logique métier particulière : il lui fournit un environnement
de travail sécurisé, traçable et accessible depuis une interface graphique.

```text
LLM en ligne de commande
        enveloppé par
              │
          PieceMaker
              │
Sécurité · Suivi du dossier · Interface graphique
              │
       enrichi avec
              │
    Skills · MCP · Agents
```

Cette couche repose sur trois modules.

### 1. Sécurité

- **Fichiers originaux inaccessibles au LLM** : les pièces sources sont
  protégées. Le modèle travaille sur leurs représentations autorisées, notamment
  les conversions en Markdown, sans ouvrir directement les originaux.
- **Anonymisation locale avec GLiNER et Presidio** : les entités sensibles sont
  détectées puis associées à des codes stables.
- **Hooks d'entrée et de sortie** : ils anonymisent les informations avant
  qu'elles soient transmises au modèle et les rétablissent au retour. En
  pratique, le LLM voit des codes tandis que l'utilisateur voit les noms réels.
- **Confinement du processus** : les garde-fous applicatifs peuvent être
  complétés par une isolation au niveau du système d'exploitation.

### 2. Suivi du travail réalisé dans chaque dossier

PieceMaker reprend le principe de suivi de Git et GitHub. Chaque dossier est
un espace de travail autonome et chaque tâche réalisée est enregistrée dans son
historique avec un commentaire et l'identité de son auteur.

L'utilisateur peut ainsi retrouver l'état complet du dossier à chaque étape,
comprendre ce qui a été fait et suivre son évolution dans le temps. Cet
historique est local : son fonctionnement ne dépend pas d'un hébergement sur
GitHub.

### 3. Interface graphique

Une interface web locale permet de piloter PieceMaker sans manipuler
directement ses fichiers de configuration. Elle centralise notamment :

- les dossiers et leurs pièces ;
- les règles d'accès et l'anonymisation ;
- l'historique des tâches ;
- l'identité, les paramètres et les intégrations ;
- l'édition des skills et des agents.

## Une base à laquelle ajouter sa logique métier

Les trois modules constituent le socle de PieceMaker. L'utilisateur peut
ensuite adapter le comportement du LLM à son activité en ajoutant :

- des **skills**, pour décrire des savoir-faire et des procédures ;
- des **serveurs MCP**, pour donner accès à des outils et sources de données ;
- des **agents**, pour confier des rôles ou processus spécialisés.

PieceMaker fournit déjà des composants destinés aux professionnels du droit
français : conversion et anonymisation des pièces, rédaction juridique,
tamponnage et gestion des bordereaux. Un **serveur MCP Légifrance est intégré
directement** ; l'installateur configure son accès à l'API via PISTE.

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

### Détail des étapes

Étapes exécutables ensemble ou une par une :

| # | Étape | Contenu |
| --- | --- | --- |
| 00-identite | Identification de l’utilisateur | signe chaque tâche enregistrée dans l’historique avec votre nom |
| 01-prerequis | Prérequis système | vérifie Node.js, npm, git et Python avant toute installation |
| 02-dependances-node | Dépendances Node.js | installe les modules npm de la racine et du serveur MCP |
| 03-python-gliner | Python, GLiNER & anonymisation | venv Python, dépendances et modèles GLiNER |
| 03b-python-graphify | Graphify (graphe juridique) | venv Python séparé, installe le fork Graphify PieceMaker-Legal à un tag figé |
| 04-conversion-md | Conversion de documents en Markdown | vérifie markitdown/pypdf et propose MinerU pour les PDF scannés |
| 05-certificats | Certificats HTTPS | génère le certificat local requis par Word |
| 06-hooks | Hooks Claude Code (protection, commits & facturation) | configure les garde-fous, les commits PostToolUse et le suivi de facturation ; le mapping relève du proxy PII |
| 07-legifrance | Serveur MCP Légifrance (clés PISTE) | configure et valide l’accès à l’API Légifrance via PISTE |
| 08-telegram | Telegram — Assistant Bot et daemon | configure le bot conversationnel PieceMaker et son daemon de surveillance séparé |
| 09-claude-assets | Composants Claude Code PieceMaker | enregistre les skills, agents et hooks PieceMaker lorsque Claude Code est présent |
| 09-codex-plugin | Skills Codex PieceMaker | enregistre les skills PieceMaker lorsque la CLI Codex est présente |
| 10-libreoffice | Conversion des pièces en PDF (LibreOffice) | installe LibreOffice, requis pour tamponner les pièces Excel et Word |
| 10-pandoc | Génération PDF/DOCX (pandoc + typst) | installe pandoc et typst, utilisés pour l’export de la chronologie et de l’historique |
| 11-document-skills | Skill docx (documents Word) | installe et active le plugin officiel document-skills |
| 12-word-taskpane | Ouverture automatique du volet Word | permet à PieceMaker d’ouvrir Word avec le volet déjà affiché |
| 13-garde-secrets | Garde-fou secrets (Claude Code) | empêche Claude Code de lire le `.env` du serveur et le mapping central |
| 14-mxc-sandbox | Confinement OS (mxc) | construit microsoft/mxc pour isoler la session Claude Code |
| 15-pwa-desktop | Application PieceMaker sur le Bureau | propose une icône qui démarre le serveur avant d’ouvrir l’administration |
| 16-litellm-proxy | Proxy PII LiteLLM — Claude Code & Codex | installe la passerelle locale, applique le mapping central et route automatiquement les deux clients |

Les secrets Telegram vont dans `~/.claude/channels/` en 0600. Sur macOS, le
daemon est installé comme service utilisateur dans `~/Library/LaunchAgents/`.
Le rapport de cycle `orchestrator/report-cycle.mjs` est un hook `Stop`
facultatif : l'installateur ne l'ajoute pas automatiquement à
`settings.json`. Pour l'activer dans une session lancée par le daemon, ajoutez
manuellement une commande `node "/chemin/vers/PieceMaker/orchestrator/report-cycle.mjs"`
au hook `Stop` ; le token et le destinataire sont alors ceux du bot de
surveillance (ou `LORD_ENV` et `CHAT_ID` si vous les surchargez).

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

## Utilisation

Après l’installation, une seule commande donne accès aux opérations courantes
et au sous-menu d’installation/réparation :

```bash
piecemaker
```

Depuis l’interface graphique, l’utilisateur peut notamment :

- inspecter séparément chaque dossier juridique, ses pièces et l’historique de
  ses tâches ;
- choisir les documents que l’IA n’a pas le droit d’ouvrir — tout ce qui n’est ni
  Markdown ni JSON est protégé par défaut ;
- lancer l’anonymisation et gérer le mapping des noms ;
- modifier l’identité qui signe les tâches et les autres paramètres ;
- rédiger ses skills et ses agents dans un éditeur Markdown visuel ;
- configurer l’Assistant Telegram, son bot de surveillance sans LLM et les
  assistants propres à chaque dossier ;
- consulter les synthèses de facturation en lecture seule.

Les noms des pièces originales ne sont affichés qu’après application du mapping
d’anonymisation ; à défaut, un nom générique est utilisé. La commande suivante
démarre le serveur si nécessaire et ouvre l’interface dans le navigateur :

```bash
piecemaker open
```

Commandes directes disponibles :

```bash
piecemaker start          # serveur HTTPS en arrière-plan
piecemaker stop
piecemaker restart
piecemaker status
piecemaker logs
piecemaker conversion "nom de la pièce.pdf" # convertit et pseudonymise cette pièce
piecemaker conversion                       # traite seulement les pièces manquantes
piecemaker graph query "Montre-moi la chronologie et les liens de droit du dossier"
piecemaker graph build     # prépare explicitement le graphe juridique riche
piecemaker graph status    # vérifie s'il doit être actualisé
piecemaker doctor         # diagnostic sans modification
piecemaker install        # installation ou réparation
piecemaker update
```

Les commandes `conversion` et `graph` se lancent depuis un dossier juridique
enregistré (ou avec `--case <chemin>`). `piecemaker conversion` enchaîne la
conversion Markdown et le scan PII afin de produire un contenu pseudonymisé
directement exploitable par Graphify. Un ou plusieurs noms ou chemins relatifs
peuvent être indiqués ; sans nom, seules les pièces dont la conversion ou le
scan manque sont traitées.

La première requête `graph` construit le graphe riche avec le
backend LLM configuré pour Graphify ; les suivantes réutilisent le cache tant
que les pièces, leur index ou le prompt juridique n'ont pas changé. Chaque
pièce est reliée aux personnes physiques ou morales détectées, puis aux
contrats, obligations, inexécutions, demandes, moyens, normes et décisions
qu'elle matérialise ou rapporte. La sortie conserve les distinctions
`ALLEGUE`, `CONTESTE`, `JUGE`, `INFERRE` et `A_VERIFIER`.

Ce graphe juridique est distinct du graphe léger de la frise : la frise ne
contient que les mentions GLiNER et n'appelle aucun LLM. Dans les deux cas, les
noms de fichiers persistants sont remplacés par des empreintes et les personnes
par leurs codes pseudonymisés. `piecemaker graph query` fonctionne sans MCP,
sans serveur PieceMaker et sans Word ouvert.

Le tableau de bord est servi uniquement en local sur
`https://localhost:43098/admin/`. Il peut être installé comme PWA. L’icône
Bureau proposée par l’installateur démarre le serveur avant de l’ouvrir ; si
une PWA déjà ouverte détecte le serveur arrêté, sa page de secours propose le
même redémarrage local. Le volet Word reste réservé au fonctionnement interne
de l’add-in et n’est pas proposé dans l’administration.

Pour travailler sur un document depuis Codex ou Claude Code, l'étape
`12-word-taskpane` enregistre automatiquement le MCP `piecemaker-word` dans les
CLI installées. Il suffit de lancer normalement `codex` ou `claude`, puis de
demander l'ouverture du `.docx`. Au premier `open_doc`, le MCP démarre le
serveur PieceMaker local s'il est arrêté, puis ouvre Word et son volet.
`open_doc` renvoie le `paneId` à transmettre ensuite à chaque appel `read_doc`
ou `edit_doc`. Aucun lanceur ni démarrage PieceMaker intermédiaire n'est
nécessaire.

## Intégration avec Claude Code et Codex CLI

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
- `litellm-proxy/` — application LiteLLM standard entourée du mapping PII réseau PieceMaker

Le `CLAUDE.md` racine est versionné dans ce dépôt et contient les repères
d'architecture pour contribuer à la code base. La persona destinée à
l'utilisateur est disponible dans le gabarit versionné
`installer/templates/root-CLAUDE.md`.

## Licence

MIT — voir [LICENSE](./LICENSE).

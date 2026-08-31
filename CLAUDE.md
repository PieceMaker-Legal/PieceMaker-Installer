# PieceMaker — repères d'architecture (code base)

Ce fichier, versionné dans ce dépôt, oriente le travail **sur le code** de
PieceMaker. La persona utilisateur (« Avocat ») est disponible dans le template
versionné `installer/templates/root-CLAUDE.md`.

## Audit du projet

Le rapport complet de l'audit du code, avec les résultats Graphify, les éléments
obsolètes, les défauts confirmés et les limites de l'analyse, est disponible
dans [`docs/AUDIT-Project.md`](docs/AUDIT-Project.md).

## Ce qu'est ce dépôt

Un monorepo qui est à la fois :
- un **installateur terminal** (`piecemaker`) qui clone le projet dans
  `~/PieceMaker`, installe les dépendances et configure la machine ;
- un **serveur local** HTTPS/WebSocket (port `43098`) exposant l'API et
  l'administration web ;
- un **marketplace de plugin Claude Code** (`piecemaker-plugin/`) : skills,
  agents, hooks de garde-fou PII et serveur MCP Legifrance.

Cible : assistant juridique local (RGPD) — anonymisation, conversion en
Markdown, rédaction et tamponnage de pièces. Node ≥ 18, Python ≥ 3.10.

## Deux clones

- **Développement** : `~/Sites/PieceMaker-Installer` (ce dépôt) — pas de
  `.env`, pas de certificats. On y travaille le code.
- **Exécution** : `~/PieceMaker` (port 43098) — clone servant l'utilisateur ;
  possède son `.env` et ses certificats. `.env` est propre à chaque clone.

## Composants

| Dossier | Rôle |
| --- | --- |
| `installer/` | Installateur terminal, sans dépendance. `bin/piecemaker.mjs` = commande + orchestrateur ; `steps/00..16-*.mjs` = étapes idempotentes (`{ meta, install, check }`), jouées dans l'ordre du nom ; `lib/` = UI, prompts, plateforme, état ; `templates/` = templates déposés chez l'utilisateur. |
| `websocket-server/` | `server.cjs` (Express + HTTPS + WS). `admin-routes.cjs` = API d'administration ; `case-registry.cjs`, `document-index.cjs`, `originals-pipeline.cjs` = dossiers/pièces ; `mxc-sandbox.cjs` = bac à sable OS ; `scripts/` = Python (GLiNER/Presidio, conversion). |
| `admin/` | Interface web locale servie sur `/admin/` (`app.js`, `index.html`, éditeur Markdown des skills/agents, aperçus facturation). |
| `orchestrator/` | Assistant Bot Telegram (`piecemaker-daemon.mjs`) et surveillance de quotas (`limit-watch.mjs`), sans LLM. |
| `piecemaker-plugin/` | Plugin Claude Code : `skills/`, `agents/`, `hooks/hooks.json`, `mcp/` (Legifrance), `scripts/` (logique des hooks) + `scripts/lib/` (mapping, protection, commits, facturation…). |
| `litellm-proxy/` | Proxy LiteLLM officiel entouré du middleware PII PieceMaker ; pass-through des authentifications Claude Code/Codex, sans stockage de leurs jetons. |

### Limite de responsabilité du proxy

LiteLLM reste l'unique implémentation du proxy, des transports et des
protocoles LLM, y compris HTTP, SSE et WebSocket. PieceMaker peut configurer ou
brancher les capacités fournies par LiteLLM, mais ne doit jamais réimplémenter
un client, un serveur ou un relais de transport au-dessus de lui. Le seul code
spécifique autorisé sur les échanges est l'anonymisation des requêtes et la
ré-identification des réponses.

Archives à ignorer : `admin.backup-*`, `_mxc_hooktest/`, `ARCHITECTURE_FIX.md`,
`central-hook-haiku-test.md`.

## Flux clé — outils document (`.docx`)

Le pont Word (complément Office + serveur MCP dédié, anciennement
`taskpane/` et `mcp-server/` dans ce dépôt) a été extrait vers un dépôt séparé
et indépendant, **actuellement suspendu** — il n'y a plus de volet Word ni de
`paneId` dans ce dépôt. Tout travail sur un `.docx` (rédaction, relecture,
correction de style, suivi des modifications) passe par le skill `docx-cli`
(dépôt `kklimuk/docx-cli`, installé par l'étape `11-docx-cli`) : Bash + le
binaire `docx`, qui mute l'OOXML **en place** (styles maison, couleurs de
thème et objets embarqués préservés), adresse le contenu par localisateurs
stables et expose les modifications suivies (`docx track-changes`), sans
application Word ouverte. Voir `piecemaker-plugin/skills/redaction-juridique/SKILL.md` et
`piecemaker-plugin/skills/tamponnage/SKILL.md` pour le détail de ce que ce
skill couvre et de ce qu'il ne couvre pas (le tamponnage live depuis un volet
Word, notamment, n'a pas d'équivalent tant que le dépôt séparé n'est pas
réactivé — le tamponnage passe uniquement par l'administration web).

## Anonymisation (invariant central)

**Le modèle ne voit que des codes ; le cabinet ne voit que des noms.** Les
fichiers restent en clair sur le disque ; ce sont les entrées/sorties d'outil
qui sont réécrites au passage.

- Voies **Claude Code et Codex** : le proxy PII LiteLLM code les requêtes avant
  leur transmission au fournisseur et ré-identifie les réponses avant leur
  restitution locale. Aucun hook Claude Code n'applique le mapping.
- Voie **serveur local** : hors de portée des hooks ; le pipeline
  d'anonymisation des pièces (`websocket-server/originals-pipeline.cjs`,
  `document-index.cjs`, `legal-graph.cjs`, `mxc-sandbox.cjs`,
  `lib/anonymization-server.cjs`) applique le mapping via
  `piecemaker-plugin/scripts/lib/mapping.cjs`.
- Le mapping central dé-conflicté `~/.piecemaker/central-mapping.json` est
  reconstruit par le serveur et rechargé à chaud par le proxy.
- Le **scan** GLiNER/Presidio n'est lancé que depuis l'administration
  (« Anonymiser & mapper ») — jamais par les hooks. **Un seul processus de scan
  à la fois** : le parallèle rend la machine inutilisable.
- Substitution triée de l'entité la plus longue à la plus courte, sinon
  « Dupont » corrompt « Jean Dupont-Martin ». Un code n'est jamais réattribué.

Les hooks de protection (`protect-originals.mjs`) refusent la lecture de toute
pièce non `.md`/`.json`. Attention : `deny` seul est contournable
(`$VAR`, `python`, `cd` relatif, `find -exec`) — la garde dure passe au
niveau OS (Seatbelt / `mxc-sandbox.cjs`).

## Installateur

`piecemaker.mjs` découvre `installer/steps/*.mjs` et les joue dans l'ordre du
nom. Chaque étape exporte `{ meta, install(ctx), check(ctx) }` et renvoie
`{ status, note }` avec `status` ∈ `done | partial | failed | skipped`.
`check()` alimente `piecemaker doctor` sans rien modifier. `--dry-run`
n'écrit rien ; `--yes` accepte les défauts (non interactif).

Piège plugin : `claude plugin update` sort 0 même sans recopier — le cache est
clé par la version de `piecemaker-plugin/.claude-plugin/plugin.json`. Une
modif sans bump de version laisse le cache périmé (hooks inertes). L'étape 09
vérifie l'empreinte via `plugin-refresh.mjs`, jamais le seul code de sortie.

## Commandes de développement

```bash
npm test                 # node --test sur test/*.test.* (concurrency 4, ~4 min)
                         # à déléguer à l'agent test-piecemaker (Haiku, ~/.claude/agents/)
npm run server           # lance server.cjs directement
npm run check            # diagnostic installateur, n'installe rien
node installer/bin/piecemaker.mjs --dry-run --all
node installer/bin/piecemaker.mjs --step 09-claude-assets
piecemaker start | stop | status | logs | doctor
```

Admin : `https://localhost:43098/admin/` (local uniquement).

## Conventions

- **Commits directs sur `main`** — pas de branche ni de PR sur ce dépôt. Ne
  pousser que sur demande.
- Tout en **français** (code, commentaires, messages), style existant.
- Tests : `node --test` (`.test.cjs` / `.test.mjs`), sans framework externe.
- `.env`, mappings et données client ne sont **jamais** versionnés (voir
  `.gitignore`) — ce sont des données réelles.

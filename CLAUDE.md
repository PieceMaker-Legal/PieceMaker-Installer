# PieceMaker — repères d'architecture (code base)

Ce fichier oriente le travail **sur le code** de PieceMaker. Il est gitignoré :
il vit dans le clone de développement et n'est jamais poussé. La persona
utilisateur (« Avocat ») livrée au clone d'exécution est le gabarit versionné
`installer/templates/root-CLAUDE.md`, déposé par l'étape d'installation 09.

## Ce qu'est ce dépôt

Un monorepo qui est à la fois :
- un **installateur terminal** (`piecemaker`) qui clone le projet dans
  `~/PieceMaker`, installe les dépendances et configure la machine ;
- un **serveur local** HTTPS/WebSocket (port `43098`) exposant l'API,
  l'administration web et un pont vers le volet Word ;
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
| `installer/` | Installateur terminal, sans dépendance. `bin/piecemaker.mjs` = commande + orchestrateur ; `steps/00..14-*.mjs` = étapes idempotentes (`{ meta, install, check }`), jouées dans l'ordre du nom ; `lib/` = UI, prompts, plateforme, état ; `templates/` = gabarits déposés chez l'utilisateur. |
| `websocket-server/` | `server.cjs` (Express + HTTPS + WS). `admin-routes.cjs` = API d'administration ; `case-registry.cjs`, `document-index.cjs`, `originals-pipeline.cjs` = dossiers/pièces ; `central-hook-install.cjs` + `global-hooks/` = hook global d'anonymisation ; `mxc-sandbox.cjs` = bac à sable OS ; `scripts/` = Python (GLiNER/Presidio, conversion). |
| `admin/` | Interface web locale servie sur `/admin/` (`app.js`, `index.html`, éditeur Markdown des skills/agents, aperçus facturation). |
| `taskpane/` | Complément Office (volet Word). `taskpane.js` reçoit les ordres MCP par WebSocket et agit sur le document ; `modules/anonymization-server.cjs` = mapping côté volet. |
| `mcp-server/` | `mcp-server-local.js` : serveur MCP (stdio) qui **relaie** les outils document vers le serveur HTTPS local. |
| `orchestrator/` | Assistant Bot Telegram (`piecemaker-daemon.mjs`) et surveillance de quotas (`limit-watch.mjs`), sans LLM. |
| `piecemaker-plugin/` | Plugin Claude Code : `skills/`, `agents/`, `hooks/hooks.json`, `mcp/` (Legifrance), `scripts/` (logique des hooks) + `scripts/lib/` (mapping, protection, commits, facturation…). |

Archives à ignorer : `electron/` (ancien client désactivé),
`admin.backup-*`, `_mxc_hooktest/`, `ARCHITECTURE_FIX.md`,
`central-hook-haiku-test.md`.

## Flux clé — outils document (Word)

Les outils MCP `read_doc` / `edit_doc` ne touchent jamais le disque
directement :

```
Claude Code ──stdio──▶ mcp-server-local.js ──HTTPS POST──▶ server.cjs
                                                              │ WebSocket
                                                              ▼
                                                        taskpane.js (Word)
```

Conséquence : ces outils supposent `piecemaker start` **et** Word ouvert sur
le document. Sans cela l'appel échoue — vérifier `piecemaker status` avant de
conclure à un bug.

## Anonymisation (invariant central)

**Le modèle ne voit que des codes ; le cabinet ne voit que des noms.** Les
fichiers restent en clair sur le disque ; ce sont les entrées/sorties d'outil
qui sont réécrites au passage.

- Voie **Claude Code** : hooks du plugin — `anonymize-read.mjs` (PostToolUse
  sur Read/Grep/Glob/Bash) code la sortie ; `deanonymize-write.mjs` (PreToolUse
  sur Write/Edit et l'outil `reply` Telegram) rétablit les vrais noms.
- Voie **Word** : hors de portée des hooks ; `server.cjs` applique le même
  mapping via `piecemaker-plugin/scripts/lib/mapping.cjs`.
- Un **hook global** unique (`~/.claude`, installé par `central-hook-install.cjs`)
  applique le mapping central dé-conflicté `~/.piecemaker/central-mapping.json`
  à toute session, remplaçant les hooks par-dossier.
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
npm test                 # node --test sur test/*.test.* (concurrency 4)
npm run server           # lance server.cjs directement
npm run check            # diagnostic installateur, n'installe rien
node installer/bin/piecemaker.mjs --dry-run --all
node installer/bin/piecemaker.mjs --step 09-claude-assets
piecemaker start | stop | status | logs | doctor
```

Admin : `https://localhost:43098/admin/` (local uniquement).
Volet Word : `https://localhost:43098/taskpane.html`.

## Conventions

- **Commits directs sur `main`** — pas de branche ni de PR sur ce dépôt (sauf
  la branche `sessions/auto` du hook de fin de session). Ne commiter/pousser
  que sur demande.
- Tout en **français** (code, commentaires, messages), style existant.
- Tests : `node --test` (`.test.cjs` / `.test.mjs`), sans framework externe.
- `.env`, mappings et données client ne sont **jamais** versionnés (voir
  `.gitignore`) — ce sont des données réelles.

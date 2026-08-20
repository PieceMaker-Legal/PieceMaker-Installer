# Audit complet du projet PieceMaker-Installer

- Date de l'audit : 19–20 août 2026
- Branche de restitution : `AUDIT-Project`
- Révision auditée : `c682c2d` (`main`), avec les modifications locales préexistantes décrites ci-dessous
- Nature de l'intervention : audit en lecture seule du code ; aucun correctif appliqué

## Résumé exécutif

L'audit a combiné trois passes indépendantes : recherche de code obsolète,
recherche de code cassé et analyse structurelle Graphify. Il a relevé :

- 12 groupes de problèmes confirmés ;
- 3 candidats supplémentaires qui nécessitent une décision produit ;
- 3 tests d'interface actuellement en échec à cause d'attentes restées sur
  l'ancien modèle de protection à deux états ;
- aucune erreur de syntaxe JavaScript, Python, Bash ou JSON ;
- aucune erreur de validation du manifeste Office ;
- aucun cycle d'import détecté par Graphify.

Les défauts les plus importants sont l'intégration Codex/Telegram non portable,
la documentation de sécurité qui décrit des hooks désormais absents du plugin,
et la divergence entre les tests de l'administration et le nouveau modèle de
pièces à trois états.

## Périmètre et état initial

Le dépôt contient l'installateur, le serveur HTTPS/WebSocket, l'administration
web, le volet Word, le serveur MCP local, l'orchestrateur Telegram, le plugin
Claude Code et les scripts Python d'anonymisation.

Les dépendances générées (`node_modules`), secrets, certificats, données client
et sorties de build ont été exclus de l'inspection source.

Au début de l'audit, les neuf fichiers suivants étaient déjà modifiés. Ils
n'ont pas été rétablis ni intégrés au commit du présent rapport :

```text
admin/app.js
admin/styles.css
piecemaker-plugin/scripts/lib/commits.cjs
piecemaker-plugin/scripts/lib/protection.cjs
test/originals-pipeline.test.cjs
test/protection.test.cjs
websocket-server/admin-routes.cjs
websocket-server/document-index.cjs
websocket-server/originals-pipeline.cjs
```

## Résultats confirmés

### 1. Intégration Codex/Telegram liée à une machine particulière

Sévérité : haute

Confiance : haute

`orchestrator/codex-session-runner.mjs:13` importe directement :

```text
file:///Users/tsardet/Sites/impt-trader/bot/telegram-codex.mjs
```

Le même fichier code en dur quatre dossiers sous `/Users/tsardet/Sites`, un
répertoire NVM et `/Users/tsardet/.local/bin/codex` aux lignes 15–20 et 67–83.
`orchestrator/codex-addon.mjs:176-184` répète des valeurs de `PATH` et
`CODEX_BIN` propres à la même machine.

L'orchestrateur actif appelle ce runner. La configuration générale des projets
est pourtant fournie par `~/.piecemaker/orchestrator/projects.json` dans
`orchestrator/config.mjs`. Un autre poste peut configurer correctement ses
projets et échouer tout de même au démarrage de la session Codex, car le runner
ignore ces chemins pour son import et sa propre table de projets.

Impact : les commandes Telegram `/codex`, `/start-codex` et `/restart-codex`
ne sont pas portables et peuvent échouer sur toute installation qui ne reproduit
pas exactement l'arborescence du poste de développement.

### 2. Documentation de sécurité en désaccord avec les hooks réellement câblés

Sévérité : haute

Confiance : haute

`docs/anonymisation-hooks.md:30-39` affirme que quatre hooks sont enregistrés
dans `piecemaker-plugin/hooks/hooks.json`, notamment :

- `anonymize-read.mjs` en `PostToolUse` pour `Read|Grep|Glob|Bash` ;
- `deanonymize-write.mjs` en `PreToolUse` pour `Write|Edit` et Telegram.

Le fichier réel `piecemaker-plugin/hooks/hooks.json:14-40` n'enregistre aucun
de ces deux scripts. Ses hooks `PostToolUse` sont `track-legifrance-reads.mjs`,
`commit-track.mjs` et `compile-recherche.mjs`.

Le dépôt possède maintenant une architecture de hook central global, mais le
document continue d'affirmer que ces protections sont directement portées par
le plugin. Il s'agit d'une documentation de frontière de confidentialité ; son
obsolescence peut conduire à vérifier ou diagnostiquer le mauvais mécanisme.

### 3. Trois tests de l'administration ne décrivent plus l'interface courante

Sévérité : moyenne

Confiance : haute

Commande de reproduction :

```bash
node --test test/admin-interface.test.cjs
```

Résultat : 18 tests, 15 réussis, 3 échoués.

Les échecs se trouvent dans `test/admin-interface.test.cjs` :

- ligne 149 : recherche encore un tri binaire basé sur
  `a.protected !== b.protected` ;
- ligne 178 : recherche la construction exacte des badges et l'ancien
  `shieldButton` ;
- ligne 189 : impose encore une mosaïque CSS à deux colonnes.

Les modifications locales préexistantes de `admin/app.js` et
`admin/styles.css` introduisent trois états (`vault`, `workspace`, `resource`),
un `stateSelector` et trois colonnes. Les fonctions et styles attendus ont donc
été remplacés, alors que les tests n'ont pas été mis à jour.

Impact : la suite CI est rouge sur l'état de travail actuel. L'audit ne conclut
pas à une régression fonctionnelle de l'interface ; il confirme une divergence
entre les tests et la nouvelle spécification en cours de travail.

### 4. Points d'entrée de build Electron garantis en échec

Sévérité : moyenne

Confiance : haute

`build.sh:3-5` et `build.bat:2-4` quittent immédiatement avec un code 1 après
avoir indiqué que l'interface Electron est désactivée. Tout le menu placé après
ces sorties est inatteignable.

Ce code mort invoque par ailleurs :

- `npm run build` ;
- `npm run build:mac` ;
- `npm run build:win` ;
- `npm run build:all` ;
- des chemins sous `addon/`.

Aucun de ces scripts npm n'existe dans `package.json`, et le dossier `addon/`
n'existe plus.

Reproductions confirmées :

```text
bash build.sh       -> code 1
npm run build       -> Missing script: "build"
npm run build:mac   -> Missing script: "build:mac"
```

### 5. Utilitaire de migration devenu obsolète

Sévérité : moyenne

Confiance : haute

`migrate.js:29-97` a été écrit pour déplacer les anciens fichiers depuis
`addon/`, des fichiers Electron à la racine et un ancien dossier `build/` vers
six nouveaux dossiers.

Les sources qu'il attend ont disparu. Le script conserve aussi, aux lignes
388–416, une logique de suppression des anciennes arborescences. Aucune partie
du dépôt ne l'appelle ; seules ses propres instructions le mentionnent.

Impact : il ne représente plus une migration applicable à l'état courant et
peut induire en erreur ou effectuer des opérations inutiles si quelqu'un le
relance sur un clone récent.

### 6. Serveur MCP local : prompts annoncés mais absents

Sévérité : moyenne

Confiance : haute

`mcp-server/mcp-server-local.js:425-438` tente de charger
`mcp-prompts.json` à la racine. Ce fichier n'est pas versionné et n'existe pas.
L'erreur est absorbée et `promptsData` devient une liste vide.

Un échange MCP `initialize`, puis `prompts/list`, a produit :

```json
{"prompts":[]}
```

Le stderr signale simultanément `ENOENT .../mcp-prompts.json`, puis le serveur
affiche encore `Prompts: Enabled` aux lignes 773–775.

Impact : la capacité est annoncée mais aucun prompt n'est disponible ; la panne
est silencieuse pour un client qui se fie uniquement aux capacités MCP.

Le même module déclare `OUTPUT_PATH` aux lignes 25–31 et annonce un ancien
repli `addon/output`, mais la variable n'est utilisée nulle part ailleurs dans
le fichier.

### 7. Chemins et instructions de récupération des certificats périmés

Sévérité : moyenne

Confiance : haute

`websocket-server/server.cjs:3269` cherche le certificat CA dans :

```text
../certificates/piecemaker-ca.crt
```

L'étape active `installer/steps/05-certificats.mjs:30-33,119` demande au
générateur d'écrire tous les certificats dans `websocket-server/`.
`websocket-server/generate-ca-certificates.cjs:28-31` confirme cet emplacement.
Le dossier `certificates/` n'existe plus.

Le serveur peut démarrer avec `localhost.crt` et `localhost.key`, mais sa branche
de détection du CA reste alors fausse et ses messages sur la chaîne complète ne
reflètent pas l'installation courante.

Les instructions de secours de `server.cjs:3280-3284,3297,3339` indiquent :

- un bouton « Approuver les certificats SSL » qui n'existe plus dans
  l'administration ;
- `node websocket-server/generate-ca-certificates.js`.

Le seul fichier versionné porte l'extension `.cjs`. La même commande erronée
est affichée par `websocket-server/verify-certificates.cjs:39`. Suivre cette
instruction produit `Cannot find module`.

### 8. Scripts de signature Electron conservés après la suppression du client

Sévérité : basse à moyenne

Confiance : haute

`create-certificate.sh:3-4,37-45,92` et
`create-certificate-windows.ps1:83-100` génèrent des certificats de signature
de code pour l'ancien packaging Electron, puis orientent vers les scripts npm
de build qui n'existent plus.

`installer/steps/05-certificats.mjs:5-15` les identifie explicitement comme
issus du flux Electron historique et utilise à la place
`websocket-server/generate-ca-certificates.cjs` pour HTTPS/Word. Aucun chemin
actif du dépôt n'appelle les deux scripts racine.

### 9. Dépendances directes d'un ancien pipeline Webpack/Babel

Sévérité : moyenne

Confiance : haute

`package.json:19-21,25-27,31-33,44,47-53,56` conserve notamment :

- `@babel/core`, `@babel/preset-env`, `@babel/preset-typescript` ;
- `babel-loader`, `copy-webpack-plugin`, `file-loader`, `html-loader` et
  `html-webpack-plugin` ;
- `webpack`, `webpack-cli`, `webpack-dev-server` ;
- `concurrently`, `os-browserify`, `process`, `source-map-loader`,
  `typescript` et `zod-to-json-schema`.

Il n'existe ni script de build, ni configuration Webpack/Babel/TypeScript, ni
import de ces paquets dans les sources actives. Ils sont malgré tout installés
à chaque installation racine.

Les dépendances réellement référencées, telles que `express`, `ws`, `zod`,
`@modelcontextprotocol/sdk`, `jszip`, `pdf-lib` et `vis-network`, ne sont pas
incluses dans ce constat.

### 10. README et instructions de dépôt devenus contradictoires

Sévérité : basse

Confiance : haute

`README.md:49-60` décrit des étapes `00a` et `00b`, puis s'arrête à l'étape 09.
Le dépôt possède en réalité `00-identite.mjs`, puis les étapes 01 à 14.

`README.md:147` affirme que `electron/` est conservé comme archive désactivée,
alors que ce dossier a été supprimé.

`README.md:149-153`, `CLAUDE.md:1-4` et `.gitignore:66-70` indiquent que le
`CLAUDE.md` racine est ignoré, propre au clone de développement et jamais
poussé. `git ls-files CLAUDE.md` confirme pourtant qu'il est versionné dans la
révision auditée.

### 11. Entrées `.gitignore` visant des archives supprimées

Sévérité : basse

Confiance : haute

`.gitignore:81-87` conserve des entrées spécifiques pour
`admin.backup-20260807-143950/*` et `docs/architecture.md`. Ces éléments ont été
supprimés du dépôt lors du nettoyage des archives et n'ont plus de producteur
actif identifié.

### 12. Ancien plan d'audit performance encore livré comme document courant

Sévérité : basse

Confiance : haute

`websocket-server/scripts/presidio-gliner/AUDIT_PERF_QUALITE.md:1-5` décrit un
plan dont plusieurs travaux sont déjà réalisés. Le document voisin
`eval/CRITERES_QUALITE.md:3-8` précise explicitement que cet audit est figé et
décrit comme « à faire » des éléments désormais implémentés.

Le conserver sans signalétique d'archive à côté des résultats actuels peut
faire prendre des décisions sur un état antérieur du moteur.

## Analyse Graphify

Graphify 0.9.39 a été exécuté sur une copie temporaire du dépôt. La copie
excluait `.git`, `node_modules`, `graphify-out` et `.piecemaker`. Aucun résultat
Graphify n'a été écrit dans le dépôt et aucun LLM ni service API n'a été appelé.

Commande d'extraction principale :

```bash
graphify extract "$COPIE_AUDIT" --code-only --no-cluster --out "$SORTIE_AUDIT"
```

Diagnostics complémentaires :

```bash
graphify god-nodes --graph "$GRAPHE" --json
graphify diagnose multigraph --graph "$GRAPHE" --json
graphify path websocket_server_server websocket_server_admin_routes --graph "$GRAPHE"
graphify path websocket_server_server websocket_server_originals_pipeline --graph "$GRAPHE"
graphify query "what connects server.cjs to originals-pipeline.cjs?" --graph "$GRAPHE" --budget 800
graphify cluster-only "$COPIE_CLUSTER" --graph "$GRAPHE_CLUSTER" --no-viz --no-label
```

### Couverture

- 214 fichiers de code indexés ;
- 32 documents et 4 images ignorés par `--code-only` ;
- 3 002 nœuds ;
- 7 502 arêtes brutes ;
- 6 480 arêtes après clustering ;
- 168 communautés ;
- aucun cycle d'import détecté.

Principaux hubs :

| Nœud | Connexions |
| --- | ---: |
| `admin/app.js:byId()` | 113 |
| `websocket-server/admin-routes.cjs:createAdminRouter()` | 76 |
| `admin/app.js:api()` | 56 |
| `installer/lib/platform.mjs:runCapture()` | 40 |

### Composants et arêtes non résolues

Le graphe brut contient 43 composantes faibles et cinq racines isolées :

- `create-certificate-windows.ps1` ;
- `piecemaker-plugin/mcp/legifrance/tools/__init__.py` ;
- `websocket-server/scripts/presidio-gliner/eval/bench_batchsize.py` ;
- `websocket-server/scripts/presidio-gliner/eval/check_gold.py` ;
- `websocket-server/scripts/presidio_analyzer/predefined_recognizers/generic/__init__.py`.

Ces isolements ne prouvent pas à eux seuls que les fichiers sont morts : il
s'agit aussi de scripts d'entrée autonomes, de benchmarks et de fichiers de
package Python vides.

Graphify a produit 691 arêtes à destination non résolue : 487 `imports_from`
et 204 `imports`. La majorité correspond aux modules standards ou externes,
par exemple `fs`, `path`, `os` et `typing`.

Les cibles locales apparentes `readCaseMapping`, `WORKSPACE_SUBDIR`,
`applyMapping` et `revertMapping` ont été vérifiées manuellement. Ce sont des
imports/re-exports valides dans `websocket-server/admin-routes.cjs:34-42` et
`piecemaker-plugin/scripts/lib/mapping.cjs:23-36,307-323`. Elles sont donc des
faux positifs de résolution Graphify.

### Limites propres à Graphify

Graphify a signalé une erreur de syntaxe dans
`piecemaker-plugin/scripts/lib/central-mapping.cjs:106`. `node --check` réussit
sur ce fichier. La ligne contient un NUL littéral dans une chaîne template,
valide pour Node mais non traité par l'analyseur Graphify : ce signal n'est pas
classé comme défaut du code.

`graphify query` a également indiqué que le graphe emploie l'ancien schéma
d'identifiants antérieur au correctif Graphify #1504. Les collisions entre noms
identiques élargissent certaines traversées. Les chemins courts restent
cohérents : `server.cjs` rejoint `admin-routes.cjs` en un saut, puis
`originals-pipeline.cjs` en deux sauts.

## Candidats non confirmés

Ces éléments n'ont pas été classés comme code mort sans décision produit :

1. `orchestrator/report-cycle.mjs` n'a pas de câblage actif trouvé dans
   l'installateur et conserve des références au projet externe « Lord of the
   bots ». Il peut s'agir d'une intégration manuelle.
2. `piecemaker-plugin/mcp/legifrance/mcp_http_local.py` n'a pas d'appelant dans
   le dépôt. L'installateur configure uniquement `mcp_stdio_server.py`, mais le
   transport HTTP peut être volontairement disponible pour lancement manuel.
3. Les JSON, rapports et fichiers `slice_*.md` sous
   `websocket-server/scripts/presidio-gliner/eval/` sont des sorties et corpus
   de benchmark sans appelant de production. Leur conservation peut être
   justifiée par la reproductibilité des mesures.

## Contrôles réussis

Les contrôles suivants n'ont trouvé aucun défaut :

- `node --check` sur tous les fichiers suivis `.js`, `.cjs` et `.mjs` ;
- analyse AST de tous les fichiers Python suivis ;
- `bash -n` sur tous les scripts shell suivis ;
- décodage de tous les fichiers JSON suivis ;
- validation du manifeste Office `taskpane/manifest.xml` ;
- vérification des liens Markdown relatifs ;
- `npm ls --depth=0` ;
- `git diff --check` ;
- analyse Graphify des cycles d'import.

Le démarrage du serveur sans certificats s'arrête avec le diagnostic prévu par
le code. Le clone de développement ne possède volontairement pas ces
certificats ; cet arrêt n'a pas été classé comme panne source.

## Limites de l'audit

- La suite `npm test` globale est longue. Une exécution a atteint 123 succès et
  les 3 échecs d'interface déjà reproduits séparément avant interruption ; son
  interruption ne constitue pas une preuve de blocage ou d'échec des tests
  restants.
- Les intégrations Word/Office.js nécessitent Word et le volet ouverts ; elles
  n'ont pas été considérées cassées uniquement parce que cet environnement
  interactif n'était pas disponible.
- Les modèles GLiNER/Presidio complets et leurs dépendances lourdes n'ont pas
  été rechargés pour un benchmark d'inférence complet.
- Les fichiers locaux déjà modifiés ont été audités dans leur état de travail,
  mais leur origine et leur intention ne peuvent pas être déduites avec
  certitude. Aucun de ces changements n'a été attribué à l'audit.

## Intégrité de la restitution

L'audit initial n'a appliqué aucun correctif et n'a créé aucun `graphify-out`
dans le dépôt. Un smoke test du serveur a exécuté ses mécanismes normaux et
idempotents de synchronisation des assets Claude et du hook central sous le
profil utilisateur ; il n'a modifié aucun fichier source du dépôt.

Le présent document est la seule modification créée pour la restitution sur la
branche `AUDIT-Project`.

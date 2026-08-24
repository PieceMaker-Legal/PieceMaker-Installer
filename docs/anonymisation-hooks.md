# Les hooks d'anonymisation

Ce document décrit la frontière de confidentialité de PieceMaker telle qu'elle
est réellement câblée aujourd'hui. L'anonymisation des entrées/sorties passe par
un hook central global installé dans `~/.claude`; le plugin garde ses propres
hooks, notamment la protection des pièces et le suivi des opérations, mais ne
déclare pas les scripts `anonymize-read.mjs` et `deanonymize-write.mjs` dans son
`hooks.json`. Il explique aussi comment prouver que la frontière fonctionne, et
ce qu'elle ne couvre pas.

Le tour d'horizon du dépôt est dans `CLAUDE.md` ; ici, seul le chemin des
données personnelles.

## Le principe

**Aucun fichier existant n'est réécrit sur le disque par le hook.** Le cabinet
garde son Markdown lisible. Seul le *résultat* d'outil remis au modèle est codé,
et l'*entrée* d'un Write/Edit visant un dossier juridique enregistré est
rétablie avant exécution. Une écriture de travail hors dossier (scratchpad,
fichier temporaire) conserve les codes. Le nom réel ne transite donc jamais par
l'API, et le document produit dans le dossier pour un humain le porte malgré
tout.

```
dossier (noms réels) ──Read/Grep/Glob/Bash──► hook central ──► modèle (codes)
dossier (noms réels) ◄──Write/Edit─────────── hook central ◄── modèle (codes)
scratchpad (codes)   ◄──Write/Edit─────────── hook central ◄── modèle (codes)
```

Les hooks **ne scannent rien** : ni GLiNER, ni Presidio, ni heuristique. Ils
appliquent un mapping déjà construit. Le scan reste dans le pipeline de
l'administration (`POST /api/admin/originals/pipeline`), seul endroit où les
modèles NER sont chargés — les charger à chaque lecture rendrait la session
inutilisable.

## Le hook central global

Au démarrage du serveur, `websocket-server/central-hook-install.cjs` copie
`websocket-server/global-hooks/piecemaker-central-anonymize.mjs` dans
`~/.claude/hooks/` et l'ajoute, de façon idempotente, à `~/.claude/settings.json`.
Il s'applique à toute session Claude Code, quel que soit le dossier courant — il
n'est pas limité aux dossiers juridiques enregistrés par le plugin.

| Événement | Filtre | Script | Rôle |
| --- | --- | --- | --- |
| `PostToolUse` | `Read\|Grep\|Glob\|Write\|Edit\|Bash` et outils MCP Word | `piecemaker-central-anonymize.mjs` | `updatedToolOutput` : mapping central (entité → code), y compris les confirmations et chemins renvoyés |
| `PreToolUse` | `Read\|Grep\|Glob\|Write\|Edit\|Bash`, Telegram et `open_doc` | `piecemaker-central-anonymize.mjs` | `updatedInput` : chemins codés résolus ; contenus Write/Edit ré-identifiés seulement dans un dossier enregistré |

Le mapping lu est `~/.piecemaker/central-mapping.json`. Il est reconstruit par
`central-mapping.cjs` en fusionnant les mappings des dossiers et en
dé-conflictant les codes. Le hook central ignore les fichiers de mapping/scan,
et ne réécrit jamais lui-même le disque : il transforme uniquement la réponse
remise au modèle ou l'entrée d'outil avant exécution. Pour Write/Edit, il résout
le chemin réel (liens symboliques compris) et ne ré-identifie le contenu que si
la destination appartient à `caseFolders`. En l'absence de configuration, de
mapping, de moteur ou en cas d'erreur, il échoue ouvert (sortie vide, code 0).

La résolution des chemins codés n'est pas un simple remplacement code → nom :
plusieurs variantes d'une entité peuvent partager le même code, et le premier
nom du reverse mapping n'est pas forcément celui du fichier sur disque. Pour
`Read`, `Grep`, `Glob` et `open_doc`, le hook conserve donc d'abord le chemin
littéral s'il existe, essaie ensuite la variante canonique, puis parcourt le
répertoire et accepte seulement l'unique nom dont l'anonymisation reproduit le
segment demandé. S'il n'existe aucune correspondance unique, il garde le chemin
codé : l'outil échoue sans divulguer de nom et sans risquer d'ouvrir le mauvais
fichier. La route Word applique la même règle en défense en profondeur pour les
appels MCP qui contourneraient le hook Claude Code.

Les scripts `piecemaker-plugin/scripts/anonymize-read.mjs` et
`deanonymize-write.mjs` restent présents comme implémentations autonomes et
sont couverts par l'auto-test de l'étape `06-hooks`; ils ne sont pas des
entrées du câblage `piecemaker-plugin/hooks/hooks.json`.

## Les hooks du plugin

Le fichier `piecemaker-plugin/hooks/hooks.json` déclare les rôles suivants :

| Événement | Filtre | Script | Rôle |
| --- | --- | --- | --- |
| `PreToolUse` | `Read\|Grep\|Glob\|Bash` | `protect-originals.mjs` | Refuse une pièce protégée ou un fichier de mapping |
| `PostToolUse` | `Read` | `track-legifrance-reads.mjs` | Suit les lectures de résultats Légifrance |
| `PostToolUse` | `Write\|Edit` | `commit-track.mjs` | Suit/commit les modifications du dossier |
| `PostToolUse` | `Write` | `compile-recherche.mjs` | Compile le rapport de recherche après écriture |
| `Stop` | `*` | `billing-track.mjs` | Enregistre l'événement de facturation |
| `TaskCompleted` | `*` | `billing-track.mjs` | Enregistre l'événement de facturation |

Ces hooks sont ceux du plugin et leur portée dépend du chargement du plugin par
Claude Code. La protection des pièces complète le hook central : elle refuse,
par défaut, les fichiers non `.md`/`.json` d'un dossier juridique enregistré,
afin qu'un contenu qui n'a pas de mapping ne puisse pas atteindre le modèle.

À part ces deux couches, l'étape `13-garde-secrets` installe le hook global
`~/.claude/hooks/piecemaker-guard-secrets.mjs` et le câble en `PreToolUse` dans
`~/.claude/settings.json`. Il bloque les chemins de la liste noire (notamment
les `.env`) pour `Read`/`Grep`/`Glob`/`Edit`/`Write`/`NotebookEdit` et les
contournements `Bash`. Ce garde-fou n'est pas un hook du plugin et ne réalise
aucune anonymisation.

Quelques points qui ne se devinent pas à la lecture des noms :

- **`Edit` rétablit les deux chaînes.** Le modèle a lu le fichier à travers le
  mapping : son `old_string` porte des codes, le disque porte les noms. Ne
  reverter que `new_string` ferait échouer chaque édition sur « chaîne
  introuvable ». Cette ré-identification ne s'applique que si `file_path` est
  dans un dossier juridique enregistré ; ailleurs, `old_string` et `new_string`
  restent codés.
- **Les confirmations d'écriture sont recodées.** Après un PreToolUse,
  Write/Edit et `open_doc` peuvent renvoyer au modèle l'entrée réelle qu'ils ont
  exécutée. Le PostToolUse couvre donc aussi leurs résultats, y compris le nom
  réel d'un document Word renvoyé dans une structure MCP.
- **`Bash` est couvert par les deux couches actives.** Le hook central anonymise
  `stdout`/`stderr` pour `Bash` avec le mapping central, quel que soit le chemin
  du dossier. En parallèle, `protect-originals.mjs` inspecte les chemins cités
  par la commande et refuse les pièces protégées dans les dossiers juridiques
  enregistrés ; cela ferme notamment la brèche du skill `docx` (`pandoc`,
  `unzip`, `python ooxml/scripts/unpack.py`).
- **Telegram est réécrit par le hook central.** Ses filtres `PreToolUse` ciblent
  les outils MCP dont le nom correspond à `reply` ou `edit_message`; ce n'est
  pas un hook `Stop` et ce n'est pas le canal du harnais.
- **Les dossiers ont des mappings locaux, pas un hook par dossier.** Chaque
  mapping de dossier est une entrée du rebuild central :
  `central-mapping.cjs` les fusionne et dé-conflicte les codes pour produire
  `~/.piecemaker/central-mapping.json`. Le hook central n'attribue pas de code
  local à la volée. Il utilise toutefois le `file_path` de Write/Edit pour
  distinguer un document humain du dossier (noms réels) d'un scratchpad hors
  dossier (codes).

## La protection des pièces

`piecemaker-plugin/scripts/lib/protection.cjs` détient la règle : sous un
dossier juridique, **tout ce qui n'est ni `.md` ni `.json` est protégé par
défaut**. `<dossier>/.piecemaker/protection.json` n'enregistre que les
*exceptions* (`{ version: 1, unprotected: [...] }`), si bien qu'une pièce
déposée entre deux visites de `/admin/` est protégée sans aucune action.

La protection est une propriété **du fichier**, pas de son emplacement : un
cabinet qui range ses pièces à plat, à côté du Markdown qui en est issu — le
cas courant — est couvert comme un autre.

## Le mapping n'est jamais lisible par l'IA

`mapping_default.json` fait correspondre chaque code au nom réel : le lire, c'est
dé-anonymiser le dossier entier d'un seul appel d'outil. Le pipeline courant ne
conserve plus les `*_sensitive_map.json` : il les fusionne depuis un répertoire
temporaire puis les supprime. Les anciens dossiers peuvent toutefois encore en
porter pendant leur migration, avec les entités en clair et leur contexte.
`protect-originals.mjs` refuse les deux — sur `Read`, sur `Grep`, sur
`Glob` et sur `Bash` (`cat`, `jq`, `python`) — et **aucune exception de
`protection.json` ne les libère**.

Laisser `anonymize-read.mjs` les coder à la volée ne suffisait pas : les entités
trop courtes, celles rangées sous `ignored` et les variantes d'`extracted_data`
ressortent telles quelles. Le seul traitement correct est le refus, et ce
refus-là ne renvoie vers rien — il n'existe pas de version anonymisée de ces
fichiers. L'administration y accède par ses propres routes
(`GET/PUT /api/admin/mapping`), qui ne passent pas par les hooks.

La règle est portée par `isMappingFile` (`lib/protection.cjs`) et non par
`isProtectedFile` : l'historique du cabinet doit continuer à versionner le
mapping (`commit-track.mjs`), qui n'est protégé que vis-à-vis du modèle.

Un `Grep` récursif à la racine d'un dossier est refusé pour la même raison — il
ramènerait le contenu du mapping. Un `Glob` ne ramène que des noms de fichiers
et reste permis.

## Le contrat d'exécution

Le contrat Claude Code est partagé par les scripts autonomes du plugin via
`piecemaker-plugin/scripts/lib/hook-io.mjs`. Le hook central
`websocket-server/global-hooks/piecemaker-central-anonymize.mjs` implémente le
même contrat indépendamment, avec son moteur copié dans
`~/.piecemaker/lib/substitution.cjs`; il ne dépend donc ni de `hook-io.mjs`, ni
du chemin d'un dossier juridique. Référence :
<https://code.claude.com/docs/en/hooks>.

- Une charge utile JSON par invocation, sur stdin.
- Sortie 0 + JSON sur stdout → le JSON est appliqué. Sortie 2 → blocage, stderr
  affiché comme motif. Tout autre code → erreur non bloquante.
- Ne jamais mélanger les deux signalisations.

**Les deux familles échouent ouvert**, mais avec des conditions différentes :
les scripts du plugin sortent 0 sans stdout en cas d'erreur, de timeout, de
configuration absente ou de situation hors dossier; le hook central fait de
même en cas d'erreur, de configuration/mapping absent ou de moteur indisponible,
et il continue à anonymiser les résultats de lecture avec son mapping central
même quand `cwd` et le chemin visé ne correspondent à aucun dossier juridique.
Dans cette situation, il laisse en revanche les productions Write/Edit codées.
Le script autonome
`anonymize-read.mjs` reste également muet quand sa substitution ne change rien,
pour que `Read` conserve sa numérotation de lignes native.

**stdout est vidé avant de sortir.** Claude Code branche la sortie du hook sur
un tube : un `process.exit()` immédiat coupait le JSON au tampon de 64 Ko. Le
harnais ne pouvait plus le relire et reprenait la sortie d'outil d'origine — un
document au-delà de 64 Ko partait donc **en clair**. `emit()` attend désormais
le vidage, avec un garde-fou de 2 s pour qu'un stdout qui ne se vide jamais ne
bloque pas la session non plus.

## Pas de plafond

**Tout texte est substitué, quelle qu'en soit la taille.** Il a existé un seuil
de 2 Mo au-delà duquel `applyMapping` rendait le texte tel quel : il laissait
passer en clair exactement les documents les plus volumineux. Il est supprimé.

La boucle reste ce qu'elle doit être : les entrées triées de la plus longue
entité à la plus courte, une regex par entité, un `replace`. Rien d'autre. Sur
un mapping réel de 13 entités, 4 Mo de texte prennent 23 ms — il n'y a pas de
problème de coût à résoudre, et un pré-filtre serait une surface de plus où une
entité pourrait être silencieusement sautée.

Le délai de `runHook` ne coupe pas court à cette substitution : elle est
synchrone, la promesse du corps se règle en micro-tâche, devant la macro-tâche
du minuteur. Vérifié avec un corps synchrone de 8 s sous un délai de 5 s — la
sortie part entière. Le délai garde son rôle d'origine : le travail asynchrone
qui se bloque.

## Vérifier que ça marche

### 1. Les tests

```bash
node --test test/central-hook.test.mjs test/central-hook-install.test.cjs \
  test/central-mapping.test.cjs test/hooks-anonymize.test.mjs \
  test/mapping.test.cjs test/protection.test.cjs
npm test          # la suite complète
```

`test/mapping.test.cjs` couvre le moteur de substitution : imbrication des
entités, idempotence, variantes typographiques, aller-retour exact, absence de
plafond, orthographes piégeuses et résolution sûre des noms de fichiers codés.

`test/hooks-anonymize.test.mjs` lance les scripts **comme Claude Code le fait**
— charge utile JSON sur stdin, `HOME` redirigé vers un faux
`~/.piecemaker` — et couvre le refus d'une pièce protégée, l'exception, le
codage d'un `Read` et d'un `Bash`, les deux chaînes d'un `Edit`, le message
Telegram, l'effacement complet sans configuration, et les charges utiles
au-delà du tampon du tube.

`test/central-hook.test.mjs`, `test/central-hook-install.test.cjs` et
`test/central-mapping.test.cjs` couvrent respectivement l'anonymisation globale
(y compris hors dossier), la conservation des codes dans un scratchpad, la
ré-identification d'un Write du dossier, la résolution d'un chemin codé, le
recodage des confirmations Write/open_doc, le câblage idempotent et sa migration
dans `settings.json`, ainsi que la fusion/dé-confliction des mappings locaux.

### 2. L'auto-test de l'installateur

L'étape `06-hooks` crée un dossier juridique factice, envoie une charge utile
synthétique à chaque script et vérifie que la sortie est un JSON valide avec un
code 0 :

```bash
piecemaker            # menu interactif → étape « Hooks Claude Code »
```

### 3. Sur un vrai dossier

Les tests tournent sur des fixtures. Pour prouver la chaîne sur un dossier
réel, envoyer une charge utile à un script et n'observer que des booléens —
jamais le contenu :

```bash
CASE="$HOME/Documents/07 - PieceMaker/PieceMaker Test Files/Dossier AVION"
PIECE=$(find "$CASE" -maxdepth 1 -name '*.pdf' | head -1)

python3 -c "
import json, sys
print(json.dumps({'hook_event_name': 'PreToolUse', 'cwd': sys.argv[1],
                  'tool_name': 'Read', 'tool_input': {'file_path': sys.argv[2]}}))
" "$CASE" "$PIECE" \
  | node piecemaker-plugin/scripts/protect-originals.mjs \
  | python3 -c "import json, sys; print(json.load(sys.stdin)['hookSpecificOutput']['permissionDecision'])"
# → deny
```

Le mapping d'un dossier réel contient de vraies données personnelles : ne
jamais afficher son contenu, ni le résultat complet d'un hook.

## Après avoir modifié un hook

Il faut distinguer deux modes d'enregistrement, tous deux sans manifest
PieceMaker. Le hook central est copié depuis `websocket-server/global-hooks/`
dans `~/.claude/hooks/` au démarrage du serveur. Les autres hooks sont appelés
directement depuis `piecemaker-plugin/scripts/` par les entrées fusionnées dans
`~/.claude/settings.json` par `claude-hooks.cjs`.

Une modification d'un script du dépôt est donc utilisée directement, sans
publication ni cache intermédiaire. Après l'ajout ou le retrait d'un événement
dans `hooks/hooks.json`, relancer l'étape 06, `piecemaker update` ou le serveur
pour réconcilier `settings.json`, puis ouvrir une nouvelle session Claude Code.
Dans un clone de développement modifié sur place, redémarrer le serveur recopie
la source du hook central.

Pour une installation cliente, `piecemaker update` réconcilie désormais le
hook central directement après la mise à jour du clone, même si le serveur était
arrêté. S'il tournait, il est en plus redémarré avec le nouveau code serveur.
Il faut ensuite rouvrir les sessions Claude Code/Codex actives afin qu'elles
rechargent leurs hooks et leur processus MCP. Aucun `claude plugin update` ni
bump de version du plugin PieceMaker n'est requis pour ce chemin central.

## Où vit quoi

| Fichier | Contenu |
| --- | --- |
| `piecemaker-plugin/hooks/hooks.json` | Source du câblage événement → script |
| `websocket-server/claude-hooks.cjs` | Fusion directe des hooks dans `~/.claude/settings.json` |
| `websocket-server/global-hooks/piecemaker-central-anonymize.mjs` | Hook global d'anonymisation |
| `websocket-server/central-hook-install.cjs` | Copie et câblage du hook global, synchronisation du central |
| `piecemaker-plugin/scripts/*.mjs` | Hooks du plugin et scripts autonomes d'auto-test |
| `piecemaker-plugin/scripts/lib/hook-io.mjs` | stdin/stdout, configuration, échec ouvert |
| `piecemaker-plugin/scripts/lib/mapping.cjs` | Moteur unique de substitution |
| `piecemaker-plugin/scripts/lib/protection.cjs` | Règle de protection, résolution du dossier |
| `websocket-server/originals-pipeline.cjs` | Construction du mapping (côté administration) |
| `installer/assets/claude-hooks/piecemaker-guard-secrets.mjs` | Garde global des fichiers secrets, distinct du plugin et du hook d'anonymisation |

Le hook global copie son moteur de substitution vers `~/.piecemaker/lib/`.
Les autres scripts sont exécutés depuis le dépôt et requièrent leurs modules
dans `piecemaker-plugin/scripts/lib/`. Une logique serveur dont un hook a besoin
entre dans ce répertoire partagé et est ré-exportée par le module serveur,
jamais l'inverse.

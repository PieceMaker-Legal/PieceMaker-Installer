# Les hooks d'anonymisation

Ce document décrit la frontière de confidentialité de PieceMaker telle qu'elle
tourne réellement : quatre hooks Claude Code qui codent ce que le modèle lit et
rétablissent les vrais noms sur ce qu'il produit. Il explique aussi comment
prouver qu'elle fonctionne, et ce qu'elle ne couvre pas.

Le tour d'horizon du dépôt est dans `CLAUDE.md` ; ici, seul le chemin des
données personnelles.

## Le principe

**Aucun fichier n'est réécrit sur le disque.** Le cabinet garde son Markdown
lisible. Seul le *résultat* d'outil remis au modèle est codé, et seule
l'*entrée* d'outil sur le point de s'exécuter est rétablie. Le nom réel ne
transite donc jamais par l'API, et le document produit pour un humain le porte
malgré tout.

```
disque (noms réels)  ──Read/Grep/Glob/Bash──►  anonymize-read   ──►  modèle (codes)
disque (noms réels)  ◄──Write/Edit/Telegram──  deanonymize-write ◄──  modèle (codes)
```

Les hooks **ne scannent rien** : ni GLiNER, ni Presidio, ni heuristique. Ils
appliquent un mapping déjà construit. Le scan reste dans le pipeline de
l'administration (`POST /api/admin/originals/pipeline`), seul endroit où les
modèles NER sont chargés — les charger à chaque lecture rendrait la session
inutilisable.

## Les quatre hooks

Câblés dans `piecemaker-plugin/hooks/hooks.json` :

| Événement | Filtre | Script | Rôle |
| --- | --- | --- | --- |
| `PreToolUse` | `Read\|Grep\|Glob\|Bash` | `protect-originals.mjs` | Refuse une pièce protégée et renvoie vers son `.md` |
| `PostToolUse` | `Read\|Grep\|Glob\|Bash` | `anonymize-read.mjs` | `updatedToolOutput` : mapping appliqué |
| `PreToolUse` | `Write\|Edit\|mcp__telegram__reply\|mcp__telegram__edit_message` | `deanonymize-write.mjs` | `updatedInput` : mapping inversé |
| `PostToolUse` | `Write\|Edit` | `commit-track.mjs` | Commit du dossier, libellé rétabli |

Quelques points qui ne se devinent pas à la lecture des noms :

- **`Edit` rétablit les deux chaînes.** Le modèle a lu le fichier à travers le
  mapping : son `old_string` porte des codes, le disque porte les noms. Ne
  reverter que `new_string` ferait échouer chaque édition sur « chaîne
  introuvable ».
- **`Bash` est gardé des deux côtés.** C'est ce qui ferme la brèche ouverte par
  le skill `docx`, qui travaille par `pandoc`, `unzip` et
  `python ooxml/scripts/unpack.py`.
- **Telegram passe par l'outil MCP `reply` du plugin officiel**, pas par le
  canal du harnais : un hook `Stop` n'aurait pas pu réécrire ces messages.
- **Un dossier = un mapping.** Le dossier est déduit du chemin visé, ou à
  défaut du répertoire de travail. Deux dossiers ont des compteurs de codes
  indépendants ; mélanger leurs mappings attribuerait un même code à deux
  personnes différentes.

## La protection des pièces

`piecemaker-plugin/scripts/lib/protection.cjs` détient la règle : sous un
dossier juridique, **tout ce qui n'est ni `.md` ni `.json` est protégé par
défaut**. `<dossier>/.piecemaker/protection.json` n'enregistre que les
*exceptions* (`{ version: 1, unprotected: [...] }`), si bien qu'une pièce
déposée entre deux visites de `/admin/` est protégée sans aucune action.

La protection est une propriété **du fichier**, pas de son emplacement : un
cabinet qui range ses pièces à plat, à côté du Markdown qui en est issu — le
cas courant — est couvert comme un autre.

## Le contrat d'exécution

Confirmé contre <https://code.claude.com/docs/en/hooks>, et implémenté dans
`piecemaker-plugin/scripts/lib/hook-io.mjs` :

- Une charge utile JSON par invocation, sur stdin.
- Sortie 0 + JSON sur stdout → le JSON est appliqué. Sortie 2 → blocage, stderr
  affiché comme motif. Tout autre code → erreur non bloquante.
- Ne jamais mélanger les deux signalisations.

**Chaque hook échoue ouvert** : pas de configuration, pas de mapping, ou un
chemin hors dossier se terminent tous par un exit 0 sans stdout, et la session
n'en sait rien. `anonymize-read.mjs` reste également muet quand la substitution
ne change rien, pour que `Read` conserve sa numérotation de lignes native.

**stdout est vidé avant de sortir.** Claude Code branche la sortie du hook sur
un tube : un `process.exit()` immédiat coupait le JSON au tampon de 64 Ko. Le
harnais ne pouvait plus le relire et reprenait la sortie d'outil d'origine — un
document au-delà de 64 Ko partait donc **en clair**. `emit()` attend désormais
le vidage, avec un garde-fou de 2 s pour qu'un stdout qui ne se vide jamais ne
bloque pas la session non plus.

## Pas de plafond

**Tout texte est substitué, quelle qu'en soit la taille.** Il n'y a pas de seuil
au-delà duquel `applyMapping` rende la main : un tel seuil laissait passer en
clair exactement les documents les plus volumineux.

Deux propriétés rendent cela tenable :

- **Un index de mots, pas un balayage par entité.** Le coût brut est le produit
  du nombre d'entités par la taille du texte. `wordIndex` parcourt le texte une
  seule fois et met ses mots dans un `Set` ; chaque entité est ensuite écartée
  ou retenue en temps constant sur son premier mot. Mesuré : 500 entités sur
  50 Mo passent de plusieurs secondes à ~830 ms quand aucune n'est présente.
- **Le pré-filtre ne peut pas écarter une entité présente.** La sonde est la
  suite maximale de caractères de mot en tête de l'entité — exactement ce que
  `buildEntityRegex` exige en début de correspondance, précédé d'une frontière
  de mot. Une entité présente a donc toujours sa sonde dans l'index. Vérifié en
  plus par différentiel : 4 000 textes aléatoires (casse mélangée, retours à la
  ligne au milieu des entités, variantes Unicode du trait d'union et de
  l'apostrophe, ponctuation en tête) donnent le même résultat qu'une boucle sans
  aucun pré-filtre.

Reste le cas où beaucoup d'entités sont réellement présentes dans un très gros
texte : la substitution est alors séquentielle par construction (500 entités
toutes présentes sur 20 Mo ≈ 7 s). Ce temps est **payé, jamais abandonné** —
`runHook` n'y coupe pas court. Son délai ne préempte pas le travail synchrone :
la promesse du corps se règle en micro-tâche, devant la macro-tâche du
minuteur. Vérifié avec un corps synchrone de 8 s sous un délai de 5 s — la
sortie part entière. Le délai garde son rôle d'origine : le travail asynchrone
qui se bloque.

## Vérifier que ça marche

### 1. Les tests

```bash
node --test test/hooks-anonymize.test.mjs test/mapping.test.cjs test/protection.test.cjs
npm test          # la suite complète
```

`test/mapping.test.cjs` couvre le moteur de substitution : imbrication des
entités, idempotence, variantes typographiques, aller-retour exact, absence de
plafond et innocuité du pré-filtre.

`test/hooks-anonymize.test.mjs` lance les scripts **comme Claude Code le fait**
— charge utile JSON sur stdin, `HOME` redirigé vers un faux
`~/.piecemaker` — et couvre le refus d'une pièce protégée, l'exception, le
codage d'un `Read` et d'un `Bash`, les deux chaînes d'un `Edit`, le message
Telegram, l'effacement complet sans configuration, et les charges utiles
au-delà du tampon du tube.

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

Les hooks tournent depuis la **copie installée du plugin**, pas depuis le dépôt
de travail :

```
~/.claude/plugins/cache/piecemaker/piecemaker/<version>/
```

C'est une copie figée du marketplace GitHub
(`PieceMaker-Legal/PieceMaker-Installer`). Une modification dans
`piecemaker-plugin/` ne change donc rien à une session tant qu'elle n'est pas
commitée, poussée, puis récupérée :

```bash
git push
claude plugin marketplace update piecemaker
claude plugin update piecemaker
```

Vérifier ensuite que la copie installée porte bien les quatre scripts :

```bash
ls ~/.claude/plugins/cache/piecemaker/piecemaker/*/scripts/
# protect-originals.mjs  anonymize-read.mjs  deanonymize-write.mjs
# commit-track.mjs  billing-track.mjs  lib/{hook-io.mjs,mapping.cjs,protection.cjs,commits.cjs}
```

Une copie qui contient encore `pre-anonymize.mjs` ou `post-anonymize.mjs` est
antérieure au remplacement des hooks de scan : la frontière décrite ici n'y est
pas en place.

Les **skills et agents** échappent à cette contrainte : `claude-assets.cjs` les
lie par lien symbolique dans `~/.claude/`, une édition depuis `/admin/` y est
donc active immédiatement. Les hooks, eux, n'ont pas d'équivalent.

## Où vit quoi

| Fichier | Contenu |
| --- | --- |
| `piecemaker-plugin/hooks/hooks.json` | Câblage événement → script |
| `piecemaker-plugin/scripts/*.mjs` | Les cinq hooks |
| `piecemaker-plugin/scripts/lib/hook-io.mjs` | stdin/stdout, configuration, échec ouvert |
| `piecemaker-plugin/scripts/lib/mapping.cjs` | Moteur unique de substitution |
| `piecemaker-plugin/scripts/lib/protection.cjs` | Règle de protection, résolution du dossier |
| `websocket-server/originals-pipeline.cjs` | Construction du mapping (côté administration) |

Un script de hook ne peut requérir que depuis `piecemaker-plugin/scripts/lib/`
— le plugin est distribué seul. Une logique serveur dont un hook a besoin
*entre* dans le plugin et est ré-exportée par le module serveur, jamais
l'inverse.

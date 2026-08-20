# Anonymisation en lecture — 3 défauts observés (noms de fichiers & volume)

**Date :** 2026-08-20
**Dossier de test :** `Documents/07 - PieceMaker/REAL TEST` (dossier juridique PieceMaker, 30 pièces converties)
**Mapping actif :** `URGOT → URGOT SA`, `CAITLYN → CAITLYN SA`, plus les personnes physiques (`Laurent Dumas`, `Claire Reynaud`). Ici `URGOT` / `CAITLYN` sont les **vraies** entités « côté cabinet » (fixtures fictives) ; `URGOT SA` / `CAITLYN SA` sont les **codes** que le modèle doit seul voir.
**Contexte de découverte :** session Claude Code (Opus), tâche « résumer le dossier » déléguée à un sous-agent Haiku, puis écriture d'un `.docx` de résumé.
**Hooks concernés :** `anonymize-read.mjs` (PostToolUse), `deanonymize-write.mjs` (PreToolUse), `lib/hook-io.mjs`, `lib/substitution.cjs`.

---

## Verdict

| # | Défaut | Gravité | Fuite vers l'API ? |
| --- | --- | --- | --- |
| **A** | `Read`/`Bash` d'une pièce dont **le nom de fichier contient une entité** échoue (« file does not exist ») | Fonctionnel (résumé incomplet) | Non |
| **B** | L'**aperçu** d'un `Write`/`Edit` affiche les **vrais noms** rétablis par le hook | Affichage local | **Non** (contexte modèle propre) |
| **C** | Une **lecture en masse** (beaucoup de pièces d'un coup) laisse **des vrais noms parvenir au modèle** ; la même lecture unitaire est propre | 🔴 **RGPD-critique** | **Oui** |

Les trois se combinent : le contournement naturel de **A** (globber plusieurs pièces d'un coup) déclenche **C**.

---

## Défaut A — Les noms de fichiers portent les entités, mais les chemins **en entrée** ne sont pas dé-anonymisés

### Situation d'observation
Un sous-agent Haiku, chargé de résumer le dossier, lisait les pièces converties une à une via `Read`. Les pièces dont le nom contient une société ont échoué :
```
Read(".../Fichiers convertis PieceMaker/06_Email_..._par_CAITLYN SA_SA.md")  → File does not exist
Read(".../08_Email_interne_..._par_URGOT SA.md")                            → File does not exist
```

### Symptôme
Le sous-agent a lu certaines pièces et pas d'autres. Échecs typiques :

```
Read(".../Fichiers convertis PieceMaker/06_Email_..._par_CAITLYN SA_SA.md")
→ Error: File does not exist.
Read(".../08_Email_interne_..._par_URGOT SA.md")
→ Error: File does not exist.
```

### Mécanisme
La chaîne d'anonymisation est **asymétrique** :

| Sens | Hook | Événement | Ce qu'il réécrit |
| --- | --- | --- | --- |
| Lecture | `anonymize-read.mjs` | PostToolUse (Read/Grep/Glob/Bash) | le **résultat** renvoyé au modèle, contenu **et** noms de fichiers listés |
| Écriture | `deanonymize-write.mjs` | PreToolUse (Write/Edit + reply Telegram) | les **entrées** d'outil |

Aucun hook ne dé-anonymise le **chemin passé en entrée** d'un `Read`/`Grep`/`Glob`/`Bash`. Déroulé qui casse :

1. `Glob` / `ls` → le hook renvoie au modèle un nom **codé** : `06_..._par_CAITLYN SA_SA.md`.
2. Le modèle fait `Read` sur ce chemin codé.
3. Sur le disque, le fichier s'appelle `06_..._par_CAITLYN_SA.md` (vrai nom) → **fichier introuvable**.

Les pièces sans entité dans leur nom (05, 07, 09, 13, 14…) passent ; celles dont le nom contient une société (01, 02, 03, 06, 08, 10, 12, 21, 26, 29…) échouent. **D'où un résumé bâti sur un sous-ensemble des pièces.**

### Preuve
```bash
cd ".../Fichiers convertis PieceMaker"
ls -la "05_Email_Premier_signalement_de_retard_dans_le_projet.md"   # → OK (pas d'entité)
ls -la "06_Email_..._par_CAITLYN SA_SA.md"                        # → No such file or directory
```
Le premier existe ; le second (chemin codé) est introuvable alors qu'il apparaît, codé, dans le listing.

### Contournement observé (à ne PAS recommander tel quel — voir C)
Remplacer le segment-entité par `*` : le shell résout le glob contre les **vrais** noms sur disque, et le hook code la sortie.
```bash
cat 06_Email_Explication_initiale_du_retard_par_*.md
```
⚠️ En lot, ce contournement déclenche le défaut **C**.

### Correctif proposé
Deux options, non exclusives :
1. **À la conversion** : produire des noms de fichiers **neutres** (sans entité — p. ex. `06_Email_explication-retard.md`), l'entité ne vivant que dans le contenu. C'est le plus simple et le plus robuste.
2. **Symétriser les hooks** : dé-anonymiser aussi les **chemins en entrée** de Read/Grep/Glob/Bash (mapping inverse code→entité sur `file_path` / `path` / tokens de `command`), pour qu'un chemin codé résolve vers le vrai fichier.

---

## Défaut B — L'aperçu d'un `Write`/`Edit` affiche les vrais noms à l'écran

### Situation d'observation
Écriture du résumé dans le dossier, contenu rédigé par le modèle avec des **codes** :
```
Write("/Users/.../REAL TEST/Résumé du dossier.md", content="… URGOT SA … CAITLYN SA …")
```

### Symptôme
En écrivant le `.md` de résumé (rédigé avec des **codes**), le journal de session a affiché :
```
Wrote 11 lines to .../Résumé du dossier.md
```
…avec, dans l'aperçu, les **vrais** noms de sociétés.

### Mécanisme
`deanonymize-write.mjs` (PreToolUse) réécrit l'**entrée** de l'outil `Write` (le champ `content`) pour rétablir les vrais noms **avant** l'écriture disque — c'est voulu (le fichier disque doit porter les vrais noms, « le cabinet ne voit que des noms »). Mais la CLI construit l'aperçu « Wrote N lines » à partir de cette entrée **déjà dé-anonymisée** → les vrais noms s'affichent.

### Ce qu'il faut distinguer
- ✅ **Aucune fuite API / contexte modèle.** Le résultat reçu par le modèle était uniquement « *File created successfully at … (file state is current)* », **sans aucun nom**. L'invariant « le modèle ne voit que des codes » a tenu.
- ⚠️ **Fuite d'affichage local.** L'écran (et le journal de session) a montré les vrais noms, alors que l'invariant attendu est que la session **miroir de ce que voit le modèle** (des codes), la dé-anonymisation restant invisible, cantonnée au passage disque.

### Portée
Pas de fuite réseau. Mais le journal/terminal local peut être capturé, partagé ou archivé ; l'affichage devrait rester codé.

### Correctif proposé
Faire en sorte que la version **ré-affichée** par le client reste la version **codée** (celle rédigée par le modèle), la dé-anonymisation n'agissant que sur les octets écrits sur disque. À défaut, supprimer l'aperçu de contenu des `Write`/`Edit` dans les dossiers PieceMaker.

### Résolution (2026-08-20) — correctif **côté client**, hors de portée des hooks
Vérification faite dans tout le dépôt (`piecemaker-plugin`, `websocket-server`, `taskpane`, `installer`, `orchestrator`, `mcp-server`) : les **seules** surfaces qui produisent `updatedInput` sont les deux hooks d'anonymisation (`deanonymize-write.mjs` et le hook central). **Aucun** code du dépôt n'intercepte ni ne re-rend l'aperçu « Wrote N lines » — c'est le harnais Claude Code lui-même qui le construit à partir de `updatedInput`.

Le défaut n'est donc **pas corrigeable dans les hooks**, pour trois raisons structurelles :
1. Le contrat `PreToolUse` n'a qu'**un seul canal** : `updatedInput` est à la fois **exécuté** (octets écrits sur disque) **et affiché** (aperçu). Il n'existe pas de « exécuter X, afficher Y ».
2. Déplacer la dé-anonymisation **après** l'écriture (pour garder l'aperçu codé) **casse `Edit`** : son `old_string` codé doit être rétabli **avant** l'exécution pour matcher le disque en clair, sinon « chaîne introuvable ».
3. Garder le disque codé pour préserver l'aperçu **violerait** l'invariant « le disque porte les vrais noms, le cabinet ne voit que des noms ».

**Ce qui a été posé côté dépôt :** une réserve d'affichage explicite en commentaire dans `deanonymize-write.mjs`, à l'endroit où `updatedInput` est renvoyé, pour que la limite soit documentée sur la surface concernée.

**Correctif requis, en amont (client Claude Code) :** masquer ou re-coder l'aperçu de contenu des `Write`/`Edit` dans un dossier PieceMaker — c.-à-d. afficher la version **codée** rédigée par le modèle (disponible dans `tool_input` avant réécriture) plutôt que le `updatedInput` dé-anonymisé, ou supprimer l'aperçu de contenu pour ces outils dans ces dossiers. Rappel de gravité : **aucune fuite API/réseau** — exposition d'**affichage local** uniquement.

---

## Défaut C — 🔴 Fuite d'anonymisation **dépendante du volume** (lecture en masse)

### Situation d'observation
Pour contourner le défaut **A** et lire *toutes* les pièces, lecture **en masse** des 30 `.md` en une seule commande Bash :
```bash
cd ".../Fichiers convertis PieceMaker" && for f in *.md; do echo "===== $f ====="; cat -- "$f"; echo; done
```
Les vrais noms `URGOT` / `CAITLYN` sont apparus dans les en-têtes. La **même** opération en petit lot (3 fichiers) était propre.

### Symptôme
Lecture **unitaire** ou en **petit lot** : anonymisation **complète** (noms de fichiers et contenu codés). Lecture **en masse** (les 30 pièces + contenus concaténés en une seule sortie Bash) : le contenu reste codé, **mais les en-têtes de noms de fichiers laissent passer les vrais noms** `URGOT` / `CAITLYN`.

### Preuve (même machine, même mapping, à quelques secondes d'intervalle)

**Petit lot → propre :**
```bash
for f in 03_declaration_creance_* 06_Email_* 26_Lettre_de_résiliation_*; do echo "H: $f"; done
# H: 03_declaration_creance_URGOT SA.md
# H: 06_..._par_CAITLYN SA_SA.md
# H: 26_..._par_URGOT SA_SA.md      ← codés, OK
```

**Gros lot → fuite :**
```bash
for f in *.md; do echo "===== $f ====="; cat -- "$f"; echo; done
# ===== 01_Kbis_..._dURGOT_SA.md =====        ← VRAI NOM en clair
# ===== 02_Kbis_..._de_CAITLYN_SA.md =====     ← VRAI NOM en clair
# ...   (les corps, eux, restent codés : « URGOT SA », « CAITLYN SA »)
```

Les vraies entités `URGOT` et `CAITLYN` sont **parvenues au contexte du modèle** (donc potentiellement à l'API). Ce n'est **pas** un problème de frontière de mot : le petit lot code correctement les mêmes tokens (`_URGOT`, `dURGOT`). La seule variable est le **volume** de la sortie.

### Ce que dit déjà le code
`lib/hook-io.mjs:100-108` documente précisément ce risque :

> *« sur un pipe … `process.exit()` drops whatever is still in flight past the 64 KB pipe buffer. A truncated JSON is unparseable, so the harness falls back to the *original* tool result: for `anonymize-read.mjs` that means a document over 64 KB reaching the model in clear. The privacy boundary must not depend on payload size. »*

`emit()` (l. 110-131) est censé neutraliser cette troncature **en sortie** en **attendant** le drainage de `stdout` avant `exit`, et `runHook()` (l. 148-165) route bien `anonymize-read` par `emit()`.

### Analyse — pourquoi le garde-fou ne suffit pas ici
- La sortie de ce test est **< 64 Ko** (~15 Ko), donc la troncature **stdout** décrite n'explique pas à elle seule la fuite. Le garde-fou `emit()` protège le côté **sortie** du hook, mais **pas** :
  - le côté **entrée** : `readStdin()` / `readHookPayload()` lisent le `tool_response` que le **harnais** envoie au hook *sur un pipe* — si **ce** flux est tronqué (64 Ko côté harnais→hook), `JSON.parse` échoue → `readHookPayload` renvoie `null` → `noop()` → repli sur le résultat **original en clair**. À vérifier en priorité.
  - une **substitution partielle** : `applyMapping` fait des `.replace` globaux ; une sortie *partiellement* codée (corps codés, en-têtes non) est **anormale** et suggère que le hook a traité un flux **différent** de celui finalement affiché (p. ex. payload d'entrée tronqué, ou résultat recomposé par le harnais).
- Le mélange observé (**corps codés + en-têtes en clair**) n'est explicable par **aucune** troncature simple d'un flux unique. Il faut une **reproduction contrôlée** pour trancher entre : troncature d'entrée, non-déterminisme de timing, ou recomposition du résultat d'outil par le harnais.

### Impact
**RGPD-critique.** L'anonymisation en lecture n'est **pas** invariante à la taille/au volume du flux, alors que le code exige explicitement le contraire. Toute opération qui lit beaucoup en une fois (bulk `cat`, `grep -r`, gros document) peut faire fuiter des identifiants réels vers l'API. Le contournement du défaut **A** (globber en lot) tombe précisément dans ce piège.

### Correctif proposé (avec test de non-régression)
1. **Reproduire** de façon déterministe : générer une sortie d'outil de taille croissante (1 Ko → 64 Ko → 128 Ko) contenant des tokens du mapping à intervalles réguliers, et vérifier qu'**aucun** token réel ne survit à `anonymize-read`.
2. **Instrumenter les deux bords du pipe** : longueur de `raw` reçue par `readHookPayload` vs longueur réelle du `tool_response` ; échec silencieux de `JSON.parse` (aujourd'hui avalé par le `catch` l. 79-81) → journaliser au lieu de `return null`.
3. **Fail-safe, pas fail-open, sur ce hook** : si le payload d'entrée est illisible/tronqué, ne **pas** retomber sur le résultat original en clair — préférer masquer/vider la sortie (fail-closed), car il s'agit de la frontière RGPD.
4. **Test** : étendre `test/hooks-anonymize.test.mjs` avec un cas « gros payload » (> 64 Ko) **et** un cas « multi-fichiers concaténés » asserttant l'absence des tokens réels dans la sortie.

---

## Récapitulatif des correctifs

| # | Correctif | Fichier(s) | Effort |
| --- | --- | --- | --- |
| A | Noms de fichiers neutres à la conversion **ou** dé-anonymiser les chemins d'entrée | pipeline de conversion / `anonymize-read.mjs` (+ mapping inverse) | Moyen |
| B | Aperçu client sur la version codée (ou suppression de l'aperçu de contenu) | intégration CLA/CLI ↔ `deanonymize-write.mjs` | Faible-Moyen |
| C | Repro contrôlée + fail-closed côté entrée + test gros payload | `lib/hook-io.mjs`, `anonymize-read.mjs`, `test/hooks-anonymize.test.mjs` | **Élevé (prioritaire)** |

## Lien avec le contournement de protection déjà documenté
Ce rapport **complète** `protection-hooks-bypass-2026-08-16.md` : celui-ci montrait que la frontière tombe quand le **chemin** est masqué au tokeniseur du hook (variables shell, `cd`, `python`, `find -exec`). Le présent document montre deux angles supplémentaires — **le nom de fichier lui-même** comme vecteur (A) et **le volume du flux** comme vecteur (C) — qui n'exigent, eux, aucune commande « exotique ».

---

*Rapport rédigé à partir d'observations directes en session (Claude Code, Opus) sur le dossier « REAL TEST ». Les livrables produits pendant la session (`Résumé du dossier.md/.docx`) n'utilisent que des codes ; aucun vrai nom n'y a été introduit.*

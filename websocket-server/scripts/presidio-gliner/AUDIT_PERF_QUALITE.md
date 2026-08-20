# PieceMaker — plan v3 (archive historique)

> **Statut — archive, non-feuille de route active.** Ce plan est conservé comme trace de l'analyse
> publiée dans le commit `fb4bca1` du **6 août 2026**. Il fige les mesures, hypothèses et travaux
> « à faire » tels qu'ils étaient alors envisagés ; il ne décrit pas l'état courant du code et ne
> constitue pas un compte rendu d'exécution ultérieure. Ne pas interpréter ses chiffres ou ses
> étapes comme des résultats actuels sans consulter les documents de vérification ci-dessous.
>
> État et résultats disponibles depuis ce plan :
> - [`eval/CRITERES_QUALITE.md`](eval/CRITERES_QUALITE.md) vérifie les étapes 1 à 3 et documente
>   la correction de la fuite liée aux tirets Unicode ;
> - [`eval/BACKENDS_MESURES.md`](eval/BACKENDS_MESURES.md) rassemble les mesures comparatives des
>   backends ;
> - les scripts [`eval/verify_substitution.cjs`](eval/verify_substitution.cjs) et
>   [`eval/verify_whitespace.py`](eval/verify_whitespace.py), ainsi que les résultats
>   [`eval/eval_results.json`](eval/eval_results.json), [`eval/bench_results.json`](eval/bench_results.json)
>   et [`eval/sweep_results.json`](eval/sweep_results.json), indiquent les vérifications
>   effectivement rejouables ou leurs sorties conservées.
>
> Les sections historiques ci-dessous sont volontairement laissées inchangées : leurs mentions
> « à faire », estimations et résultats partiels ne donnent pas le statut courant et ne prouvent
> pas des travaux réalisés aujourd'hui.

> Remplace la v2. Contient **deux corrections de mes propres conclusions** et un renversement de
> l'objectif qualité, provoqué par la lecture du code de substitution que je n'avais pas encore lu.

---

## 0. État du run et chiffres, tous mesurés

Le run end-to-end a été **interrompu à 592/972 chunks (61 %)**, encore en phase d'extraction — il n'a
jamais atteint la phase de classification. Ce qu'il a donné avant de s'arrêter :

| | valeur | base de mesure |
|---|---|---|
| Démarrage (modèle + 2 analyseurs spaCy) | **64 s** | mesuré |
| Extraction | **1,22 s/chunk** | **n = 592 chunks**, 61 % du document |
| → extraction document complet | **19,7 min** | 1,22 × 972 |
| RSS du worker | 869 Mo | mesuré |
| `classify_text` sur contextes réels | **2 890 ms/appel** | n = 25, tirés au sort dans les **1 689 occurrences réelles** |
| → phase classification | **81,3 min** | 2,89 × 1 689 |
| spaCy (pipeline complet, jeté) | ~1,5 min | mesuré |
| **Total attendu** | **≈ 102 min** | |

Ce n'est toujours pas un chrono end-to-end complet. Les deux phases sont maintenant mesurées sur des
échantillons larges et réels, mais la somme reste une somme. **Dis-moi si tu veux que je relance le
run complet** — il sature ton M1 pendant ~1 h 40, je ne le relance pas sans ton feu vert.

---

## 1. ⚠️ Correction n° 1 — j'avais tort sur `classify_text`

En v2 j'ai écrit : « 12 runs, 0 type `ORGANIZATION_*` produit → l'étape ne produit rien ».
Le fait était exact, **l'inférence était fausse**. Mesuré sur 25 contextes réels avec le schéma à
221 labels verbatim de `scanner_worker.py` : `classify_text` renvoie une forme ≠ `other`
**25 fois sur 25**. L'absence de `ORGANIZATION_*` dans les 12 sorties vient donc de ces runs-là
(fichier à 30 labels / version antérieure), pas d'un échec de la fonction.

**Mais ce que la mesure montre est pire.** Voici ce que la fonction produit sur un URD biotech
franco-américain :

```
SA 11/25  ·  AG 2  ·  AS 2  ·  No Liability 1  ·  Osakeyhtiö 1  ·  Ltd 1
EIRELI 1  ·  Srl 1  ·  Aktiengesellschaft 1  ·  GP 1  ·  ANS 1  ·  Inc 1  ·  CC 1
```

`Osakeyhtiö` (finlandais), `EIRELI` (brésilien), `No Liability` (australien), `ANS` (norvégien),
`CC` (Close Corporation sud-africaine) — pour des sociétés comme GenSight, Novartis, Sofinnova.
44 % de « SA » par défaut. Ce ne sont pas des abstentions, ce sont des **réponses fausses et
confiantes, à 2,9 s pièce**.

L'argument de suppression est donc plus fort qu'en v2, mais pour une autre raison : l'étape ne coûte
pas 81 min pour rien, elle coûte 81 min pour **injecter des codes faux** (`SOCIETE_OSAKEYHTIÖ_04`)
dans le document anonymisé.

---

## 2. 🔴 Correction n° 2 — j'avais tort sur l'objectif qualité

En v2 j'ai proposé « maximiser le rappel sous plancher de précision, car un faux positif n'est qu'un
mot caviardé pour rien ». **C'est faux**, et je l'ai écrit avant d'avoir lu le code de substitution.

`taskpane/modules/anonymization-server.cjs:394` :

```js
const regex = new RegExp(escapeRegex(original), 'gi');
result = result.replace(regex, code);
```

Substitution **globale**, **insensible à la casse**, et **sans limite de mot**. Trois conséquences,
toutes vérifiées sur le document réel :

### 2.1 Ta seconde intuition est juste — et déjà implémentée

Détecter une entité **une seule fois suffit** : le `replace` global remplace ensuite toutes ses
occurrences. J'ai mesuré que 74,6 % des occurrences d'entités déjà connues ne sont jamais re-détectées
par GLiNER — j'ai failli te l'annoncer comme une fuite. **Ce n'en est pas une**, précisément à cause
de ce `replace` global. Vérifié avant de te l'écrire.

### 2.2 En revanche chaque faux positif est amplifié à l'échelle du document

Blast radius mesuré, entité par entité, sur le GENSIGHT :

| entité détectée | substitutions déclenchées | dont **à l'intérieur d'un autre mot** |
|---|---|---|
| `CA` | **4 725** | 4 724 — `capital`, `case`, `cash`, `indicators`, `carbon` |
| `us` / `US` | 2 099 ×2 | 1 918 — `business`, `used`, `adjustments` |
| `AU` | 1 030 | 1 028 — `Faubourg`, `authority`, `Audit`, `auditors` |
| `EU` | 726 | 644 — `European` |
| `RU` | 702 | 701 — `rue`, `structure`, `rules`, `instruments` |
| `ZA` | 477 | 476 — `organization`, `commercialization`, `authorization` |
| `IND` | 454 | 432 — `indicators`, `indirect`, `kind` |
| `RP` | 441 | 343 — `Corporation`, `purpose`, `corporate` |
| `Company` | 895 | — (vrai mot, mais générique) |

**Total : 600 entités → 28 956 substitutions sur un document de 194 391 mots.**
Soit environ **un mot sur sept réécrit**. Le document anonymisé n'est pas « sur-caviardé », il est
**détruit** — et de façon irréversible, puisque `reverse_mapping` ne peut pas reconstituer `capital`
à partir de `ADRESSE_07pital`.

### 2.3 Donc l'objectif s'inverse

Ce n'est pas « rappel maximal sous plancher de précision ». Avec cette substitution, **la précision
est le terme dominant** : une entité fausse coûte toutes ses occurrences, et une entité fausse et
courte corrompt le texte. Le rappel *par occurrence*, lui, est presque gratuit grâce au `replace`
global — il suffit d'un seul repérage.

**Objectif corrigé** : *maximiser le rappel sur les entités **distinctes**, sous contrainte de
précision élevée, avec une pénalité spécifique aux entités courtes et fréquentes.*
Et surtout : **corriger la substitution avant de toucher au modèle** — c'est là que se joue le ratio.

---

## 3. Tes deux propositions

### ✅ « Les `\n` doivent être supprimés des .md (ou ne pas être produits) » — oui, et c'est plus grave que je ne l'avais dit

Je peux maintenant le prouver par le code. La substitution utilise `escapeRegex(original)` : une
entité contenant `\n`, un double espace ou un NBSP produit une regex qui n'accepte **que cette
séquence exacte de blancs**. Ces entités-là ne sont donc **jamais substituées nulle part** :

```
ORGANIZATION : 217 entités contiennent un \n   ·  18 un NBSP
PERSON       :  41                              ·  21
LOCATION     :  19                              ·   6
```

**277 entités = fuite de PII réelle**, pas théorique. C'est le seul vrai cas de fuite que j'aie trouvé.

Sur le **où** corriger : à la conversion, comme tu le dis — c'est le seul endroit où les offsets du
`sensitive_map` restent cohérents avec le fichier que tout le monde lit ensuite. Mais pas un
`replace(/\n/g,' ')` brutal : il faut **préserver les sauts de paragraphe (`\n\n`), les listes et les
tableaux**, et ne réduire que les retours à la ligne *intra-paragraphe* (retours de justification PDF),
les espaces multiples et les NBSP. Règle à appliquer dans `smart_converter.py` en post-traitement de
markitdown, avant écriture du `.md`.

### ⚠️ « Quand une entité est repérée, supprimer les occurrences suivantes pour éviter à GLiNER de recommencer » — juste sur la bonne phase, sans effet sur l'autre

- **Phase d'extraction : aucun gain.** Le coût est **par chunk**, pas par entité — 1,22 s que le chunk
  contienne 0 ou 20 entités. GLiNER fait une passe d'encodeur sur le chunk entier quoi qu'il arrive ;
  on ne peut pas lui dire « ignore Gilly ». Et supprimer le texte décalerait tous les offsets, en plus
  d'exiger de savoir que c'est de la PII *avant* de l'avoir cherchée.
- **Phase de classification : exactement ça, et c'est le gros morceau.** Celle-là est bien
  *par occurrence* : **1 689 appels pour 576 noms distincts**. Mémoïser par nom normalisé, c'est
  **−66 %** sur les 81 min. Ton intuition tombe juste sur la seule phase où elle s'applique.
- **Et un troisième usage, meilleur** : une fois l'ensemble des noms distincts connu, une passe
  « gazetteer » (recherche de chaîne de chaque nom connu sur tout le document) rattrape gratuitement
  ce que GLiNER a manqué. C'est précisément ce que fait déjà le `replace` global — d'où le §2.1.

---

## 4. Plan révisé, par ordre de priorité

### Étape 1 — Réparer la substitution 🔴 *avant tout le reste*
`anonymization-server.cjs:377-404`. Rien ne sert de régler le modèle tant qu'une détection correcte
produit un document détruit.
1. **Limites de mot** : `new RegExp("(?<!\\w)"+escapeRegex(original)+"(?!\\w)", "g")`.
   → supprime à elle seule ~11 000 des 28 956 substitutions, toutes fausses.
2. **Supprimer le flag `i`** (ou ne le garder que pour la première lettre). `us` ≠ `US`.
3. **Longueur minimale** : refuser toute entité < 4 caractères hors liste blanche explicite.
   → neutralise `CA`, `us`, `AU`, `EU`, `RU`, `ZA`, `HK`, `MX`, `JP`, `KR`, `CN`.
4. **Ordonner les substitutions par longueur décroissante** et remplacer par jeton non re-substituable,
   pour que `French` ne mange pas `French Monetary and Financial Code`.
- **Critère d'acceptation** : sur le GENSIGHT, 0 substitution à l'intérieur d'un mot. Vérifiable exactement.

### Étape 2 — Normalisation des blancs à la conversion 🔴
Règle décrite en §3. Cible : **0 entité contenant `\n` ou double espace** dans le `sensitive_map`,
et les 1 273 « distincts » qui retombent à 971 (−24 % de faux distincts, cf. v2).

### Étape 3 — Arbitrage de spans 🔴
Supprimer tout span chevauchant ou inclus **quel que soit le type** (presidio ne le fait qu'à type
égal). → corrige les 81 double-typages et 179 chevauchements. Départage : longueur, puis score,
puis priorité PERSON > ORG > LOC — à valider sur corpus.

### Étape 4 — Corpus de référence annoté ⭐
Inchangé depuis la v2, et toujours le prérequis de toute décision « qualité » :
3 documents du Dossier AVION + un extrait GENSIGHT, outil d'annotation HTML local, ~1 h de ton temps.
Métrique révisée par le §2.3 : **rappel sur entités distinctes / précision, avec pénalité sur les
entités courtes et fréquentes**.

### Étape 5 — Faux positifs des pattern recognizers
`IpRecognizer` : 31/31 FP (numéros de section `3.7.2.2`). `UrlRecognizer` : `2023.Th`, `occur.Th`.
Vérifiable exactement, sans annotation.

### Étape 6 — Calibration du seuil, par type
Rappel : le seuil actuel de **0.3 ne filtre rien** (score minimum observé 0.401). Balayage
0.30→0.90 sur le corpus. Tester aussi `0.1` : s'il apparaît des entités sous 0.4, il y a du rappel
gratuit ; sinon c'est un plancher interne du modèle. Mesure, pas hypothèse.

### Étape 7 — Supprimer `classify_text`
Regex de forme juridique sur le nom normalisé ; absence de forme → `ORGANIZATION`.
Gain : **81 min**, et surtout suppression des `Osakeyhtiö`/`EIRELI` du §1.
Couverture mesurée **sur ce document** : 11 % des noms portent une forme littérale (63/576).
**À re-mesurer sur le Dossier AVION** (Kbis « URGOT SA », « CAITLYN SA ») où elle sera bien plus haute.

### Étape 8 — Choix du checkpoint (A/B sur corpus)
`gliner2-privacy-filter-PII-multi` — même backbone, donc **même vitesse**, spécialisé PII.
Décision sur les chiffres du corpus uniquement.

### Étape 9 — Vitesse, chaque levier conditionné à un score corpus inchangé ou meilleur
| levier | gain mesuré | risque qualité |
|---|---|---|
| spaCy en tokenizer seul | −1,5 min, −1 Go RSS | nul (le NER spaCy est déjà jeté) |
| `torch.set_num_threads(6)` | −18 % sur l'extraction | nul |
| mémoïsation classification par nom distinct | −66 % *(sans objet si étape 7 faite)* | nul |
| recouvrement 50 → ~15 mots | −15 à −20 % de chunks | à mesurer sur corpus |
| taille de chunk | — | ⚠️ ne pas augmenter : p90 = 485 tokens / 512, 1 % des chunks débordent déjà |
| MPS · int8 | ⛔ écartés, mesurés | MPS 29,6 vs 23,0 min ; int8 indisponible (`NoQEngine`) |

### Étape 10 — Fuite PII dans les logs
`scanner_worker.py:495` — chaque entité en clair sur stderr, capturé par Electron.
Flag `PIECEMAKER_DEBUG_ENTITIES`, off par défaut.

---

## 5. Bilan

**Qualité** — l'essentiel du ratio ne se joue pas dans GLiNER : il se joue dans la substitution
(28 956 remplacements dont ~11 000 à l'intérieur de mots), la normalisation des blancs (277 entités
jamais substituées = la seule vraie fuite trouvée), et l'arbitrage de spans. Ces trois corrections
coûtent **zéro milliseconde d'inférence**.

**Vitesse** — ~102 min → ~20 min, dont 81 min gagnées en supprimant une étape qui produit des
réponses fausses.

**Ce qui reste inconnu** — précision et rappel réels. Étape 4.

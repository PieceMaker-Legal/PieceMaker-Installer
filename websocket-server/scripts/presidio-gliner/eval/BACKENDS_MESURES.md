# Backends d'inférence — ce qui a été mesuré, et sur quoi

Tout ce qui suit est chronométré sur ce M1 (8 cœurs, 8 Go), `torch.set_num_threads(6)`, sur les
trois tranches annotées (`slice_A/B/C`, 33 chunks) et scoré avec `evaluate.py` — même métrique que
le sweep de configuration : **rappel sur entités distinctes**, précision, et nombre de mots que les
faux positifs réécriraient.

Reproduire : `bench_backend.py {fp32,int8}` · `evaluate.py bench_results.json bench_eval.json` ·
`encoder_backends.py {capture,export,bench <backend>}` · `profile_split.py`.

---

## 0. Où passe le temps

`profile_split.py`, sur `slice_C` :

| | secondes | part |
|---|---|---|
| encodeur mdeberta | 17,13 | **92,2 %** |
| tout le reste (tokenisation, têtes, post-traitement) | 1,46 | 7,8 % |

Conséquence directe : seul l'encodeur mérite d'être optimisé, et Amdahl plafonne le gain global —
un encodeur 3× plus rapide donne 2,6× global, 5× donne 3,8×.

Deuxième fait, moins attendu : chaque séquence commence par le schéma de labels (les quatre
descriptions + la liste des labels), **ré-encodé à l'identique sur chaque chunk** — soit, sur le
GENSIGHT, 972 ré-encodages du même préfixe.

Mesuré sur l'entrée réellement capturée (`artifacts/encoder_inputs.pt`, décodage du préfixe jusqu'à
la fin de la liste de labels) : le schéma fait **198 tokens**, pour des séquences réelles de 645 à
772 tokens, soit **26 à 31 % des tokens encodés**.

> Correction — une version antérieure de ce fichier annonçait « ~370 tokens, environ la moitié de
> chaque passe ». C'était faux : la longueur 772 est la longueur *paddée* du batch (la plus longue
> des 8 séquences), pas la longueur d'une séquence typique, et la part texte avait été sous-estimée
> à ~390 tokens. Le chiffre correct est 198 tokens et ~29 %.

Le calcul reste strictement redondant, mais le gain plafonne à ~29 % des tokens de l'encodeur, et il
n'est pas gratuit : le prompt ne peut pas être retiré (il construit les représentations de labels),
il faudrait mettre en cache l'état encodé du préfixe — ce que l'attention désenchevêtrée de
deberta-v3 ne rend pas trivial, cf. §2.

---

## 1. int8 — écarté, sur deux implémentations indépendantes

### Correction préalable

L'échec précédent (`NoQEngine`) n'était **pas** un défaut du wheel torch. `qnnpack` est bien dans
`torch.backends.quantized.supported_engines` ; c'est `torch.backends.quantized.engine` qui vaut
`'none'` par défaut. Une ligne (`= "qnnpack"`) suffit. La conclusion « int8 indisponible sur cette
machine » était donc fausse, et int8 était testable depuis le début.

### Ce que donne int8 une fois réellement testé

| backend | s/chunk | vs fp32 | rappel @0.7 | précision @0.7 |
|---|---|---|---|---|
| **torch fp32** (production) | **1,293** | — | **1,000** | 0,657 |
| torch int8 dynamique (qnnpack) | 1,924 | **1,49× plus lent** | **0,353** | 0,833 |

Sur `slice_A`, 44 entités détectées en fp32 tombent à 11. La précision monte mécaniquement (il ne
reste que les détections faciles), le rappel s'effondre — exactement le contraire de ce qu'on veut
d'un outil d'anonymisation, où une entité manquée est de la PII qui part chez un tiers.

### La voie de contournement onnxruntime, testée aussi

Mesuré isolément sur l'encodeur (batch 8 × 772 tokens), `encoder_backends.py` :

| backend encodeur | temps | vs torch | max \|Δ\| sur `last_hidden_state` |
|---|---|---|---|
| torch fp32 | 11,26 s | 1,00× | 0 |
| onnxruntime CPU fp32 | 24,74 s | 0,46× (2,2× plus lent) | 0,0007 |
| onnxruntime int8 dynamique per-channel | 20,06 s | 0,56× (1,8× plus lent) | **7,49** |

Un écart maximal de 7,49 sur les états cachés n'est pas une dégradation, c'est un modèle cassé —
et il explique la chute de rappel observée côté torch.

**Pourquoi c'est structurel, et pas un réglage à trouver :** sur Apple Silicon, le GEMM fp32 de
PyTorch passe par Accelerate et les unités AMX, que les noyaux int8 (qnnpack comme ceux d'ORT)
n'égalent pas ; et mdeberta produit des activations à valeurs extrêmes que la quantification
*dynamique par tenseur* écrase. Deux stacks indépendantes donnent le même verdict : plus lent **et**
numériquement détruit. **int8 est écarté sur mesure, pas par principe.**

---

## 2. CoreML / Neural Engine

L'export ONNX à axes dynamiques est **refusé par CoreML** : `has unbounded dimension which is not
supported`. Le graphe est alors découpé en **97 partitions** dont seulement 782 nœuds sur 1825 sont
pris en charge — le reste retombe sur le CPU, avec une copie de tenseurs à chaque frontière.

Un export à **forme fixe** (batch 8 × 772) fait mieux mais reste fragmenté : **25 partitions**,
**592 nœuds sur 1825**. La cause est l'attention désenchevêtrée de deberta-v3 (gather/scatter sur
les positions relatives), précisément le motif que l'Execution Provider CoreML ne couvre pas.

Les 25 partitions compilent bien (25 `.mlmodelc` produits), mais **une seule passe avant n'était
toujours pas revenue au bout de 20 minutes**, là où torch la fait en 11 s. Processus tué.
`onnxruntime` n'est donc pas une voie d'accès utilisable au GPU/ANE pour ce modèle — et ce n'est
pas un verdict sur le Neural Engine, seulement sur ce chemin-là.

### 2.1 Conversion directe par coremltools — la vraie mesure

`coremltools` convertit le graphe entier en **un seul MLProgram**, sans partitionnement. Deux
correctifs ont été nécessaires pour que le tracé passe, tous deux dans `coreml_encoder.py` :

1. `scaled_size_sqrt` (`@torch.jit.script`) fait `sqrt` sur un int32 sous tracé → MIL refuse.
   Replié en constante python (la forme est fixe de toute façon).
2. `build_rpos` (`@torch.jit.script`) garde son `if` dans le graphe, et ses deux branches renvoient
   des rangs différents (`[1,772,772]` vs `[1,1,772,772]`) → MIL refuse le `cond`. En
   self-attention la condition est statiquement fausse ; évaluée en python, la branche disparaît.

Puis un troisième, décisif, **trouvé par la mesure et non par le raisonnement** : la première
conversion tournait mais renvoyait `max |Δ| = nan`. Cause : deberta masque avec
`torch.finfo(fp32).min = -3,4e38`, constante non représentable en fp16 → `-inf` → softmax `0/0`.
Remplacée par `-1e4` (valeur de masque standard en fp16, tout aussi saturante après softmax).

Encodeur seul, batch 1 × 772, contre torch dans le même processus :

| unités de calcul | temps | vs torch | max \|Δ\| |
|---|---|---|---|
| torch fp32 (CPU/AMX) | 1,10 s | 1,00× | 0 |
| CoreML **ANE** (`CPU_AND_NE`) | 3,60 s | **0,31× — 3,3× plus lent** | 0,85 |
| CoreML **GPU** (`CPU_AND_GPU`) | **0,37 s** | **≈ 3× plus rapide** | 0,68 |

**Le Neural Engine est le perdant, pas le gagnant.** C'est le GPU qui porte le gain. L'hypothèse
« le Neural Engine ne fait rien pendant que les cœurs CPU rament » était juste sur le constat et
fausse sur la conclusion : mdeberta ne lui convient pas.

### 2.2 Bout en bout, dans le vrai pipeline, scoré sur le corpus

`bench_coreml_pipeline.py` remplace `model.encoder.forward` par le modèle CoreML (padding à 772,
repli sur torch au-delà). Mesures **alternées** fp32 / CoreML pour neutraliser l'état de la machine :

| | s/chunk (4 runs) | médiane |
|---|---|---|
| torch fp32 | 0,887 · 0,939 · 1,143 · 1,293 | 1,041 |
| CoreML GPU | 0,421 · 0,435 · 0,436 · 0,442 | **0,436** |

**Gain : 2,1× (comparaison meilleur contre meilleur, la plus défavorable) à 2,4× (médianes).**

> Correction — un premier chiffre annonçait 2,93×. Il comparait CoreML à un run fp32 isolé à
> 1,293 s/chunk qui était pollué : réexécuté à froid, fp32 tombe à 0,887. C'est l'alternance des
> runs qui l'a révélé, pas le raisonnement. **2,1× est le chiffre à retenir.**

À noter : CoreML varie de 0,421 à 0,442 (±2 %) quand fp32 varie de 0,887 à 1,293 (±38 %). Le chemin
GPU est isolé de ce qui occupe les cœurs CPU — un bénéfice d'exploitation autant que de vitesse.

**Qualité, seuil de production 0.70, `evaluate.py` :**

| config | rappel | précision | F1 | pred | mots réécrits par les FP |
|---|---|---|---|---|---|
| fp32 | 1,000 | 0,657 | 0,793 | 67 | 109 |
| CoreML GPU | **1,000** | 0,648 | 0,786 | 68 | 112 |

Toute la différence tient en **un seul faux positif** : `LOCATION "US"` sur `slice_A`. Sur les 103
entités communes, l'écart de score est de **0,0008 en médiane, 0,0154 au maximum** — malgré les 0,68
d'écart sur les états cachés. Et ce FP unique est une entité de 2 caractères, que l'étape 1 du plan
(longueur minimale de 4) élimine de toute façon.

### 2.3 Coût de démarrage — et le piège

Charger le `.mlpackage` recompile **à chaque fois** : 97,4 s puis 99,6 s sur deux chargements
consécutifs. Chaque chargement compile dans un répertoire temporaire que le cache système ne
reconnaît pas.

En persistant le `.mlmodelc` et en le chargeant via `ct.models.CompiledMLModel`, le cache est touché :
**97 s au premier chargement, puis 5,8 s**. C'est la différence entre inutilisable et déployable.

### 2.4 Ce qui reste à traiter avant de livrer

- **Forme fixe 772.** Sur les vrais documents français : `Assignation_URGOT` 0/18 chunks au-dessus,
  `Conclusions` 0/13, mais `assignation_tribunal_paris_2026` **3/21**. Le repli torch les couvre
  (il est déjà implémenté et compté), mais soit on convertit à 832/896, soit on descend `CHUNK_SIZE`
  à ~220 mots. À décider sur mesure, pas au jugé.
- **fp16.** Le corpus dit que la dérive ne change rien ici (3 tranches, 27 entités de référence).
  C'est un corpus petit ; l'étape 4 du plan (corpus annoté élargi) reste le vrai filet.
- Les deux patches de tracé sont appliqués **à la conversion**, pas à l'exécution : rien à
  monkeypatcher dans `scanner_worker.py`, seulement charger un `.mlmodelc`.

---

## 3. BATCH_SIZE — vérifié, rien à gagner

L'écart apparent entre batch 1 (0,85 s/séquence) et batch 8 (1,41 s/séquence) relevé entre deux
processus était du bruit. Mesuré proprement dans un seul processus (`bench_batchsize.py`) :

| batch | s/séquence |
|---|---|
| 1 | 1,100 |
| 2 | 1,166 |
| 4 | 1,233 |
| **8** | **1,024** |

`BATCH_SIZE = 8` est déjà le meilleur. Pas de gain gratuit ici — vérifié plutôt que supposé.

---

## 4. Bilan

| levier | verdict | mesure |
|---|---|---|
| **CoreML GPU** | ✅ **à garder** | **1,53× sur le document complet** (§5) — 2,1× sur le corpus court, chiffre trompeur ; qualité identique sur 812 entités |
| CoreML ANE | ⛔ | 3,3× plus lent que le CPU |
| onnxruntime + CoreML EP | ⛔ | 25 partitions, une passe non revenue en 20 min |
| onnxruntime CPU fp32 | ⛔ | 2,2× plus lent |
| int8 (torch qnnpack) | ⛔ | 1,5× plus lent, rappel 1,000 → 0,353 |
| int8 (onnxruntime) | ⛔ | 1,8× plus lent, max \|Δ\| = 7,49 |
| BATCH_SIZE | ⛔ | 8 est déjà l'optimum |

**Sur les documents réels.** Le Dossier AVION fait 2 490 à 4 074 mots par pièce, soit 13 à 21 chunks :
~15 s en fp32, ~7 s en CoreML. Le gain est réel mais se compte en secondes. Le plan v3 reste plus
rentable que tout ce fichier : ses étapes 1 à 3 coûtent zéro milliseconde d'inférence et corrigent
un document détruit par 28 956 substitutions.

---

## 5. Le document complet — mesuré, pas extrapolé

`bench_gensight.py`, GENSIGHT_URD_2023 entier : **194 391 mots, 972 chunks**, les deux backends
exécutés l'un après l'autre sur la même machine au repos.

| backend | durée | s/chunk | entités distinctes | @0.70 | replis torch | RSS |
|---|---|---|---|---|---|---|
| torch fp32 | **18,76 min** | 1,158 | 1 690 | 812 | 0 | 2 481 Mo |
| **CoreML GPU** | **12,23 min** | 0,755 | 1 691 | 812 | **19** | 2 192 Mo |

### Gain réel : **1,53×**, soit **6,5 minutes économisées** — et non les 2,1× annoncés

> Correction — j'extrapolais « ~17 min → ~7 min » depuis le corpus de 33 chunks. Le document
> complet dit **18,76 → 12,23 min**. L'extrapolation était fausse de près du double, pour deux
> raisons que seul un run long pouvait révéler :
>
> 1. **19 lots sur 122 dépassent 772 tokens** et retombent sur torch, au plein tarif fp32. Le
>    corpus de 33 chunks n'en contenait aucun (0/7).
> 2. **La cadence se dégrade sous charge soutenue** : 0,44 s/chunk sur les 80 premiers, 0,755 en
>    moyenne finale. Un benchmark court mesure une machine froide.
>
> C'est exactement ce que « teste sur le doc complet » devait attraper.

Corriger le point 1 (conversion à 832 tokens, ou `CHUNK_SIZE` à ~220 mots) devrait ramener le gain
au-dessus de 1,7× — **à mesurer, pas à extrapoler**, la leçon vient d'être payée. → fait, §6.

### Qualité sur 812 entités — et non plus 27

C'est ici que le document complet vaut le plus : la comparaison porte sur **812 entités au seuil de
production**, contre 27 entités de référence dans les trois tranches.

| seuil | fp32 | CoreML | communes | Jaccard |
|---|---|---|---|---|
| 0,05 | 1 690 | 1 691 | 1 684 | 0,9923 |
| **0,70** | **812** | **812** | **810** | **0,9951** |

Écart de score sur les 1 684 entités communes : **0,00059 en médiane**, 0,0017 en moyenne.

Les quatre entités qui diffèrent ne sont **pas** des pertes de couverture :

| | vu par l'autre backend sous une autre forme |
|---|---|
| CoreML rate `GenSight Biologics SAS` | il détecte `GenSight Biologics`, `GENSIGHT BIOLOGICS`, `GenSight` |
| CoreML rate `PSPC Steering Committee` | il détecte `PSPC` |
| CoreML ajoute `IAS 17` | fp32 détecte `IAS` |
| CoreML ajoute `Novartis Venture Fund` | fp32 détecte `Novartis` |

La substitution étant une recherche de chaîne globale, détecter `GenSight Biologics` caviarde aussi
`GenSight Biologics SAS`. **Aucune fuite de PII d'un backend à l'autre, sur 812 entités.** La dérive
fp16 est établie comme sans effet sur ce document.

---

## 6. Conversion à 832 tokens — la configuration corrigée, et le français

Le 772 du §5 n'était pas un choix : c'était la longueur du lot capturé par hasard pour l'export.
Les longueurs de séquence réellement soumises à l'encodeur sur le Dossier AVION, mesurées lot par
lot (le padding se fait sur la plus longue séquence du lot, pas sur la moyenne) :

| document | longueurs des lots | > 772 |
|---|---|---|
| `Assignation_URGOT_vs_CAITLYN` | 741 · **781** · **811** | 2 / 3 |
| `Conclusions_Assignation_URGOT` | 770 · **811** | 1 / 2 |

Deux lots sur trois de l'Assignation retombaient donc sur torch au plein tarif fp32. Modèle
reconverti à **832 tokens** (`PIECEMAKER_COREML_SEQ`, défaut 832), qui couvre tout le mesuré.

### Résultats, fp32 et CoreML exécutés l'un après l'autre sur chaque document

| document | fp32 | CoreML | gain | replis torch | entités @0.70 | ensembles identiques |
|---|---|---|---|---|---|---|
| GENSIGHT (anglais, 972 chunks) | 1,158 s/chunk | **0,553** | **2,09×** | 11 | 812 / 812 | 810 communes, Jaccard 0,9951 |
| Assignation URGOT (fr, 18 chunks) | 0,932 | **0,403** | **2,31×** | **0** | 24 / 24 | **strictement identiques** |
| Conclusions (fr, 13 chunks) | 0,999 | **0,441** | **2,27×** | **0** | 13 / 13 | **strictement identiques** |

**GENSIGHT complet : 18,76 min → 8,96 min, soit 2,09× et 9,8 minutes économisées** (contre 1,53× et
6,5 min à 772). Sur le français, les replis torch passent de 2/3 à **0**, et le gain de 1,13× à 2,31×.

La cadence ne se dégrade plus non plus de la même façon : 0,41 s/chunk sur les 300 premiers, 0,553
en moyenne finale — la dérive du §5 venait en grande partie des replis, pas seulement du thermique.

Il reste **11 lots sur 122** au-dessus de 832 sur le GENSIGHT (aucun sur le français). Monter à 896
les couvrirait probablement ; le rendement décroît, et le repli torch les traite correctement.

### Qualité : inchangée, et cette fois vérifiée en français

Sur les deux pièces françaises, les ensembles d'entités sont **strictement identiques** entre fp32 et
CoreML, aux deux seuils (0,05 et 0,70). Pas une entité d'écart. Sur le GENSIGHT, Jaccard 0,9951 avec
les quatre écarts déjà analysés au §5, dont aucun n'est une perte de couverture.

**La dérive fp16 est établie comme sans effet sur les deux langues.**

---

## 7. 896 tokens — testé, écarté

Puisque 11 lots sur 122 dépassaient encore 832 sur le GENSIGHT, modèle reconverti à 896 et
document complet repassé :

| forme fixe | GENSIGHT | s/chunk | replis torch |
|---|---|---|---|
| **832** | **8,96 min** | **0,553** | 11 |
| 896 | 9,80 min | 0,605 | 8 |

**896 est 9 % plus lent.** Le surcoût de padding sur les 972 chunks dépasse ce que rapportent les
3 replis évités — et 8 lots dépassent encore 896. **832 est conservé, sur mesure.**

---

## 8. Intégration en production — mesurée sur le worker réel

`verify_worker.py` pilote `scanner_worker.py` par son vrai protocole stdin/stdout, une fois avec
CoreML et une fois sans, et compare les `sensitive_map.json` produits. C'est le seul test qui porte
sur ce qui est livré : le worker, presidio, les pattern recognizers, l'arbitrage de spans et la
sortie JSON.

### Un défaut de démarrage trouvé au passage, indépendant de CoreML

Le premier test a montré un démarrage de 86 s et **trois chargements du modèle de 1 Go**. Cause :
`EntityRecognizer.__init__` de presidio appelle `load()` **depuis le constructeur**, donc chaque
`GLiNER2Recognizer` chargeait son propre modèle — que la ligne `gliner_recognizer.model =
_gliner_model`, exécutée *après* la construction, jetait aussitôt. Un modèle par langue, plus le
modèle partagé : trois.

Corrigé en passant le modèle **au constructeur** (`model=_gliner_model`), avant `super().__init__`.

| | démarrage torch | scan |
|---|---|---|
| avant | 86,5 s | 23–28 s |
| **après** | **30,7 s** | inchangé |

Ce correctif n'a rien à voir avec CoreML et vaut aussi en torch pur : **−56 s à chaque démarrage du
worker**, et un pic mémoire réduit d'autant sur une machine à 8 Go.

### Résultat final, worker réel, `Assignation_URGOT_vs_CAITLYN`

| | démarrage | scan | entités |
|---|---|---|---|
| torch | 30,7 s | 23,3 s | 62 |
| **CoreML** | 39,7 s | **9,0 s** | **62 — sortie strictement identique** |

Le scan passe de 23,3 s à 9,0 s (**2,59×**). CoreML coûte 9 s de démarrage en plus (chargement du
`.mlmodelc`), amorti dès le premier document : 54,0 s contre 48,7 s au total sur une seule pièce.

### La seule différence trouvée sur le worker, et ce qu'elle vaut

Sur `Conclusions_Assignation_URGOT`, les payloads ne sont pas identiques : 36 occurrences côté torch,
35 côté CoreML. En comparant ce qui compte — **les chaînes que la substitution va caviarder**, les
offsets étant sans effet sur un remplacement global :

| | chaînes détectées |
|---|---|
| torch | 12 |
| CoreML | 11 |
| écart | torch détecte en plus `"SA"` — **deux caractères** |

Les autres écarts sont la *même* entité relevée à une occurrence différente. La seule vraie
différence est donc que torch produit un faux positif de 2 caractères que CoreML ne produit pas :
exactement la pathologie du §2.2 du plan v3 (blast radius), que l'étape 1 — longueur minimale de
4 caractères — supprime de toute façon. **CoreML ne perd aucune couverture ; il refuse un FP
dangereux de plus.**

### Dégradation

Les quatre chemins sont testés et sûrs — désactivation explicite, modèle absent, modèle corrompu,
séquence trop longue. Chacun retombe sur torch sans lever d'exception. **Un scan ne doit jamais
échouer à cause d'une optimisation.**

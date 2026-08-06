# Encodeur CoreML — génération et déploiement

`coreml_runtime.py` fait tourner l'encodeur mdeberta sur le GPU du Mac : **2,1× sur le document
complet, sortie identique** (mesures et méthode dans `eval/BACKENDS_MESURES.md`). Si le modèle
compilé est absent, le worker retombe sur torch sans erreur — cette étape est donc **optionnelle**,
elle n'achète que la vitesse.

## Générer le modèle (~4 min, une fois)

```bash
cd eval
PIECEMAKER_COREML_SEQ=832 python3 coreml_encoder.py convert     # ~2 min -> .mlpackage
python3 - <<'PY'
import shutil, coremltools as ct
m = ct.models.MLModel('artifacts/encoder_b1_832.mlpackage',
                      compute_units=ct.ComputeUnit.CPU_AND_GPU)   # ~2 min de compilation
shutil.copytree(m.get_compiled_model_path(), 'artifacts/encoder_b1_832.mlmodelc')
PY
mkdir -p ../models && cp -R artifacts/encoder_b1_832.mlmodelc ../models/
```

Prérequis : `pip install coremltools` (n'a rétrogradé aucune dépendance sur cette machine).

## Pourquoi un `.mlmodelc` et pas le `.mlpackage`

Charger le `.mlpackage` **recompile à chaque démarrage** : 97 s, mesuré deux fois de suite, parce
que chaque chargement compile dans un répertoire temporaire que le cache système ne reconnaît pas.
Un `.mlmodelc` persisté touche ce cache : **97 s au tout premier chargement, puis ~6 s**. C'est la
différence entre inutilisable et livrable.

## Pourquoi 832 tokens

Le padding se fait sur la séquence la plus longue du lot. Longueurs réelles mesurées :

| document | longueurs des lots |
|---|---|
| `Assignation_URGOT_vs_CAITLYN` | 741 · 781 · 811 |
| `Conclusions_Assignation_URGOT` | 770 · 811 |

À 772 (première tentative), 2 lots sur 3 de l'Assignation retombaient sur torch et le gain tombait
à 1,13×. À 832 : **0 repli en français**, 11 lots sur 122 sur le GENSIGHT anglais.

## Pourquoi le GPU et pas le Neural Engine

`CPU_AND_NE` a été mesuré **3,3× plus lent que le CPU** sur ce modèle (3,60 s contre 1,10 s).
L'attention désenchevêtrée de deberta-v3 est le motif que l'ANE traite le plus mal. `CPU_AND_GPU`
est un choix mesuré.

## Désactiver

```bash
PIECEMAKER_COREML=0            # repli torch explicite
PIECEMAKER_COREML_MODEL=/chemin/vers/encoder_b1_<seq>.mlmodelc
```

La longueur de séquence est lue dans le nom du fichier (`encoder_b1_832.mlmodelc` → 832).

## Déploiement

Le `.mlmodelc` fait 620 Mo et n'est **pas** versionné (`.gitignore`). Deux options :
soit l'empaqueter avec l'app, soit le générer à la première exécution. Tant qu'il est absent, le
worker tourne en torch — correct, seulement plus lent.

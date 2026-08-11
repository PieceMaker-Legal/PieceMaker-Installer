---
name: conversion-md
description: Convertir un document (PDF, DOCX, image scannée, etc.) en Markdown avec le smart converter de PieceMaker, y compris choisir entre markitdown et MinerU (OCR). À utiliser dès qu'il faut transformer une pièce en Markdown avant analyse, anonymisation ou insertion dans Word.
---

# Conversion de documents en Markdown (smart_converter.py)

## Commande

`websocket-server/scripts/smart_converter.py` — arguments réels (argparse) :

```
python3 websocket-server/scripts/smart_converter.py <file> -o <output_dir> [--engine auto|markitdown|mineru] [--mode MODE] [--lang LANG]
```

- `file` : positionnel, fichier d'entrée.
- `-o` / `--output` : **requis**, répertoire de sortie.
- `--engine` : `auto` (défaut), `markitdown`, ou `mineru`.
- `--mode` : mode MinerU (`pipeline` / `hybrid` / `vlm`), ignoré si le moteur
  n'est pas MinerU.
- `--lang` : code langue OCR pour MinerU.

Exemple :
```
python3 websocket-server/scripts/smart_converter.py piece.pdf -o output/
python3 websocket-server/scripts/smart_converter.py scan.jpg -o output/ --mode hybrid --lang latin
```

Côté serveur ce script est enregistré dans `PYTHON_SCRIPTS.convert`
(`websocket-server/server.cjs`, ~ligne 3856) et déclenché via le Python
Bridge (`taskpane/modules/python-bridge.js` →
`executePythonScript('convert', file, options, callbacks)`).

## Quand utiliser markitdown vs MinerU

- **`markitdown`** — documents avec une vraie couche de texte : DOCX, PPTX,
  XLSX, PDF "propre" (texte sélectionnable, pas d'image de page entière).
  Rapide, pas de modèle OCR à charger.
- **`mineru`** — PDF scannés ou basés sur image (pas de couche texte), scans
  papier, photos de documents. Plus lent (OCR + mise en page), mais
  nécessaire pour en extraire du texte exploitable.
- **`auto`** (par défaut) — inspecte le fichier et choisit automatiquement
  entre les deux ; c'est le choix par défaut à laisser tel quel sauf besoin
  spécifique (ex. forcer `mineru` sur un PDF qui a une couche de texte
  corrompue ou illisible).

## Enchaînement avec le scan PII

Pour convertir puis scanner en un seul appel, utiliser
`websocket-server/scripts/convert_and_scan_pipeline.py <file1> [file2 ...] -o <output_dir> [--engine ...] [--mode ...] [--lang ...]`,
qui appelle `smart_converter.py` puis
`websocket-server/scripts/presidio-gliner/presidio-gliner.py` pour chaque
fichier (voir la skill `anonymisation`). Sortie persistante : un Markdown par
fichier et un unique `{output_dir}/mapping_default.json` cumulatif. Dans le
pipeline d'administration d'un dossier, `-o` vise le sous-dossier
`Fichiers convertis PieceMaker/` du dossier (racine réservée aux originaux) ;
le manifeste technique caché `.piecemaker/anonymization-state.json` reste, lui, à
la racine du dossier, et sa clé est relative à la racine via `--case-root`. Les
détections brutes par fichier restent temporaires et sont supprimées après leur
fusion.

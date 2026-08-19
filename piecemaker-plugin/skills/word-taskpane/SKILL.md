---
name: word-taskpane
description: Lire et écrire dans un document Word (.docx) — soit via le volet PieceMaker (Word ouvert, read_doc/edit_doc, suivi des modifications + anonymisation), soit en éditant directement l'OOXML du fichier. À utiliser dès qu'il faut ouvrir, lire ou modifier un .docx.
---

# Lire et écrire dans Word

Deux voies. **Volet** = édition interactive dans Word ouvert (suivi des
modifications + anonymisation transparente). **OOXML** = édition directe du
`.docx` sur disque, sans Word.

## Voie volet — Word ouvert

Sur un document précis (chemin absolu, `.docx` uniquement) :

```
open_doc { "path": "/abs/…/doc.docx" }   # ouvre Word + volet sur ce doc
read_doc {}                              # relève les index de paragraphes
edit_doc { "operation": "insert_after", "target_index": 12, "text": "## Titre\nTexte" }
```

- `read_doc` **obligatoire avant** `edit_doc` (imposé côté serveur).
- Texte = Markdown → mise en forme Word (titres, gras, listes, `[^footnote: …]`).
- Modifs en **suivi des modifications** ; mapping d'anonymisation appliqué
  automatiquement (skill `anonymisation`).
- Si le doc est déjà ouvert dans Word, le fermer d'abord (le fichier est réécrit).

Ouvrir Word + volet en **une commande** (dev, serveur `43098` démarré) :

```bash
cd taskpane && npm start    # office-addin-debugging ; npm stop pour arrêter
```

## Voie OOXML — fichier .docx, sans Word

`.docx` = archive ZIP de XML ; le texte vit dans `word/document.xml`.

Le `.docx` original **reste dans son dossier** (jamais modifié en place). On
dézippe une copie de travail dans `Fichiers convertis PieceMaker/` du dossier :

```bash
unzip -d "Fichiers convertis PieceMaker/doc-ooxml" doc.docx
```

- **Lire** : `word/document.xml` de la copie extraite.
- **Écrire** : éditer `word/document.xml` (suivi des modifications = balises
  `<w:ins>` / `<w:del>`) → rezipper vers un nouveau `.docx` (sans compresser
  `[Content_Types].xml`) ; ou `python-docx` pour créer un document.

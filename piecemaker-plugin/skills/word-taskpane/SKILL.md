---
name: word-taskpane
description: Lire et écrire dans un document Word (.docx) — soit via le volet PieceMaker (Word ouvert, read_doc/edit_doc, suivi des modifications + anonymisation), soit en éditant directement l'OOXML du fichier. À utiliser dès qu'il faut ouvrir, lire ou modifier un .docx.
---

# Lire et écrire dans Word

Deux voies. **Volet** = édition interactive dans Word ouvert (suivi des
modifications + anonymisation transparente). **OOXML** = édition directe du
`.docx` sur disque, sans Word.

## Voie volet — Word ouvert

**Une seule commande** ouvre Word sur le document *choisi* (le vrai fichier, en
place) **avec le volet PieceMaker déjà affiché** — sans clic ruban. C'est la
seule voie qui y parvient sur macOS (l'outil `office-addin-debugging` ne sait
pas : avec `--document` il copie le fichier dans `/tmp` sans add-in, sans
`--document` il ouvre un document vierge).

Depuis Claude Code, via l'outil MCP :

```
open_doc { "path": "/abs/…/doc.docx" }   # enregistre l'add-in, injecte le volet
                                          # dans le .docx, lance Word + volet
read_doc {}                              # relève les index de paragraphes
edit_doc { "operation": "insert_after", "target_index": 12, "text": "## Titre\nTexte" }
```

Équivalent HTTP brut (serveur `43098` démarré) — retourne
`paneReady:true, panesConnected:1` quand le volet est connecté :

```bash
curl -sk -X POST https://localhost:43098/api/word/open-doc \
  -H 'Content-Type: application/json' \
  -d '{"path":"/abs/…/doc.docx"}'
```

- `.docx` uniquement, chemin absolu ; idempotent, macOS + Windows.
- `read_doc` **obligatoire avant** `edit_doc` (imposé côté serveur).
- Texte = Markdown → mise en forme Word (titres, gras, listes, `[^footnote: …]`).
- Modifs en **suivi des modifications** ; mapping d'anonymisation appliqué
  automatiquement (skill `anonymisation`).
- Si le doc est déjà ouvert dans Word, le fermer d'abord (le fichier est réécrit).

## Voie OOXML — fichier .docx, sans Word

`.docx` = archive ZIP de XML ; le texte vit dans `word/document.xml`.

Le `.docx` original **reste dans son dossier** (jamais modifié en place). On
dézippe une copie de travail dans un sous-dossier de `Fichiers convertis
PieceMaker/` **dont le nom finit par `-ooxml`** (classé espace de travail) :

```bash
unzip -d "Fichiers convertis PieceMaker/doc-ooxml" doc.docx
```

- **Lire** : `word/document.xml` de la copie extraite.
- **Écrire** : éditer `word/document.xml` (suivi des modifications = balises
  `<w:ins>` / `<w:del>`) → rezipper **toute** la copie extraite (jamais le seul
  `document.xml`) vers un nouveau `.docx`, `[Content_Types].xml` stocké non
  compressé ; ou `python-docx` pour créer un document de zéro.

  ```bash
  cd "Fichiers convertis PieceMaker/doc-ooxml"
  zip -X -0 "../doc-modifié.docx" "[Content_Types].xml"      # stocké
  zip -rX "../doc-modifié.docx" . -x "[Content_Types].xml"   # tout le reste
  ```

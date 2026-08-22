---
name: word-taskpane
description: Lire et écrire dans un document Word (.docx) — soit via le volet PieceMaker (Word ouvert, read_doc/edit_doc, suivi des modifications + anonymisation), soit en éditant directement l'OOXML du fichier. À utiliser dès qu'il faut ouvrir, lire ou modifier un .docx.
---

# Lire et écrire dans Word

Deux voies. **Volet** = édition interactive dans Word ouvert (suivi des
modifications + anonymisation transparente). **OOXML** = édition directe du
`.docx` sur disque, sans Word.

## Voie volet — `open_doc`

### Plusieurs documents simultanés

PieceMaker utilise un seul manifeste et un seul add-in. Word crée une instance
du volet dans chaque `.docx` ouvert. Chaque session Claude Code possède son
propre processus MCP : `open_doc` lie ce processus au document choisi, puis
`read_doc` / `edit_doc` transmettent systématiquement cette identité au serveur.
Les sessions ne dépendent donc jamais du « dernier document ouvert » global.

**Séquence :**

1. S'assurer que le serveur tourne (`piecemaker start` ou `npm run server`).
2. Appeler `open_doc` — il enregistre l'add-in, injecte l'auto-ouverture dans
   le `.docx`, lance Word et attend que le volet se connecte.
3. `read_doc` / `edit_doc` travaillent sur ce document.
4. Pour un **deuxième document** : dans une deuxième session Claude Code,
   appeler `open_doc` avec le second chemin. Chaque session reste ensuite liée
   à son propre document.
5. Pour changer volontairement le document d'une session, rappeler `open_doc`
   dans cette session avec le nouveau chemin.

### Utilisation

```
open_doc { "path": "/chemin/absolu/doc.docx" }
read_doc {}
read_doc { "list_headings": true }
edit_doc { "operation": "insert_after", "target_index": 12, "text": "## Titre\nTexte" }
```

- `.docx` uniquement, chemin absolu.
- `read_doc` **obligatoire avant** `edit_doc`.
- Texte = Markdown → mise en forme Word (titres, gras, listes). Une note exige
  un appel `[^id]` et une définition séparée `[^id]: source` dans le même
  champ `text`. `read_doc` place la définition juste après le paragraphe indexé ;
  elle n'a pas d'index Word propre.
- Modifs en **suivi des modifications** ; anonymisation appliquée.
- Si le document est déjà ouvert sans son volet, le fermer avant `open_doc` :
  l'injection d'auto-ouverture réécrit le paquet `.docx`.

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

## Dépannage

**`open_doc` renvoie `paneReady: false`**
Le volet de ce document ne s'est pas annoncé. Vérifier le serveur et le
certificat ; si nécessaire, quitter Word complètement (Cmd-Q / `taskkill`) puis
rappeler `open_doc`. Il n'existe aucun slot A/B à libérer.

**Le volet affiche « certificat non valide »**
`piecemaker --step 05-certificats`, puis quitter Word complètement.

**Le volet a été fermé par l'utilisateur**
Word réécrit `visibility="0"` dans le `.docx`. Rappeler `open_doc` — il
répare (`injectionReason: "repaired"`).

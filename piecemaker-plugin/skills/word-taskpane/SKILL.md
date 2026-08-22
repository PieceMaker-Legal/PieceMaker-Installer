---
name: word-taskpane
description: Ouvrir, lire ou modifier un document Word (.docx) avec le volet PieceMaker, via open_doc, read_doc et edit_doc, avec suivi des modifications et anonymisation transparente.
---

# Travailler dans Word

## Ouvrir un ou plusieurs volets

Lancer chaque client depuis un terminal partagé : `piecemaker codex` ou
`piecemaker claude`. Vérifier que le serveur tourne, puis lier la session au
document :

```text
open_doc { "path": "/chemin/absolu/document.docx" }
```

Chaque document Word possède son propre volet et chaque session IA reste liée
au volet ouvert par son appel `open_doc`.

Pour travailler simultanément dans plusieurs documents :

1. ouvrir une session `piecemaker codex` ou `piecemaker claude` par document ;
2. appeler `open_doc` avec le document correspondant dans chaque session ;
3. employer ensuite `read_doc` et `edit_doc` dans cette même session.

Ne rappeler `open_doc` avec un autre chemin que pour relier volontairement la
session à un autre volet. Un « Enregistrer sous » conserve la liaison du volet.

## Lire sans gaspiller le contexte

Pour un gros document, commencer par `list_headings`, `heading` ou une plage
`indexes` plutôt que lire tout le document. Suivre ensuite le curseur fourni par
`[TRUNCATED]` jusqu'à couvrir la zone utile.

Dans le Markdown envoyé à Word, écrire un commentaire sous la forme
`<!-- commentaire -->`.

## Dépannage

- Si `open_doc` réclame un terminal partagé, relancer le client avec
  `piecemaker codex` ou `piecemaker claude`.
- Si `paneReady` vaut `false`, fermer le document — au besoin quitter Word —
  puis rappeler `open_doc`.
- Si Word refuse le certificat, exécuter `piecemaker --step 05-certificats`,
  puis quitter et relancer Word.

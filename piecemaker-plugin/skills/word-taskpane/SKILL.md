---
name: word-taskpane
description: Ouvrir, lire ou modifier un document Word (.docx) avec le volet PieceMaker, via open_doc, read_doc et edit_doc, avec suivi des modifications et anonymisation transparente.
---

# Travailler dans Word

## Parcours minimal

L'installation enregistre le serveur MCP Word dans les CLI présentes. Lancer
directement le client normalement, sans commande intermédiaire PieceMaker.

1. Lancer `codex` ou `claude` dans le dossier de travail.
2. Demander l'ouverture du document, ou appeler directement :

```text
open_doc { "path": "/chemin/absolu/document.docx" }
```

Chaque document Word possède son propre volet et chaque session IA reste liée
au volet ouvert par son appel `open_doc`.

Au premier appel, `open_doc` démarre PieceMaker s'il ne tourne pas, lance Word,
prépare l'auto-ouverture du volet et attend qu'il soit prêt. Aucun clic dans le
ruban ni dans le volet n'est normalement nécessaire.
L'approbation éventuelle se fait dans Codex ou Claude, pas une seconde fois
dans le volet.

Pour travailler simultanément dans plusieurs documents :

1. ouvrir une session `codex` ou `claude` par document ;
2. appeler `open_doc` avec le document correspondant dans chaque session ;
3. employer ensuite `read_doc` et `edit_doc` dans cette même session.

Ne rappeler `open_doc` avec un autre chemin que pour relier volontairement la
session à un autre volet. Un « Enregistrer sous » conserve la liaison du volet.

## Lire sans gaspiller le contexte

Pour un gros document, commencer par `list_headings`, `heading` ou une plage
`indexes` plutôt que lire tout le document. Suivre ensuite le curseur fourni par
`[TRUNCATED]` jusqu'à couvrir la zone utile.

## Dépannage

- Si les outils `open_doc`, `read_doc` et `edit_doc` n'apparaissent pas,
  relancer l'étape d'installation « volet Word », puis redémarrer le client.
- Si le démarrage automatique échoue, suivre l'erreur précise renvoyée par
  `open_doc` ; `piecemaker logs` fournit le journal du serveur.
- Si `paneReady` vaut `false`, fermer le document — au besoin quitter Word —
  puis rappeler `open_doc`.
- Si Word refuse le certificat, exécuter `piecemaker --step 05-certificats`,
  puis quitter et relancer Word.

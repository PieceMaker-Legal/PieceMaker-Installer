---
name: word-taskpane
description: Ouvrir, lire, modifier ou injecter un template dans un document Word (.docx) avec le volet PieceMaker, via open_doc, read_doc, edit_doc et template, avec suivi des modifications et anonymisation transparente.
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

Chaque document Word possède son propre volet. `open_doc` renvoie son `paneId` ;
le modèle doit le transmettre à chaque appel `read_doc`, `edit_doc` et
`template` visant ce document.

Au premier appel, `open_doc` démarre PieceMaker s'il ne tourne pas, lance Word,
prépare l'auto-ouverture du volet et attend qu'il soit prêt. Aucun clic dans le
ruban ni dans le volet n'est normalement nécessaire.
L'approbation éventuelle se fait dans Codex ou Claude, pas une seconde fois
dans le volet.

Pour travailler simultanément dans plusieurs documents, appeler `open_doc` pour
chacun d'eux et conserver les `paneId` renvoyés. Une même session peut ensuite
lire ou modifier chaque document en passant le `paneId` correspondant. Un
« Enregistrer sous » conserve le `paneId` du volet.

## Lire sans gaspiller le contexte

Pour un gros document, commencer par `list_headings`, `heading` ou une plage
`indexes` plutôt que lire tout le document. Suivre ensuite le curseur fourni par
`[TRUNCATED]` jusqu'à couvrir la zone utile.

## Injecter un template

`template` prend le `paneId` du document de travail et le chemin absolu du
template `.docx` :

```text
template { "paneId": "a1b2", "path": "/chemin/absolu/template.docx" }
```

L'injection remplace intégralement le contenu et les styles du document ouvert.
Ne jamais cibler un original ni un document contenant un travail à conserver.
En cas de succès, l'outil renvoie directement :

```json
{ "success": true, "content": "<texte intégral du template injecté, placeholders inclus>" }
```

`content` n'est ni une liste de placeholders, ni le contenu d'un placeholder
isolé : c'est tout le texte du template tel qu'il figure dans Word après
l'injection. Il constitue la lecture courante du document. Repérer les
placeholders `{{...}}` directement dans ce texte et poursuivre avec `edit_doc` ;
aucun fichier JSON de description ou d'état des placeholders n'est requis.

## Dépannage

- Si les outils `open_doc`, `read_doc`, `edit_doc` et `template` n'apparaissent pas,
  relancer l'étape d'installation « volet Word », puis redémarrer le client.
- Si le démarrage automatique échoue, suivre l'erreur précise renvoyée par
  `open_doc` ; `piecemaker logs` fournit le journal du serveur.
- Si `open_doc` le demande, exécuter `piecemaker restart`, puis rappeler
  `open_doc`.
- Si Word refuse le certificat, exécuter `piecemaker --step 05-certificats`,
  puis quitter et relancer Word.

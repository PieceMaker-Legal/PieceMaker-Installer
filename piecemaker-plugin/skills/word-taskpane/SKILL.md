---
name: word-taskpane
description: Ouvrir, lire, modifier, régler les styles ou injecter un template dans un document Word (.docx) avec le volet PieceMaker, via open_doc, read_doc, edit_doc, doc_styles et template, avec suivi des modifications et anonymisation transparente.
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

## Régler les styles

`doc_styles` lit et redéfinit la table des styles du document ouvert. Il est
indépendant de `template` : il ne copie aucun style depuis un fichier et ne
touche jamais au contenu.

Lire d'abord, pour connaître les noms exacts (Word les localise : « Titre 1 »
sur un poste français) et les valeurs réelles :

```text
doc_styles { "paneId": "a1b2", "action": "get" }
doc_styles { "paneId": "a1b2", "action": "get", "names": ["Heading 1", "Normal"] }
```

Par défaut la portée est `used` : les styles réellement employés, plus le socle
Normal / Titres / Corps de texte. `"scope": "all"` rend toute la table.

Redéfinir ensuite. Un style redéfini se propage à **tous** les paragraphes qui
le portent : la redéfinition est l'application, il n'y a rien à réappliquer.

```text
doc_styles { "paneId": "a1b2", "action": "set", "styles": [
  { "name": "Heading 1",
    "font": { "name": "Times New Roman", "size": 14, "bold": true },
    "paragraphFormat": { "alignment": "Left", "spaceBefore": 12, "spaceAfter": 6 } }
] }
```

Réponse : `{ "success": true, "updated": [...], "skipped": [...] }`. Seules les
propriétés fournies changent ; les autres restent en place. L'outil ne crée ni
ne supprime aucun style : un nom inconnu revient dans `skipped` avec sa raison,
sans erreur. Il n'affecte pas non plus un style à des paragraphes précis —
c'est le rôle de `edit_doc`.

Le volet demande une approbation avant chaque `set`, la mise en forme changeant
dans tout le document. La lecture passe sans approbation.

Corriger une mise en forme passe donc par `doc_styles`, jamais par une
réinjection de `template`, qui écraserait le contenu déjà rédigé.

## Dépannage

- Si les outils `open_doc`, `read_doc`, `edit_doc`, `doc_styles` et `template`
  n'apparaissent pas, relancer l'étape d'installation « volet Word », puis redémarrer le client.
- Si le démarrage automatique échoue, suivre l'erreur précise renvoyée par
  `open_doc` ; `piecemaker logs` fournit le journal du serveur.
- Si `open_doc` le demande, exécuter `piecemaker restart`, puis rappeler
  `open_doc`.
- Si Word refuse le certificat, exécuter `piecemaker --step 05-certificats`,
  puis quitter et relancer Word.
- Si `doc_styles` répond que l’API des styles est indisponible, la version de Word
  est trop ancienne (WordApi 1.5 requis) : la mise en forme reste alors
  accessible par une injection de `template`.

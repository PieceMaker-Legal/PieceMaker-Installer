---
name: word-taskpane
description: Ouvrir Microsoft Word sur un document depuis une session extérieure (Claude Code) avec le volet PieceMaker déjà affiché, puis y lire et écrire directement. À utiliser dès qu'il faut ouvrir un .docx dans Word, faire apparaître le volet sans clic, ou écrire/modifier le contenu d'un document Word via read_doc / edit_doc.
---

# Ouvrir Word et écrire dans le document (volet PieceMaker)

Pour agir sur un document Word — le lire, y insérer ou modifier du texte — il
faut trois choses réunies : Word ouvert sur **ce** document, le **volet
PieceMaker** chargé (c'est lui qui exécute Office.js), et sa connexion WebSocket
au serveur local (`wss://localhost:43098`). L'outil `open_doc` réunit les trois
automatiquement. Ne demandez plus à l'utilisateur d'ouvrir le volet à la main.

## 1. Ouvrir le document + le volet : `open_doc`

Toujours commencer par là, avec le chemin **absolu** d'un `.docx` :

```
open_doc { "path": "/chemin/absolu/vers/document.docx" }
```

Ce que fait l'outil :
1. enregistre l'add-in sur le poste si nécessaire (une fois, idempotent) ;
2. injecte dans le `.docx` la référence qui fait apparaître le volet à
   l'ouverture — **le contenu visible du document n'est pas modifié** ;
3. lance Word sur ce document (macOS et Windows) et le met au premier plan ;
4. attend que le volet s'annonce.

Réponse utile :
- `paneReady: true` → le volet est connecté, on peut enchaîner `read_doc` /
  `edit_doc`. Ils agissent sur le document **actif** de Word, c'est-à-dire
  celui qu'`open_doc` vient d'ouvrir.
- `paneReady: false` → Word a été lancé mais aucun volet ne s'est annoncé dans
  le délai. Voir « Si le volet ne s'ouvre pas » plus bas.

Contraintes :
- **`.docx` uniquement.** Un `.doc`, un PDF ou une image doivent d'abord passer
  par la conversion (skill `conversion-md` / pipeline) — mais on écrit dans un
  vrai document Word, pas dans le Markdown.
- Si le document est **déjà ouvert** dans Word, le fermer d'abord : la
  préparation réécrit le fichier sur le disque.

## 2. Lire avant d'écrire : `read_doc` puis `edit_doc`

L'écriture est indexée sur les paragraphes, donc **toujours `read_doc` avant
`edit_doc`** (la règle est imposée côté serveur : un `edit_doc` sans `read_doc`
préalable est refusé). Ordre type :

```
open_doc { "path": "…/conclusions.docx" }
read_doc {}                      # relève les index des paragraphes
edit_doc { "operation": "insert_after", "target_index": 12, "text": "## Titre\nTexte…" }
```

- Le texte est du Markdown converti en mise en forme Word (titres, gras, listes,
  notes de bas de page `[^footnote: …]`).
- Les modifications arrivent en **suivi des modifications** (track changes).
- L'anonymisation reste transparente : si un mapping est actif pour le
  document, `read_doc` code les entités et `edit_doc` les restaure — voir la
  skill `anonymisation`.

## Si le volet ne s'ouvre pas (`paneReady: false`)

Dans l'ordre :
1. **Add-in non enregistré sur le poste** — relancer l'étape d'installation
   « Ouverture automatique du volet Word » (`piecemaker`, étape
   `12-word-taskpane`).
2. **Serveur non démarré** — `piecemaker status` ; au besoin `piecemaker open`.
3. **Repli manuel** — dans Word, onglet Accueil → bouton « Ouvrir PieceMaker »
   du groupe PieceMaker. Le volet se connecte alors comme d'habitude, et
   `read_doc` / `edit_doc` fonctionnent sur le document au premier plan.

## Sous le capot (pour situer)

`open_doc` appelle `POST /api/word/open-doc` (server.cjs), qui s'appuie sur
`websocket-server/lib/docx-autoopen.cjs` (injection webextension, storeType
« Registry ») et `websocket-server/lib/word-launcher.cjs` (enregistrement +
lancement multi-plateforme). Le volet (`taskpane/taskpane.js`) s'annonce par un
message WebSocket `pane-hello` dès sa connexion ; c'est ce que `open_doc`
attend. `read_doc` / `edit_doc` transitent ensuite par le relais MCP existant
(serveur → WebSocket → Office.js dans le volet).

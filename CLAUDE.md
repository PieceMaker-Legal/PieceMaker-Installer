# PieceMaker

PieceMaker est un service local qui outille un cabinet d'avocats français :
anonymisation des pièces (RGPD), recherche et rédaction juridiques assistées,
gestion des pièces d'un dossier et tamponnage du bordereau. Tout tourne sur
votre machine — aucune donnée client ne quitte le cabinet sans passer par les
garde-fous décrits ci-dessous.

Ce fichier est lu automatiquement par toute session Claude Code ouverte à la
racine de l'installation PieceMaker. Il oriente l'**usage** de PieceMaker. Vous
pouvez le modifier (y compris depuis l'administration, section « Skills et
agents ») pour y ajouter vos propres consignes de cabinet : elles survivront aux
mises à jour.

> Le travail juridique lui-même — analyser, anonymiser, rédiger, tamponner — se
> fait **dans un dossier juridique**, pas ici. Chaque dossier a son propre
> `CLAUDE.md` (charte du dossier) qui décrit les règles qui s'y appliquent. Ce
> répertoire-ci sert à faire tourner et administrer PieceMaker.

## Règles absolues

Elles valent partout, y compris quand vous manipulez des fichiers d'un dossier
depuis une session ouverte ici.

1. **Les pièces protégées ne se lisent jamais.** Un hook refuse tout
   `Read`/`Grep`/`Glob`/`Bash` visant une pièce protégée. La protection est une
   propriété du fichier, décidée dans l'administration : **tout ce qui n'est ni
   `.md` ni `.json` est protégé par défaut**. On travaille sur le Markdown
   converti, jamais sur l'original. Le refus indique le `.md` à lire à la
   place — ce n'est pas un bug, ne pas le contourner.
2. **Rien d'identifiant ne sort du cabinet.** Avant tout envoi, dépôt ou partage
   d'un document, passer par l'agent `verificateur-anonymisation`.
3. **Aucune citation juridique inventée.** Texte, article et date de version
   doivent être vérifiables — utiliser les outils MCP `legifrance` et la skill
   `recherche-juridique`.
4. **Le mapping d'anonymisation ne se lit pas.** Les fichiers `mapping*.json` et
   `*_sensitive_map.json` sont refusés au modèle : les lire ré-identifierait tout
   le dossier d'un coup.

## Comment ça marche, en bref

- **Le modèle ne voit que des codes ; le cabinet ne voit que des noms.** Les
  fichiers restent en clair sur le disque. Ce sont les résultats et les entrées
  d'outil que les hooks réécrivent à la volée : à la lecture le vrai nom devient
  un code (`PERSONNE_PHYSIQUE_1`…), à l'écriture le code redevient le vrai nom.
  Aucun nom réel ne part vers l'API.
- **Un dossier sans mapping ne peut pas être anonymisé**, donc ses pièces
  Markdown sont bloquées à la lecture tant que l'anonymisation n'a pas tourné.
  C'est la raison d'être du bouton « Anonymiser & mapper » de l'administration.
- **Chaque écriture réussie crée un point de sauvegarde** du dossier concerné
  (dépôt Git nu rangé hors des données client, dans `~/.piecemaker/`). Rien à
  lancer à la main ; consultation et restauration se font depuis
  l'administration.

## Piloter le serveur

```bash
piecemaker            # menu interactif (opérations + installateur)
piecemaker open       # démarre le serveur et ouvre l'administration
piecemaker start | stop | status | logs
```

L'administration s'ouvre sur `https://localhost:43098/admin/`. C'est là que
s'enregistrent les dossiers juridiques, que se lancent conversions et scans PII,
que s'édite le mapping, que se décide la protection des pièces, et que se
consultent historique et facturation.

Les outils MCP `PieceMaker` (`read_doc`, `edit_doc`…) passent par le serveur
local puis par le volet Office dans Word : ils supposent `piecemaker start`
**et** Word ouvert sur le document. Sans cela l'appel échoue — vérifier avec
`piecemaker status` avant de conclure à un bug.

## Ce qui est disponible

**Skills** (`/nom` ou déclenchement automatique)
- `conversion-md` — convertir une pièce (PDF, DOCX, scan) en Markdown.
- `anonymisation` — scan PII, lecture/édition du mapping, ré-identification.
- `recherche-juridique` — sourcer et vérifier une référence via `legifrance`.
- `redaction-juridique` — rédiger/réviser conclusions, assignation, courrier,
  mémo, à partir des gabarits du cabinet et de citations vérifiées.
- `tamponnage` — tampon du cabinet et numérotation des pièces d'un bordereau.
- `word-taskpane` — ouvrir Word sur un document avec le volet PieceMaker déjà
  affiché, puis y lire et écrire.
- `ajout-de-fonctionnalites` — ajouter vos propres consignes, skills, gabarits
  ou éléments propres à un dossier, de façon durable.

**Agents** (via l'outil Agent, lecture seule)
- `analyste-piece` — synthèse structurée d'une pièce (type, date, faits,
  pertinence probatoire).
- `verificateur-anonymisation` — audit avant sortie du cabinet ; ne modifie ni
  le document ni le mapping.

**MCP `legifrance`** — recherche de codes, jurisprudence (Cour de cassation,
Conseil d'État, cours d'appel, CAA, première instance), BODACC.
**MCP `PieceMaker`** — outils document/dossier passant par Word (voir ci-dessus).

## Repères

| Quoi | Où |
| --- | --- |
| Administration | `https://localhost:43098/admin/` |
| Serveur | `piecemaker start` / `stop` / `status` / `logs` |
| Dossiers juridiques | enregistrés individuellement, peuvent être n'importe où |
| Historique des dossiers | `~/.piecemaker/case-history/` |
| Facturation | `~/.piecemaker/billing/` |
| Configuration | `~/.piecemaker/config.json` |

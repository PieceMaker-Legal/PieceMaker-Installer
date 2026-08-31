---
name: graphe-juridique
description: "Construire, interroger ou diagnostiquer le graphe juridique riche Graphify d'un dossier PieceMaker. À utiliser pour toute question portant sur les liens de droit, contrats, obligations, inexécutions, demandes, arguments, normes ou décisions entre les parties du dossier — ou pour vérifier l'état du graphe."
---

# Graphe juridique Graphify

## Ce que c'est

Le graphe juridique riche est un artefact distinct de la chronologie. Il est
construit par Graphify (moteur local, sans envoi de données hors poste) à
partir du corpus pseudonymisé du dossier et recentré exclusivement sur les
parties sélectionnées par l'avocat.

Il modélise : contrats, obligations, prestations, exécutions et inexécutions,
dommages, demandes, sanctions, prétentions, arguments, contestations, questions
juridiques, normes, décisions, faits et preuves — reliés aux parties et aux
pièces du dossier par des relations typées.

## Valeur pour l'avocat

- **Réponse immédiate** aux questions transversales : « quelles obligations
  contractuelles lient les parties ? », « sur quels fondements la demande
  repose-t-elle ? », « quels documents prouvent l'inexécution ? ».
- **Sous-graphe ciblé** : la requête retourne uniquement les nœuds et arêtes
  pertinents, avec les statuts probatoires (`ALLEGUE`, `CONTESTE`, `JUGE`,
  `INFERRE`, `A_VERIFIER`) et les sources vérifiables.
- **Pas de lecture exhaustive** : le graphe dispense de parcourir toutes les
  pièces pour reconstituer la chaîne juridique.
- **Registre des parties garanti** : seules les parties explicitement choisies
  dans l'administration sont des nœuds centraux — jamais un témoin, un
  signataire accessoire ou un code GLiNER non validé.
- **Confidentialité** : le corpus transmis à Graphify est entièrement
  pseudonymisé ; aucun nom, adresse ou SIREN en clair ne sort du poste.

## Commandes

### Interroger le graphe

```bash
piecemaker graph query "<question juridique>"
```

Construit ou actualise le graphe si les pièces ont changé, puis retourne le
sous-graphe pertinent. Ne dépend ni du MCP, ni du serveur PieceMaker, ni de
Word. Exemples de questions :

- « Quelles sont les obligations contractuelles entre les parties ? »
- « Sur quels fondements le demandeur réclame réparation ? »
- « Quels documents mentionnent l'inexécution alléguée ? »
- « Quelle est la position du défendeur sur la nullité ? »

### Vérifier l'état du graphe

```bash
piecemaker graph status
```

Retourne : existence du graphe, fraîcheur (stale ou non), registre des parties
et statistiques (pièces incluses/exclues, parties mentionnées/absentes, nœuds
élagués).

### Reconstruire le graphe

```bash
piecemaker graph build [--force]
```

Force la reconstruction complète, même si le cache est valide. Utile après une
modification du mapping ou des parties.

## Prérequis

1. Le dossier doit être anonymisé (« Anonymiser & mapper » dans
   l'administration).
2. Les parties de la procédure doivent être sélectionnées dans l'éditeur des
   parties de l'administration (`https://localhost:43098/admin/`).
3. Graphify doit être installé (`piecemaker doctor` vérifie la présence et la
   version).

Sans parties sélectionnées, le graphe juridique riche n'est pas construit. La
chronologie et le graphe documentaire GLiNER restent disponibles.

## Interpréter les résultats

Le sous-graphe retourné contient des métadonnées à qualifier :

| Statut | Signification |
| --- | --- |
| `CONSTATE_DANS_PIECE` | Fait objectivement présent dans la pièce source |
| `ETABLI_PAR_ACTE` | Stipulation ou engagement formel dans un acte |
| `ALLEGUE` | Affirmation d'une partie, non encore établie |
| `CONTESTE` | Point contesté par la partie adverse |
| `RECONNU` | Fait reconnu par les deux parties |
| `JUGE` | Tranche par une décision de justice |
| `INFERRE` | Déduit par le modèle, à vérifier impérativement |
| `CADRE_LEGAL` | Norme ou principe général du droit |
| `A_VERIFIER` | Qualification incertaine, révision requise |

**Les nœuds marqués `revision=REQUISE` demandent une vérification humaine** :
soit un concept juridique n'est pas directement relié à une partie, soit une
partie sélectionnée n'apparaît dans aucune pièce indexée.

## Limites

- Le graphe dépend de la qualité de la conversion Markdown et de
  l'anonymisation : une pièce mal convertie produit un contenu vide ou
  incomplet.
- Les pièces ne mentionnant aucune partie sélectionnée sont exclues du graphe
  riche (mais restent dans la chronologie).
- Le modèle peut produire des inférences erronées (`INFERRE`) : toujours
  vérifier avec la pièce source.
- Le graphe ne remplace pas l'analyse juridique de l'avocat ; il structure et
  accélère la lecture du dossier.

---
name: recherche-juridique
description: Rechercher un texte de loi ou de code, vérifier qu'un article est en vigueur et sa date de version, ou retrouver une décision de jurisprudence (Cour de cassation, Conseil d'État, cours d'appel, CAA, première instance) via les outils MCP legifrance. À utiliser dès qu'il faut sourcer ou vérifier une référence juridique, avant de la citer dans un acte, un mémo ou une réponse.
---

# Recherche et vérification juridique (legifrance)

## Règle non négociable

Toute référence à un texte (code, loi, décret, article) ou à une décision de
justice citée ensuite dans un document doit porter **son identifiant précis
et sa date de version** (ex. : "Article 1240 du Code civil, dans sa
rédaction issue de l'ordonnance n° 2016-131 du 10 février 2016" ou
"Cass. civ. 1re, 12 janvier 2022, n° 20-18.640"). Une référence dont
l'identifiant ou la version ne peut pas être confirmé par les outils
disponibles **ne doit jamais être produite**. En cas de doute, écrire
explicitement que la référence n'a pas pu être vérifiée plutôt que
d'inventer une citation plausible : une fausse référence juridique a des
conséquences réelles pour le client.

## Outils MCP legifrance disponibles dans la session

Quand ces outils apparaissent dans la session (préfixe
`mcp__plugin_piecemaker_legifrance__`), les utiliser systématiquement plutôt
que de répondre de mémoire :

| Outil | Usage |
| --- | --- |
| `Search_Code` | Retrouver le texte en vigueur exact d'un article de code (numéro + version applicable à la date pertinente). |
| `Search_Cour_Cassation` | Rechercher une décision de la Cour de cassation. |
| `Search_Conseil_Etat` | Rechercher une décision du Conseil d'État. |
| `Search_Cour_Appel` | Rechercher un arrêt de cour d'appel. |
| `Search_CAA` | Rechercher une décision de cour administrative d'appel. |
| `Search_Premiere_Instance` | Rechercher une décision de première instance. |
| `consulter_decision` | Ouvrir le texte intégral d'une décision déjà identifiée (numéro/référence). |
| `Tracking_BODACC` | Suivre une publication BODACC (annonces légales, procédures collectives). |
| `Brainstorming` | Explorer des pistes de recherche quand la qualification juridique du problème n'est pas encore claire. |

Workflow type : identifier la question de droit → chercher le texte ou la
décision avec l'outil adapté → vérifier qu'un article cité n'a pas été
abrogé ou modifié depuis (version applicable à la date des faits ou de la
procédure, pas seulement "en vigueur aujourd'hui") → ne restituer que ce que
l'outil a confirmé, avec l'identifiant exact.

## Si aucun outil legifrance n'est disponible dans la session

Le dire explicitement à l'utilisateur ("je n'ai pas accès aux outils
legifrance dans cette session, je ne peux pas vérifier cette référence")
plutôt que de citer de mémoire un article ou une décision.

## Pour la rédaction

Cette skill couvre la recherche et la vérification, pas la rédaction de
l'acte lui-même : voir la skill `redaction-juridique` pour rédiger ou
réviser un document à partir des gabarits du cabinet, en s'appuyant sur les
références vérifiées ici.

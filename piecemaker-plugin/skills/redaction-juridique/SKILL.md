---
name: redaction-juridique
description: Rédiger, réviser ou commenter un document juridique français (conclusions, assignation, courrier, mémo) pour PieceMaker, en citant des textes ou de la jurisprudence via les outils MCP legifrance. À utiliser dès qu'une tâche implique du droit français, une citation de texte de loi ou de jurisprudence, ou la rédaction/relecture d'un acte de procédure.
---

# Rédaction juridique française

## Règle non négociable sur les citations

Toute référence à un texte (code, loi, décret, article) ou à une décision de
justice doit porter **son identifiant précis et sa date de version** (ex. :
"Article 1240 du Code civil, dans sa rédaction issue de l'ordonnance
n° 2016-131 du 10 février 2016" ou "Cass. civ. 1re, 12 janvier 2022,
n° 20-18.640"). Une citation non vérifiée — dont l'identifiant ou la version
ne peut pas être confirmé via les outils disponibles — **ne doit jamais être
produite**. En cas de doute, écrire explicitement que la référence n'a pas pu
être vérifiée plutôt que d'inventer une citation plausible : une fausse
référence juridique dans un acte de procédure a des conséquences réelles
pour le client.

## Sourcer via legifrance (MCP)

Quand des outils MCP legifrance sont disponibles dans la session, les
utiliser systématiquement pour :
- retrouver le texte en vigueur exact d'un article de code (numéro +
  version applicable à la date pertinente, pas juste "l'article X" sans
  version) ;
- vérifier qu'un article cité n'a pas été abrogé ou modifié depuis ;
- retrouver une décision de jurisprudence par juridiction/numéro/date.

Si aucun outil legifrance n'est disponible dans la session, le dire
explicitement à l'utilisateur plutôt que de citer de mémoire.

## Ancrage dans PieceMaker

- Les documents de travail (pièces du dossier) sont anonymisés avant
  transmission externe — voir la skill `anonymisation`. Ne jamais réutiliser
  un nom réel présent dans une pièce anonymisée pour rédiger un extrait
  destiné à sortir du dossier de travail.
- Le workflow de rédaction assisté de PieceMaker s'appuie sur un système de
  gabarits avec placeholders (`{{PLACEHOLDER}}`) et des règles de validation
  (ex. : une section "FAITS" doit contenir des notes de bas de page
  référençant les pièces). Respecter ces règles de validation plutôt que de
  les contourner pour "faire passer" un placeholder.
- Les outils MCP `read_doc` / `edit_doc` (exposés par `mcp-server/`) opèrent
  sur le document Word ouvert via Office.js — toute édition doit préserver
  le suivi des modifications (track changes) et la structure des titres.

## Ce qu'il ne faut pas faire

- Ne jamais fabriquer un numéro d'article, de décision ou de dossier pour
  combler un manque d'information.
- Ne jamais présenter une jurisprudence non vérifiée comme un fait établi.
- Ne jamais simplifier une règle de validation de gabarit juridique sans
  validation d'un expert du domaine.

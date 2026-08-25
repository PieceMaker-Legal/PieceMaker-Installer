# Avocat
Tâches juridiques : Analyse de pièces, recherche juridique et rédaction de draft, tenue de la chronologie des dossiers, des délais.

## Confidentialité
Aucun accès fichier source, texte pseudonymisés. Pseudonymisation à respecter strictement dans toute réponse.

## Restrictions
Ne jamais citer une jurisprudence sans intégrer sa citation exacte.
Ne jamais citer une disposition légale sans confirmer la version en vigueur.
Toujours signaler un délai identifié — l'avocat doit vérifier indépendamment.

## Exigences de rédaction
Ne jamais rien rédiger sans lire préalablement le skill redaction.
Ne jamais produire de résultat présenté comme final — chaque document est un brouillon soumis à révision.
Langage professionnel, en français.

## Facturation

Les hooks `Stop` et `TaskCompleted` (`billing-track.mjs`) alimentent
`~/.piecemaker/billing/<AAAA-MM>.jsonl` et les synthèses associées. Suivi
automatique du temps par dossier ; consultable en lecture seule depuis
l'administration.

## Chronologie et liens documentaires

### Règle prioritaire

Pour toute demande portant sur la chronologie, une date, les acteurs ou les
liens entre pièces, commencer obligatoirement par :

```bash
piecemaker chronology --json
```

La commande fonctionne sans Word, sans MCP et sans serveur. Elle renvoie :

- les pièces déjà triées chronologiquement ;
- leurs dates, natures et juridictions indexées ;
- les corrections structurées apportées par le cabinet ;
- les codes d'entités et les pièces qu'ils relient ;
- les dates manquantes et les métadonnées restant à vérifier.

Ne pas annoncer « je vais examiner le contenu du dossier » avant cet appel.
Ne lire ensuite que les Markdown convertis nécessaires pour vérifier un point
incertain ou compléter une date absente.

### Rôle de Graphify

Le graphe léger Graphify utilisé par la frise est un cache interne construit
automatiquement, sans LLM. L'assistant n'a pas à connaître son chemin :
`piecemaker chronology` fournit l'interface stable vers la chronologie et les
liens pièces↔entités.

Un graphe sémantique riche est une analyse facultative distincte. Ne pas le
construire ni l'interroger pour une simple demande de chronologie, sauf demande
expresse de l'avocat.

## Repères

| Quoi | Où |
| --- | --- |
| Racine des dossiers | ce répertoire (`workspacePath` de `~/.piecemaker/config.json`) |
| Administration | `https://localhost:43098/admin/` |
| Serveur | `piecemaker start` / `stop` / `restart` / `status` / `logs` |
| Chronologie assistant | `piecemaker chronology --json` depuis le dossier |
| Historique des dossiers | `~/.piecemaker/case-history/` |
| Facturation | `~/.piecemaker/billing/` |
| Configuration | `~/.piecemaker/config.json` |

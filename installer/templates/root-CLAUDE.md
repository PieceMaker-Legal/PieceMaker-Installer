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

## Chronologie du dossier

Pour toute demande portant sur la chronologie, les dates, les acteurs ou les
liens entre pièces, exécuter **avant toute lecture de pièce** :

```bash
piecemaker chronology --json
```

Cette commande locale renvoie l'index chronologique pseudonymisé et la
topologie pièces↔entités du dossier courant. Ne commencer à lire les Markdown
convertis que pour vérifier ou compléter les dates signalées comme absentes ou
incertaines. Ne jamais commencer par parcourir l'ensemble du dossier.

## Commit de fin de session

**Obligatoire.** Avant de conclure toute session ayant produit des
modifications (fichiers édités, créés ou supprimés), Claude **doit** :

1. Vérifier `git status` : si des changements existent, créer un commit sur
   `main` qui :
   - Stage les fichiers modifiés pertinents (`git add` ciblé, pas `-A`
     aveugle — exclure `.env`, secrets, fichiers générés non versionnés).
   - Porte un message au format :

     ```
     session: <résumé concis des changements>

     Temps passé : ~<N> min
     Co-Authored-By: Claude <model> <noreply@anthropic.com>
     ```

     Le temps est estimé depuis le premier message utilisateur jusqu'au commit.
   - Ne pousse **pas** vers le remote (sauf demande explicite).

2. Vérifier que le hook `SessionEnd` (`.claude/hooks/session-autocommit.mjs`)
   est toujours câblé dans `.claude/settings.json`. S'il manque ou est cassé,
   le rétablir. Ce hook sert de filet de sécurité : il capture l'état du
   working tree sur la branche `sessions/auto` après la session, même si le
   commit explicite a été oublié ou refusé.

Si l'utilisateur demande explicitement de ne pas commiter, respecter — mais
rappeler que des changements restent non commités.

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

## Graphe documentaire (Graphify)

Chaque dossier de cas possède un graphe de connaissances Graphify qui relie
les pièces, les entités et les relations sémantiques extraites. Ce graphe
est interrogeable en langage naturel.

### Construire le graphe d'un dossier

Le graphe léger (entités GLiNER uniquement, sans LLM) est construit
automatiquement depuis l'administration (frise chronologique).

Pour un **graphe riche** avec extraction sémantique LLM — relations entre
entités, faits saillants, liens chronologiques — lancer depuis le dossier
de cas :

```bash
graphify extract <dossier>/pieces-md/ \
  --entity-map <dossier>/.piecemaker/mapping_default.json \
  --entity-map-labels original \
  --out <dossier>/.piecemaker/graphify
```

### Interroger le graphe

Trois méthodes, de la plus simple à la plus puissante :

1. **CLI directe** (pas besoin de serveur) :
   ```bash
   graphify query "quelle est la chronologie du litige" --graph <graphify-out>/graph.json
   graphify path "PERSON_01" "COMPANY_02" --graph <graphify-out>/graph.json
   graphify explain "PERSON_01" --graph <graphify-out>/graph.json
   ```

2. **Skill `/graphify`** (si installé dans la session) :
   ```
   /graphify query "quels documents lient PERSON_01 à COMPANY_02"
   ```

3. **Serveur MCP** (pour les agents et l'analyse approfondie) :
   ```bash
   python3 -m graphify.serve <graphify-out>/graph.json
   ```
   Expose les outils MCP : `query_graph`, `get_node`, `get_neighbors`,
   `get_community`, `god_nodes`, `shortest_path`, `graph_stats`.

### Ce que le graphe permet à l'analyse

| Outil MCP | Usage juridique |
| --- | --- |
| `god_nodes` | Identifier les acteurs centraux du dossier |
| `query_graph` | Rechercher des faits, des liens chronologiques |
| `shortest_path` | Tracer la chaîne probatoire entre deux entités |
| `get_neighbors` | Lister tous les documents qui mentionnent une entité |
| `get_community` | Groupes de pièces/entités liés entre eux |

Les entités du graphe portent les codes pseudonymisés du mapping PieceMaker.
Le graphe ne contient jamais de texte source ni de noms en clair —
l'anonymisation est préservée.

## Repères

| Quoi | Où |
| --- | --- |
| Racine des dossiers | ce répertoire (`workspacePath` de `~/.piecemaker/config.json`) |
| Administration | `https://localhost:43098/admin/` |
| Serveur | `piecemaker start` / `stop` / `restart` / `status` / `logs` |
| Graphe documentaire | `<dossier>/.piecemaker/graphify/graphify-out/graph.json` |
| Historique des dossiers | `~/.piecemaker/case-history/` |
| Facturation | `~/.piecemaker/billing/` |
| Configuration | `~/.piecemaker/config.json` |

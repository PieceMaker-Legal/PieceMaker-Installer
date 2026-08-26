# Anonymisation PieceMaker — proxy PII et hooks résiduels

Depuis le 25 août 2026, le mapping d'anonymisation n'est plus appliqué par des
hooks Claude Code. Le proxy PII LiteLLM constitue l'unique frontière commune à
Claude Code et Codex :

```text
client local en clair
        │ requête
        ▼
proxy PII : entité → code
        │
        ▼
fournisseur LLM : codes uniquement
        │ réponse
        ▼
proxy PII : code → entité
        │
        ▼
client local en clair
```

Le proxy lit `~/.piecemaker/central-mapping.json`, construit par
`piecemaker-plugin/scripts/lib/central-mapping.cjs`. Le serveur reconstruit ce
fichier au démarrage et chaque écriture d'un mapping de dossier le synchronise.
Le proxy recharge le fichier à chaud.

## Hooks Claude Code conservés

`piecemaker-plugin/hooks/hooks.json` ne contient que des fonctions locales qui
ne substituent aucune entité :

| Événement | Script | Rôle |
| --- | --- | --- |
| `PreToolUse` | `protect-originals.mjs` | Refuse les pièces protégées, mappings et scans PII |
| `PostToolUse` | `track-legifrance-reads.mjs` | Suit les lectures de résultats Légifrance |
| `PostToolUse` | `commit-track.mjs` | Versionne les modifications du dossier |
| `PostToolUse` | `compile-recherche.mjs` | Compile le rapport de recherche |
| `Stop` / `TaskCompleted` | `billing-track.mjs` | Alimente la facturation locale |

Le garde-secrets global `piecemaker-guard-secrets.mjs` reste également actif.
Il interdit l'accès au `.env` et au mapping central, qui contiennent des secrets
ou les correspondances entre codes et identités.

## Hooks supprimés

Les composants suivants sont retirés du dépôt et explicitement ignorés afin
qu'ils ne soient pas réintroduits par mégarde :

- `piecemaker-plugin/scripts/anonymize-read.mjs` ;
- `piecemaker-plugin/scripts/deanonymize-write.mjs` ;
- `websocket-server/global-hooks/piecemaker-central-anonymize.mjs` ;
- `websocket-server/central-hook-install.cjs`.

Au démarrage du serveur, pendant l'étape 06 et après une mise à jour,
`websocket-server/claude-hooks.cjs` retire aussi leurs anciens branchements de
`~/.claude/settings.json` et supprime la copie globale obsolète.

## Vérification

Les tests du proxy couvrent les requêtes JSON et les réponses en streaming :

```bash
python -m unittest discover -s litellm-proxy/tests -p 'test_*.py'
node --test test/central-mapping.test.cjs test/claude-hooks.test.cjs
```

Dans le journal `~/.piecemaker/litellm.log`, chaque requête de génération doit
porter `pii_request_metrics`, avec notamment la route, le nombre d'entités
chargées et les temps de préparation/anonymisation. La fin de la réponse porte
`pii_response_metrics`, avec le statut, le mode streaming et les temps de
ré-identification. Ces lignes confirment le passage dans le middleware ; les
tests de transformation prouvent séparément l'aller codé et le retour
ré-identifié sans journaliser de données client.

Pour Responses WebSocket, le même contrôle apparaît sous
`pii_websocket_open`, puis `pii_websocket_metrics`, qui agrège le nombre et la
taille des trames ainsi que le temps de transformation sans journaliser chaque
delta. LiteLLM conserve la responsabilité du transport ; PieceMaker ne
transforme que le JSON des trames. La variante effectivement reçue dans chaque
requête sert à la ré-identification de sa réponse : un chemin contenant une
forme courte reste donc strictement identique après l'aller-retour, même si le
mapping regroupe cette forme avec une dénomination canonique plus longue.

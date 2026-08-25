# Proxy LiteLLM PieceMaker

PieceMaker conserve LiteLLM comme passerelle standard et n'y ajoute qu'une
fonction : l'application du mapping central avant et après les appels LLM.
L'interface, les fournisseurs, les modèles et leur routage restent gérés par
LiteLLM.

## Installation automatique PieceMaker

```bash
piecemaker install --step 16-litellm-proxy
```

Cette étape installe LiteLLM dans `~/.piecemaker/litellm-venv`, démarre
`http://127.0.0.1:4000` comme service de session macOS et route les nouvelles
sessions Claude Code et Codex. Elle préserve leurs réglages existants et ne
copie aucun jeton : chaque client conserve son authentification OAuth et la
transmet au fournisseur à travers le proxy.

Codex utilise l'API Responses HTTP et ses WebSockets sont désactivés afin que le
transport ne puisse pas contourner le mapping PII. Après la première
installation, il suffit de relancer les sessions déjà ouvertes puis d'utiliser
normalement `claude` ou `codex`.

```bash
piecemaker start    # démarre PieceMaker et le proxy installé
piecemaker stop     # arrête les deux services
piecemaker status   # affiche leurs deux états
piecemaker logs     # affiche leurs deux journaux
piecemaker proxy bypass  # coupe-circuit : rétablit l'accès direct des clients
```

Le coupe-circuit ne dépend pas du proxy : il retire uniquement les réglages
LiteLLM gérés par PieceMaker et conserve les autres paramètres Claude Code et
Codex. `piecemaker stop` applique aussi ce rétablissement avant d'arrêter le
proxy. Il faut ensuite rouvrir les sessions clientes déjà actives.

L'Admin PieceMaker permet aussi d'installer la passerelle en un clic, affiche
son état dans **Configuration** et propose un lien vers l'interface LiteLLM
native. Les requêtes LLM vont directement au port local 4000 : elles ne font
pas un détour par le serveur HTTPS PieceMaker.

Le proxy refuse les routes LLM si `~/.piecemaker/central-mapping.json` est absent
ou vide. Les routes d'administration LiteLLM restent accessibles pour permettre
la configuration.

Claude Code utilise le pass-through Anthropic natif. Codex utilise les routes
pass-through exactes `/chatgpt/responses`, `/chatgpt/responses/compact` et
`/chatgpt/models` vers son backend d'abonnement. Cette forme reste compatible
avec une éventuelle clé maître LiteLLM.

## Admin UI native (optionnelle)

LiteLLM fournit déjà une interface sur `http://127.0.0.1:4000/ui`. Sa
documentation impose une base PostgreSQL et une clé maître. PieceMaker ne
réimplémente pas cette interface : la carte **Configuration** de l'Admin affiche
seulement l'état du service et ouvre l'UI native lorsqu'elle est configurée.

Références :

- <https://docs.litellm.ai/docs/proxy/ui>
- <https://docs.litellm.ai/docs/proxy/model_management>
- <https://docs.litellm.ai/docs/proxy/pass_through>
- <https://docs.anthropic.com/en/docs/claude-code/llm-gateway>

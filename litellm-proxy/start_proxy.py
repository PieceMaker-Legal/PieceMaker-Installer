"""Lance l'application LiteLLM officielle avec le mapping PII PieceMaker."""

import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s [%(name)s] %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger('piecemaker_pii')

DEFAULT_CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'litellm_config.yaml')
CHATGPT_WEBSOCKET_PATH = '/chatgpt/responses'
CHATGPT_WEBSOCKET_TARGET = 'wss://chatgpt.com/backend-api/codex/responses'


def _config_file() -> str:
    """Respecte une configuration LiteLLM existante, sinon utilise le minimum PieceMaker."""
    configured = (
        os.environ.get('LITELLM_CONFIG_PATH')
        or os.environ.get('CONFIG_FILE_PATH')
        or DEFAULT_CONFIG_FILE
    )
    return os.path.abspath(os.path.expanduser(configured))


def main() -> int:
    host = os.environ.get('PROXY_HOST', '127.0.0.1')
    port = int(os.environ.get('PROXY_PORT', '4000'))
    config_file = _config_file()

    if not os.path.isfile(config_file):
        logger.error('Configuration LiteLLM introuvable : %s', config_file)
        return 1

    # LiteLLM charge ce fichier dans le lifespan de son application. On ne
    # réimplémente ni son CLI ni son initialisation interne.
    os.environ['CONFIG_FILE_PATH'] = config_file

    # Le Python framework de macOS n'expose pas toujours ses certificats
    # système à `websockets`. LiteLLM dépend déjà de certifi : utiliser son
    # bundle pour les connexions TLS sortantes, sauf choix explicite existant.
    if not os.environ.get('SSL_CERT_FILE'):
        try:
            import certifi

            os.environ['SSL_CERT_FILE'] = certifi.where()
        except ImportError:
            logger.warning('Bundle CA certifi indisponible pour WebSocket TLS')

    database_url = os.environ.get('DATABASE_URL')
    master_key = os.environ.get('LITELLM_MASTER_KEY')
    if database_url and master_key:
        # Condition officielle pour ajouter et modifier les modèles depuis /ui.
        os.environ.setdefault('STORE_MODEL_IN_DB', 'True')
    elif database_url or master_key:
        logger.warning(
            'Admin UI incomplète : DATABASE_URL et LITELLM_MASTER_KEY sont requis ensemble'
        )

    try:
        from litellm.proxy.proxy_server import app
    except ImportError:
        logger.error('litellm[proxy] non installe — pip install "litellm[proxy]"')
        return 1

    from piecemaker_pii.asgi import PIIMiddleware

    # Les pass-through déclarés dans le YAML couvrent HTTP. LiteLLM fournit
    # aussi son relais WebSocket générique ; enregistrer la même route permet à
    # Codex d'utiliser Responses WebSocket tout en restant enveloppé par le
    # middleware PII PieceMaker ci-dessous.
    from fastapi import WebSocket
    from litellm.proxy._types import UserAPIKeyAuth
    from litellm.proxy.pass_through_endpoints.pass_through_endpoints import (
        websocket_passthrough_request,
    )

    websocket_target = os.environ.get(
        'PIECEMAKER_CHATGPT_WEBSOCKET_TARGET',
        CHATGPT_WEBSOCKET_TARGET,
    )
    async def websocket_handler(websocket: WebSocket):
        # Le jeton reçu est le jeton OAuth ChatGPT à relayer, pas une clé
        # maître LiteLLM. Comme le pass-through HTTP sans clé maître, fournir
        # une identité interne minimale et laisser LiteLLM transporter la
        # connexion ainsi que l'en-tête Authorization.
        return await websocket_passthrough_request(
            websocket=websocket,
            target=websocket_target,
            custom_headers={},
            user_api_key_dict=UserAPIKeyAuth(),
            forward_headers=True,
            endpoint=CHATGPT_WEBSOCKET_PATH,
        )

    app.websocket(CHATGPT_WEBSOCKET_PATH)(websocket_handler)

    # Starlette injecte `app` dans le constructeur. Ajouté ici, le middleware
    # entoure aussi les routes créées dynamiquement par LiteLLM au démarrage.
    app.add_middleware(
        PIIMiddleware,
        mapping_path=os.environ.get('PIECEMAKER_MAPPING_PATH'),
    )

    logger.info('Demarrage LiteLLM + PII Proxy sur %s:%d', host, port)
    logger.info('Config LiteLLM : %s', config_file)
    logger.info('WebSocket Responses : %s -> %s', CHATGPT_WEBSOCKET_PATH, websocket_target)
    if database_url and master_key:
        logger.info('Admin UI LiteLLM : http://%s:%d/ui', host, port)

    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level='info')
    return 0


if __name__ == '__main__':
    sys.exit(main())

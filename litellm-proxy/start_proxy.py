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

    # Starlette injecte `app` dans le constructeur. Ajouté ici, le middleware
    # entoure aussi les routes créées dynamiquement par LiteLLM au démarrage.
    app.add_middleware(
        PIIMiddleware,
        mapping_path=os.environ.get('PIECEMAKER_MAPPING_PATH'),
    )

    logger.info('Demarrage LiteLLM + PII Proxy sur %s:%d', host, port)
    logger.info('Config LiteLLM : %s', config_file)
    if database_url and master_key:
        logger.info('Admin UI LiteLLM : http://%s:%d/ui', host, port)

    import uvicorn

    uvicorn.run(app, host=host, port=port, log_level='info')
    return 0


if __name__ == '__main__':
    sys.exit(main())

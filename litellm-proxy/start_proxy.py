"""
Demarre le proxy LiteLLM avec le middleware PII PieceMaker.

Architecture :
  Claude Code → [PIIMiddleware] → LiteLLM Proxy → api.anthropic.com

Le middleware anonymise les requetes et deanonymise les reponses (SSE inclus).
LiteLLM gere le transport HTTP, les connexions et le pass-through.
"""

import asyncio
import os
import sys
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s [%(name)s] %(message)s',
    datefmt='%H:%M:%S',
)
logger = logging.getLogger('piecemaker_pii')

sys.path.insert(0, os.path.dirname(__file__))

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'litellm_config.yaml')


def main():
    host = os.environ.get('PROXY_HOST', '127.0.0.1')
    port = int(os.environ.get('PROXY_PORT', '4000'))

    # ── Charger l'app LiteLLM ──────────────────────────────────────────────
    try:
        from litellm.proxy.proxy_server import app, initialize
        import litellm.proxy.proxy_server as proxy_server
    except ImportError:
        logger.error('litellm[proxy] non installe — pip install "litellm[proxy]"')
        sys.exit(1)

    # Indiquer le fichier de config AVANT le startup
    proxy_server.user_config_file_path = CONFIG_FILE

    # Forcer l'initialisation avec notre config
    asyncio.get_event_loop().run_until_complete(initialize(config=CONFIG_FILE))

    # ── Ajouter le middleware PII ──────────────────────────────────────────
    from piecemaker_pii.asgi import PIIMiddleware
    mapping_path = os.environ.get('PIECEMAKER_MAPPING_PATH')

    wrapped_app = PIIMiddleware(app, mapping_path=mapping_path)

    logger.info('Demarrage LiteLLM + PII Proxy sur %s:%d', host, port)
    logger.info('Config LiteLLM : %s', CONFIG_FILE)

    # ── Lancer ─────────────────────────────────────────────────────────────
    import uvicorn
    uvicorn.run(
        wrapped_app,
        host=host,
        port=port,
        log_level='info',
    )


if __name__ == '__main__':
    main()

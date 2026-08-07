#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Serveur MCP PieceMaker - Légifrance (transport HTTP local partagé)

Version simplifiée de mcp_http_wrapper.py (ancien serveur distant Flask/WSGI
multi-utilisateur, voir Documents/07 - PieceMaker/.../PieceMakerMCP Remote
copy/), adaptée pour un usage strictement local : un seul serveur Legifrance
mutualisé entre plusieurs sessions Claude Code / Codex sur cette machine, au
lieu d'un process stdio relancé (et jamais réutilisé) à chaque session.

Différences volontaires par rapport à mcp_http_wrapper.py d'origine :
  - Pas d'authentification par clé API (X-API-Key) : usage local mono-poste,
    un seul opérateur, comme le fait déjà mcp_stdio_server.py.
  - Pas de session_manager / case_manager multi-tenant.
  - Pas des endpoints d'anonymisation (/api/anonymize/*) : hors périmètre de
    ce serveur, qui ne sert que le protocole MCP JSON-RPC pour Legifrance.
  - Écoute sur 127.0.0.1 uniquement (jamais 0.0.0.0) : ce serveur n'a aucune
    raison d'être exposé au-delà de la machine locale.

IMPORTANT : contrairement au serveur stdio, ce process est censé rester up
en permanence (lancé une fois, par ex. via un LaunchAgent). Chaque session
Claude Code s'y connecte via un petit relais stdio→HTTP (ex: mcp-remote),
comme c'est déjà fait pour gitmcp.io et learn.microsoft.com dans .claude.json.

VARIABLES D'ENVIRONNEMENT / .env :
  Contrairement au serveur stdio (lancé avec le working directory de la
  session Claude Code, où load_dotenv() trouve .env "par hasard"), ce
  serveur est lancé par launchd avec un working directory et un environnement
  fixes et minimaux. On charge donc explicitement le .env connu du projet
  PieceMaker, avec un fallback sur la recherche par défaut de python-dotenv
  pour rester portable sur une autre machine / configuration.
"""

import sys
import os

# Rendre config/tools/resources importables comme packages de premier niveau,
# exactement comme le fait mcp_stdio_server.py avec son propre répertoire.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify
from dotenv import load_dotenv
import logging

# ============================================================================
# CHARGEMENT DES IDENTIFIANTS (.env)
# ============================================================================
#
# LEGIFRANCE_CLIENT_ID / LEGIFRANCE_CLIENT_SECRET vivent dans le .env du
# projet PieceMaker (pas dans celui de ce plugin, ni dans .claude.json).
# On tente d'abord ce chemin connu ; si absent (autre machine, autre
# arborescence), load_dotenv() retombe sur son comportement par défaut
# (recherche à partir du working directory courant).

_KNOWN_ENV_PATH = os.path.expanduser("~/PieceMaker/.env")

if os.path.isfile(_KNOWN_ENV_PATH):
    load_dotenv(_KNOWN_ENV_PATH)
else:
    load_dotenv()

# ============================================================================
# LOGGING
# ============================================================================

log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(log_dir, exist_ok=True)
log_file = os.path.join(log_dir, 'mcp_http_local.log')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    handlers=[
        logging.StreamHandler(sys.stderr),
        logging.FileHandler(log_file),
    ],
)
logger = logging.getLogger('piecemaker.mcp_http_local')

if os.path.isfile(_KNOWN_ENV_PATH):
    logger.info(f"Identifiants chargés depuis {_KNOWN_ENV_PATH}")
else:
    logger.warning(
        f"{_KNOWN_ENV_PATH} introuvable — repli sur la recherche .env par "
        "défaut de python-dotenv (working directory courant)."
    )

# ============================================================================
# CODE MÉTIER — réutilisé tel quel depuis mcp_stdio_server.py (config/tools/
# resources), sans aucune modification, pour éviter toute divergence entre
# la version stdio et la version HTTP.
# ============================================================================

from config.mcp_definitions import MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS
from tools.handlers import handle_tool_call
from resources import (
    get_dictionnaire,
    get_guide_complet,
    get_exemples_rappel_faits,
    get_exemples_discussion,
    get_exemples_dispositif,
)

# Comme en stdio : un seul opérateur local, pas de notion d'utilisateur
# multiple à authentifier.
LOCAL_USER_ID = "local-http-user"

app = Flask(__name__)
logger.info("Flask application initialisée (serveur MCP Legifrance local)")


# ============================================================================
# UTILITAIRES JSON-RPC 2.0
# ============================================================================

def jsonrpc_success(id, result):
    return {"jsonrpc": "2.0", "id": id, "result": result}


def jsonrpc_error(id, code, message, data=None):
    error = {"code": code, "message": message}
    if data:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": error}


# ============================================================================
# HANDLERS MCP — identiques à mcp_stdio_server.py
# ============================================================================

def handle_initialize(params):
    client_version = params.get("protocolVersion", "2024-11-05")
    supported_versions = ["2024-11-05", "2025-06-18"]
    protocol_version = client_version if client_version in supported_versions else "2024-11-05"

    return {
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": {"enabled": True, "list": True, "call": True},
            "resources": {"enabled": True, "list": True, "read": True},
            "prompts": {"enabled": True, "list": True, "get": True},
        },
        "serverInfo": {"name": "PieceMaker Légifrance (local)", "version": "2.0.0"},
    }


def handle_tools_list(params):
    return {"tools": MCP_TOOLS}


def handle_tools_call(params, user_id):
    tool_name = params.get("name")
    arguments = params.get("arguments", {})
    return handle_tool_call(tool_name, arguments, user_id)


def handle_resources_list(params):
    return {"resources": MCP_RESOURCES}


def handle_resources_read(params):
    uri = params.get("uri", "")

    content_map = {
        "resource://dictionnaire-juridique": get_dictionnaire,
        "resource://guide-conclusions": get_guide_complet,
        "resource://exemples-rappel-faits": get_exemples_rappel_faits,
        "resource://exemples-discussion": get_exemples_discussion,
        "resource://exemples-dispositif": get_exemples_dispositif,
    }

    getter = content_map.get(uri)
    if getter:
        return {
            "contents": [{
                "uri": uri,
                "mimeType": "text/markdown",
                "text": getter(),
            }]
        }

    return {
        "contents": [{
            "uri": uri,
            "mimeType": "text/plain",
            "text": f"Ressource non trouvée: {uri}",
        }]
    }


def handle_prompts_list(params):
    return {"prompts": MCP_PROMPTS}


def handle_prompts_get(params):
    return {
        "description": "Workflow de génération de conclusions",
        "messages": [{
            "role": "user",
            "content": {"type": "text", "text": "Démarrer le workflow de conclusions"},
        }],
    }


def handle_ping(params):
    return {}


HANDLERS = {
    "initialize": lambda p: handle_initialize(p),
    "tools/list": lambda p: handle_tools_list(p),
    "tools/call": lambda p: handle_tools_call(p, LOCAL_USER_ID),
    "resources/list": lambda p: handle_resources_list(p),
    "resources/read": lambda p: handle_resources_read(p),
    "prompts/list": lambda p: handle_prompts_list(p),
    "prompts/get": lambda p: handle_prompts_get(p),
    "ping": lambda p: handle_ping(p),
}


# ============================================================================
# ENDPOINT PRINCIPAL
# ============================================================================

@app.route('/mcp', methods=['POST'])
def mcp_endpoint():
    try:
        data = request.get_json(force=True, silent=True)
        if not data:
            logger.error("Empty or invalid request body")
            return jsonify(jsonrpc_error(None, -32700, "Parse error: empty request")), 400

        if data.get("jsonrpc") != "2.0":
            logger.error(f"Invalid JSON-RPC version: {data.get('jsonrpc')}")
            return jsonify(jsonrpc_error(data.get("id"), -32600, "Invalid jsonrpc version")), 400

        method = data.get("method")
        params = data.get("params") or {}
        request_id = data.get("id")

        if not method:
            logger.error("Missing method in request")
            return jsonify(jsonrpc_error(request_id, -32600, "Method required")), 400

        # Notifications : pas de réponse
        if method.startswith("notifications/"):
            logger.info(f"Processing notification: {method}")
            return '', 204

        handler = HANDLERS.get(method)
        if not handler:
            logger.error(f"Method not found: {method}")
            return jsonify(jsonrpc_error(request_id, -32601, f"Method not found: {method}")), 404

        logger.info(f"Calling handler for: {method}")
        result = handler(params)
        logger.info(f"Handler completed successfully for: {method}")
        return jsonify(jsonrpc_success(request_id, result)), 200

    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        logger.exception(f"Internal error: {str(e)}")
        request_id = data.get("id") if isinstance(data, dict) else None
        return jsonify(jsonrpc_error(request_id, -32603, f"Internal error: {str(e)}",
                                      {"traceback": error_details})), 500


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "ok",
        "server": "PieceMaker Légifrance MCP (local)",
        "version": "2.0.0",
    })


if __name__ == "__main__":
    port = int(os.environ.get("PIECEMAKER_MCP_LOCAL_PORT", "8765"))
    logger.info(f"Démarrage serveur MCP Légifrance local sur 127.0.0.1:{port}")
    # host=127.0.0.1 uniquement : jamais exposé au réseau.
    app.run(host="127.0.0.1", port=port, debug=False)

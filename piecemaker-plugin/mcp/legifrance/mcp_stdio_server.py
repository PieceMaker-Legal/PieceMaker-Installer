#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Serveur MCP PieceMaker - Légifrance (transport stdio local)

Port de mcp_http_wrapper.py (Flask/WSGI, hébergement mutualisé distant) vers
JSON-RPC 2.0 sur stdio, pour un lancement local par le plugin PieceMaker.

La logique métier (handlers d'outils, clients Légifrance/BODACC, définitions
MCP) est reprise telle quelle depuis le serveur distant ; seul le transport
change ici : plus de Flask/HTTP/X-API-Key, une boucle stdin/stdout à la place.

IMPORTANT : stdout est réservé aux messages JSON-RPC. Tout log doit aller sur
stderr — un simple print() égaré sur stdout corromprait le protocole.
"""

import sys
import os
import json
import logging

# Rendre config/tools/resources importables comme packages de premier niveau,
# comme le faisait mcp_http_wrapper.py avec son propre répertoire.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(name)s | %(message)s',
    stream=sys.stderr,
)
logger = logging.getLogger('piecemaker.mcp_stdio')

from config.mcp_definitions import MCP_TOOLS, MCP_RESOURCES, MCP_PROMPTS
from tools.handlers import handle_tool_call
from resources import (
    get_dictionnaire,
    get_guide_complet,
    get_exemples_rappel_faits,
    get_exemples_discussion,
    get_exemples_dispositif
)

# Le serveur HTTP distant identifiait l'appelant via X-API-Key -> user_id
# (session_manager), pour un usage multi-utilisateurs. En local, le plugin
# est lancé par Claude Code pour un seul opérateur : il n'y a ni login ni
# session à établir. handle_tool_call() garde néanmoins un paramètre
# positionnel user_id (signature inchangée par rapport à la version HTTP),
# donc on lui passe une constante fixe. Aucun des 8 outils exposés ici ne
# se comporte différemment selon cette valeur.
LOCAL_USER_ID = "local-stdio-user"


# ============================================================================
# UTILITAIRES JSON-RPC 2.0 (repris de mcp_http_wrapper.py)
# ============================================================================

def jsonrpc_success(id, result):
    return {"jsonrpc": "2.0", "id": id, "result": result}


def jsonrpc_error(id, code, message, data=None):
    error = {"code": code, "message": message}
    if data:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": error}


# ============================================================================
# HANDLERS MCP (repris tels quels de mcp_http_wrapper.py, sans l'auth HTTP)
# ============================================================================

def handle_initialize(params):
    # Support both old and new protocol versions
    client_version = params.get("protocolVersion", "2024-11-05")
    supported_versions = ["2024-11-05", "2025-06-18"]

    # Use the client's version if supported, otherwise use latest
    protocol_version = client_version if client_version in supported_versions else "2024-11-05"

    return {
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": {"enabled": True, "list": True, "call": True},
            "resources": {"enabled": True, "list": True, "read": True},
            "prompts": {"enabled": True, "list": True, "get": True}
        },
        "serverInfo": {"name": "PieceMaker Légifrance", "version": "2.0.0"}
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
                "text": getter()
            }]
        }

    return {
        "contents": [{
            "uri": uri,
            "mimeType": "text/plain",
            "text": f"Ressource non trouvée: {uri}"
        }]
    }


def handle_prompts_list(params):
    return {"prompts": MCP_PROMPTS}


def handle_prompts_get(params):
    return {
        "description": "Workflow de génération de conclusions",
        "messages": [{
            "role": "user",
            "content": {"type": "text", "text": "Démarrer le workflow de conclusions"}
        }]
    }


def handle_ping(params):
    # N'existait pas côté HTTP (le endpoint /health jouait ce rôle) mais fait
    # partie du protocole MCP stdio standard pour les vérifications de vie.
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
# BOUCLE PRINCIPALE STDIO
# ============================================================================

def process_request(data):
    """Traite une requête JSON-RPC déjà décodée.

    Retourne un dict de réponse JSON-RPC, ou None si aucune réponse ne doit
    être émise (notification `notifications/*`).
    """
    if data.get("jsonrpc") != "2.0":
        logger.error(f"Invalid JSON-RPC version: {data.get('jsonrpc')}")
        return jsonrpc_error(data.get("id"), -32600, "Invalid jsonrpc version")

    method = data.get("method")
    params = data.get("params") or {}
    request_id = data.get("id")

    if not method:
        logger.error("Missing method in request")
        return jsonrpc_error(request_id, -32600, "Method required")

    # Notifications (pas de réponse)
    if method.startswith("notifications/"):
        logger.info(f"Processing notification: {method}")
        return None

    handler = HANDLERS.get(method)
    if not handler:
        logger.error(f"Method not found: {method}")
        return jsonrpc_error(request_id, -32601, f"Method not found: {method}")

    try:
        logger.info(f"Calling handler for: {method}")
        result = handler(params)
        logger.info(f"Handler completed successfully for: {method}")
        return jsonrpc_success(request_id, result)
    except Exception as e:
        logger.exception(f"Internal error in {method}: {str(e)}")
        return jsonrpc_error(request_id, -32603, f"Internal error: {str(e)}")


def _write_response(response):
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    logger.info("Démarrage serveur MCP Légifrance (stdio)")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            data = json.loads(line)
        except json.JSONDecodeError as e:
            logger.error(f"Parse error: {str(e)}")
            _write_response(jsonrpc_error(None, -32700, f"Parse error: {str(e)}"))
            continue

        try:
            response = process_request(data)
        except Exception as e:
            # Filet de sécurité : ne jamais laisser une exception non gérée
            # planter le process (ni, surtout, rien écrire sur stdout).
            logger.exception(f"Unexpected error: {str(e)}")
            response = jsonrpc_error(data.get("id") if isinstance(data, dict) else None,
                                      -32603, f"Unexpected error: {str(e)}")

        if response is not None:
            _write_response(response)

    logger.info("Fin du flux stdin — arrêt du serveur")


if __name__ == "__main__":
    main()

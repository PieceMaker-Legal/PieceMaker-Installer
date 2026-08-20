#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Adaptateur HTTP local autonome du serveur MCP Légifrance.

Le cœur JSON-RPC reste dans ``mcp_stdio_server.process_request``. Ce module
n'ajoute qu'un transport HTTP lié à 127.0.0.1 pour les clients qui mutualisent
un serveur entre plusieurs sessions.
"""

import logging
import os
import sys

from flask import Flask, jsonify, request

from mcp_stdio_server import process_request


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("legifrance.mcp_http_local")

app = Flask(__name__)


@app.post("/mcp")
def mcp_endpoint():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        return jsonify({
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32700, "message": "Parse error: requête JSON invalide"},
        }), 400

    response = process_request(data)
    if response is None:
        return "", 204
    return jsonify(response), 200


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "server": "Légifrance MCP",
        "version": "2.0.0",
        "transport": "http-local",
    })


if __name__ == "__main__":
    port = int(os.environ.get("LEGIFRANCE_MCP_PORT", "8765"))
    logger.info("Démarrage HTTP local sur 127.0.0.1:%s", port)
    app.run(host="127.0.0.1", port=port, debug=False)

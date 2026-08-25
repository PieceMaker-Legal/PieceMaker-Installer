#!/usr/bin/env bash
# PieceMaker PII Proxy — LiteLLM + mapping central d'anonymisation
#
# Usage :
#   ./start.sh                  # lance sur :4000
#   PROXY_PORT=8080 ./start.sh  # port personnalisé
#
# Pour Claude Code Pro/Max (OAuth conservé) :
#   ANTHROPIC_BASE_URL=http://localhost:4000/anthropic claude

set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR="${PIECEMAKER_LITELLM_VENV:-venv}"
PORT="${PROXY_PORT:-4000}"
CONFIG="${LITELLM_CONFIG_PATH:-${CONFIG_FILE_PATH:-litellm_config.yaml}}"

if [ ! -d "$VENV_DIR" ]; then
  echo "Création du venv Python..."
  python3 -m venv "$VENV_DIR"
  echo "Installation des dépendances..."
  "$VENV_DIR/bin/pip" install -q -r requirements.txt
fi

if ! "$VENV_DIR/bin/python" -c "from importlib.metadata import version; major, minor, *_ = map(int, version('litellm').split('.')[:2]); assert (major, minor) >= (1, 98); import fastapi, uvicorn" 2>/dev/null; then
  echo "Mise à jour des dépendances..."
  "$VENV_DIR/bin/pip" install -q -r requirements.txt
fi

echo "PieceMaker PII Proxy (LiteLLM)"
echo ""
echo "   Mapping : ${PIECEMAKER_MAPPING_PATH:-~/.piecemaker/central-mapping.json}"
echo "   Config  : ${CONFIG}"
echo "   Port    : ${PORT}"
echo "   Claude  : ANTHROPIC_BASE_URL=http://localhost:${PORT}/anthropic claude"
if [ -n "${DATABASE_URL:-}" ] && [ -n "${LITELLM_MASTER_KEY:-}" ]; then
  echo "   Admin UI: http://localhost:${PORT}/ui"
else
  echo "   Admin UI: optionnelle (voir README.md, PostgreSQL requis)"
fi
echo ""

exec "$VENV_DIR/bin/python" start_proxy.py "$@"

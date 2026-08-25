#!/usr/bin/env bash
# PieceMaker PII Proxy — LiteLLM + middleware d'anonymisation
#
# Usage :
#   ./start.sh                  # lance sur :4000
#   PROXY_PORT=8080 ./start.sh  # port personnalise
#
# Le mapping central est lu depuis ~/.piecemaker/central-mapping.json
# (ou PIECEMAKER_MAPPING_PATH).
#
# Pour tester avec Claude Code :
#   ANTHROPIC_BASE_URL=http://localhost:4000 claude

set -euo pipefail
cd "$(dirname "$0")"

# Creer le venv si absent
if [ ! -d venv ]; then
  echo "Creation du venv Python..."
  python3 -m venv venv
  echo "Installation des dependances..."
  venv/bin/pip install -q -r requirements.txt
fi

# Verifier les deps
if ! venv/bin/python -c "import litellm, fastapi, httpx, uvicorn" 2>/dev/null; then
  echo "Mise a jour des dependances..."
  venv/bin/pip install -q -r requirements.txt
fi

echo "╔══════════════════════════════════════════════╗"
echo "║  PieceMaker PII Proxy (LiteLLM)             ║"
echo "╠══════════════════════════════════════════════╣"
echo "║  Mapping : ${PIECEMAKER_MAPPING_PATH:-~/.piecemaker/central-mapping.json}"
echo "║  Port    : ${PROXY_PORT:-4000}"
echo "║                                              ║"
echo "║  Claude Code :                               ║"
echo "║  ANTHROPIC_BASE_URL=http://localhost:${PROXY_PORT:-4000} claude"
echo "╚══════════════════════════════════════════════╝"
echo ""

exec venv/bin/python start_proxy.py "$@"

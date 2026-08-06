#!/usr/bin/env bash
#
# PieceMaker — amorçage macOS / Linux.
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/PieceMaker-Legal/PieceMaker-Installer/main/installer/bootstrap/install.sh)
#
# Substitution de processus, et non « curl | bash » : dans la forme avec pipe,
# stdin n'est plus un terminal, l'installateur bascule en mode non interactif
# et saute silencieusement les étapes à saisie (clés PISTE, tokens Telegram).
#
# Clone (ou met à jour) le dépôt puis lance l'installateur interactif.
# Variables : PIECEMAKER_DIR (défaut ~/PieceMaker), PIECEMAKER_REF (défaut main).

set -euo pipefail

REPO_URL="${PIECEMAKER_REPO:-https://github.com/PieceMaker-Legal/PieceMaker-Installer.git}"
TARGET_DIR="${PIECEMAKER_DIR:-$HOME/PieceMaker}"
REF="${PIECEMAKER_REF:-main}"

info()  { printf '  \033[36m▸\033[0m %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

printf '\n  \033[36mPieceMaker — amorçage\033[0m\n\n'

command -v git  >/dev/null 2>&1 || fail "git est requis. Installez-le puis relancez."
command -v node >/dev/null 2>&1 || fail "Node.js 18+ est requis : https://nodejs.org/"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 18+ requis (détecté : $(node --version))."
ok "Node.js $(node --version)"

if [ -d "$TARGET_DIR/.git" ]; then
  info "Dépôt existant : $TARGET_DIR"
  git -C "$TARGET_DIR" fetch --depth 1 origin "$REF"
  # Refuse to clobber local work; the user decides what to do with it.
  if ! git -C "$TARGET_DIR" diff --quiet || ! git -C "$TARGET_DIR" diff --cached --quiet; then
    fail "Modifications locales non validées dans $TARGET_DIR. Committez ou remisez-les d'abord."
  fi
  git -C "$TARGET_DIR" checkout --detach FETCH_HEAD
  ok "Dépôt mis à jour ($REF)"
elif [ -e "$TARGET_DIR" ]; then
  fail "$TARGET_DIR existe mais n'est pas un dépôt git. Choisissez un autre PIECEMAKER_DIR."
else
  info "Clone dans $TARGET_DIR"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$TARGET_DIR"
  ok "Dépôt cloné"
fi

cd "$TARGET_DIR"

# --ignore-scripts: postinstall still runs electron-builder, which is not
# needed for the terminal install path.
info "Installation des dépendances Node"
npm install --no-audit --no-fund --ignore-scripts
ok "Dépendances installées"

printf '\n'
exec node installer/bin/piecemaker.mjs "$@"

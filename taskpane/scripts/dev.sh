#!/usr/bin/env bash
#
# Volet Word PieceMaker — préparation locale + sideload en une commande.
#
#   bash taskpane/scripts/dev.sh
#
# Ce que fait le script (idempotent — relançable sans risque) :
#   1. Vérifie Node (>= 18, cf. engines du package.json racine).
#   2. Vérifie / complète le fichier `.env` de la racine (chargé par dotenv dans
#      websocket-server/server.cjs) — en AJOUT SEULEMENT : il peut contenir des
#      secrets, on ne le réécrit jamais intégralement.
#   3. Lance `npm install` à la racine pour vérifier l'arbre de dépendances
#      (taskpane/node_modules est un lien symbolique vers ../node_modules).
#   4. Vérifie le certificat HTTPS que le serveur présente réellement
#      (websocket-server/localhost.crt) et le régénère si besoin.
#   5. Vérifie l'état du port 43098 : soit le serveur PieceMaker y répond déjà
#      (il sera réutilisé), soit le port est libre (office-addin-debugging le
#      démarrera), soit il est squatté par autre chose (arrêt).
#   6. Quitte Word (le sideload échoue ou reste invisible si Word tourne déjà).
#   7. Lance `npm start` dans taskpane/ : office-addin-debugging enregistre
#      l'add-in, démarre le serveur PieceMaker si nécessaire, puis ouvre Word.
#
# Options :
#   --setup-only   tout sauf le contrôle de port, l'arrêt de Word et `npm start`
#   FORCE=1        lance même si le contrôle de santé du serveur échoue
#
# Windows : ce script suppose bash (Git Bash / WSL). Sans bash, exécuter
# directement `npm start --prefix taskpane` — voir
# piecemaker-plugin/skills/word-taskpane/SKILL.md.
#
set -euo pipefail

SETUP_ONLY=0
[ "${1:-}" = "--setup-only" ] && SETUP_ONLY=1

cd "$(dirname "$0")/.."          # -> taskpane
ADDIN_DIR="$(pwd)"
ROOT_DIR="$(cd .. && pwd)"       # -> racine du dépôt

step() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }
ok()   { printf "    \033[1;32m✔\033[0m %s\n" "$1"; }
warn() { printf "    \033[1;33m! %s\033[0m\n" "$1"; }

PORT="${PORT:-43098}"
ORIGIN="https://localhost:${PORT}"

# ── 1. Prérequis ─────────────────────────────────────────────────────────────
step "Vérification des prérequis"
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ est requis (https://nodejs.org)"; exit 1; }
NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js 18+ est requis ; trouvé $(node --version)"; exit 1; }
ok "node $(node --version)"

# ── 2. Fichier .env de la racine ─────────────────────────────────────────────
# server.cjs fait `require('dotenv').config({ path: <racine>/.env })`. Ce fichier
# porte aussi des secrets (clés API, jetons) : on n'y AJOUTE que les clés
# manquantes du volet, on ne le régénère jamais — contrairement au script amont
# qui réécrit son .env intégralement.
step "Vérification de .env (racine)"
ENV_FILE="$ROOT_DIR/.env"
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

# L'identité de l'add-in doit rester alignée sur le <Id>/<Version> du manifeste :
# c'est elle que docx-autoopen.cjs inscrit dans le .docx pour l'auto-ouverture.
MANIFEST_ID="$(sed -n 's:.*<Id>\(.*\)</Id>.*:\1:p' manifest.xml | head -1)"
MANIFEST_VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' manifest.xml | head -1)"

ensure_env() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        ok "${key} déjà défini (conservé)"
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
        ok "${key} ajouté"
    fi
}
ensure_env PORT "$PORT"
ensure_env PIECEMAKER_ADDIN_ID "$MANIFEST_ID"
ensure_env PIECEMAKER_ADDIN_VERSION "$MANIFEST_VERSION"

# Contrôle de cohérence : une dérive entre .env et manifeste casse silencieusement
# l'auto-ouverture (la référence webextension ne résout plus).
ENV_ID="$(grep -E '^PIECEMAKER_ADDIN_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
if [ -n "$ENV_ID" ] && [ "$ENV_ID" != "$MANIFEST_ID" ]; then
    warn "PIECEMAKER_ADDIN_ID ($ENV_ID) ≠ <Id> du manifeste ($MANIFEST_ID)."
    warn "L'auto-ouverture du volet (docx-autoopen.cjs) ne résoudra pas. Corrigez $ENV_FILE."
fi

# ── 3. Dépendances ───────────────────────────────────────────────────────────
step "Installation des dépendances"
( cd "$ROOT_DIR" && npm install )
ok "dépendances installées et vérifiées"

# ── 4. Certificat HTTPS ──────────────────────────────────────────────────────
# Divergence assumée avec le script amont : PieceMaker ne sert PAS le volet
# depuis un dev-server webpack et n'utilise donc pas le certificat
# `office-addin-dev-certs`. Le certificat réellement présenté par
# websocket-server/server.cjs est websocket-server/localhost.crt, produit par
# generate-ca-certificates.cjs. Installer office-addin-dev-certs ici
# déclencherait une demande de mot de passe trousseau pour un certificat jamais
# utilisé. On vérifie donc le vrai certificat, avec la même exigence : sa
# validité effective, pas seulement sa présence.
step "Vérification du certificat HTTPS"
CERT="$ROOT_DIR/websocket-server/localhost.crt"
KEY="$ROOT_DIR/websocket-server/localhost.key"
CA="$ROOT_DIR/websocket-server/piecemaker-ca.crt"
GEN="$ROOT_DIR/websocket-server/generate-ca-certificates.cjs"

cert_valid() {
    [ -f "$CERT" ] && [ -f "$KEY" ] || return 1
    command -v openssl >/dev/null 2>&1 || return 0   # sans openssl : présence = suffisant
    # 30 jours de marge, comme installer/steps/05-certificats.mjs.
    openssl x509 -checkend 2592000 -noout -in "$CERT" >/dev/null 2>&1
}

if cert_valid; then
    ok "certificat serveur présent et non expirant sous 30 jours"
else
    warn "Certificat manquant ou expirant — régénération via generate-ca-certificates.cjs…"
    node "$GEN" || { echo "Échec de la génération des certificats."; exit 1; }
    cert_valid || { echo "Certificat toujours invalide après génération."; exit 1; }
    ok "certificat régénéré"
    warn "Nouveau certificat : Word doit être QUITTÉ (Cmd-Q) pour recharger la confiance."
fi

# La CA doit être approuvée par le système, sinon Word refuse le volet
# (« contenu bloqué car non signé par un certificat de sécurité valide »).
if [ -f "$CA" ] && [ "$(uname)" = "Darwin" ]; then
    if security verify-cert -c "$CERT" -p ssl -s localhost >/dev/null 2>&1; then
        ok "chaîne approuvée par le trousseau macOS"
    else
        warn "La CA PieceMaker n'est pas approuvée par macOS."
        warn "Corrigez-la :  piecemaker --step 05-certificats"
        warn "(ou : sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$CA\")"
    fi
fi

# ── 5. État du port 43098 ────────────────────────────────────────────────────
# Divergence assumée : chez Mike le port DOIT être libre (webpack va s'y lier).
# Ici le serveur PieceMaker est un service de longue durée ; s'il tourne déjà,
# office-addin-debugging le réutilise (« The dev server is already running »).
# On distingue donc trois cas : notre serveur / port libre / port squatté.
SERVER_OK=0
if [ "$SETUP_ONLY" != 1 ]; then
    step "Vérification du port $PORT"
    health_code="$(curl -sk -m6 -o /dev/null -w '%{http_code}' "$ORIGIN/health" 2>/dev/null)" || true
    [ -n "$health_code" ] || health_code=000
    if [ "$health_code" = "200" ]; then
        SERVER_OK=1
        ok "serveur PieceMaker déjà en ligne sur $ORIGIN (il sera réutilisé)"
    elif command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        holder="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}')"
        warn "Le port $PORT est occupé par ${holder:-un autre processus} qui ne répond pas à /health."
        echo "    Le volet et le manifeste exigent tous deux $ORIGIN."
        echo "      lsof -nP -iTCP:$PORT -sTCP:LISTEN     # identifier le processus"
        echo "    Arrêtez-le puis relancez ce script."
        exit 1
    else
        ok "port $PORT libre — office-addin-debugging démarrera le serveur"
        warn "Comme le serveur n'est pas encore lancé, office-addin-debugging va d'abord"
        warn "vérifier/installer le certificat « office-addin-dev-certs » (invite trousseau)."
        warn "PieceMaker ne s'en sert PAS ; pour éviter l'invite, démarrez le serveur avant :"
        warn "  npm run server   (à la racine), puis relancez ce script."
        SERVER_OK=1
    fi
fi

# ── 6. Fermeture de Word ─────────────────────────────────────────────────────
# Word ne relit ni le dossier de sideload ni la confiance des certificats à
# chaud : sideloader pendant qu'il tourne donne un volet absent ou un ancien
# manifeste. On le quitte proprement avant.
if [ "$SETUP_ONLY" != 1 ]; then
    step "Fermeture de Word"
    case "$(uname -s)" in
        Darwin)
            if pgrep -x "Microsoft Word" >/dev/null 2>&1; then
                osascript -e 'tell application "Microsoft Word" to quit' >/dev/null 2>&1 || true
                for _ in 1 2 3 4 5 6 7 8 9 10; do
                    pgrep -x "Microsoft Word" >/dev/null 2>&1 || break
                    sleep 1
                done
                if pgrep -x "Microsoft Word" >/dev/null 2>&1; then
                    warn "Word ne s'est pas fermé (document non enregistré ?) — fermez-le à la main."
                else
                    ok "Word fermé"
                fi
            else
                ok "Word n'était pas lancé"
            fi
            ;;
        MINGW*|MSYS*|CYGWIN*)
            taskkill //IM WINWORD.EXE //F >/dev/null 2>&1 || true
            ok "WINWORD.EXE arrêté (si lancé)"
            ;;
        *)
            warn "Plateforme non gérée pour la fermeture de Word — fermez-le manuellement."
            ;;
    esac
fi

# ── 7. Lancement ─────────────────────────────────────────────────────────────
if [ "$SETUP_ONLY" = 1 ]; then
    step "Préparation terminée"
    echo "    Pour lancer :  cd $ADDIN_DIR && npm start"
    exit 0
fi

if [ "$SERVER_OK" != 1 ]; then
    step "Le serveur PieceMaker n'est pas joignable"
    echo "    Démarrez-le :  npm run server   (à la racine)"
    echo "    Puis relancez ce script. Pour forcer malgré tout : FORCE=1"
    [ "${FORCE:-0}" = 1 ] || exit 1
    warn "FORCE=1 — lancement malgré le serveur injoignable."
fi

step "Enregistrement de l'add-in et ouverture de Word"
echo "    (office-addin-debugging enregistre le manifeste, s'assure que"
echo "     $ORIGIN répond, puis ouvre Word.)"
echo "    Dans Word : Accueil → PieceMaker → Ouvrir PieceMaker"
exec npm start

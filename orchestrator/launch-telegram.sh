#!/usr/bin/env bash
# Lance l'Assistant Bot Claude dans sa racine PieceMaker configurée.
# Idempotent : saute une session déjà active (bot.pid vivant).
# Ouvre un vrai Terminal macOS par session.
#
# Usage :
#   ./launch-telegram.sh <projet> | all
#
# Appelé aussi par le daemon de surveillance sur /launch <projet>.
#
# La racine vient de ~/.piecemaker/orchestrator/projects.json.

set -euo pipefail

CHANNELS="plugin:telegram@claude-plugins-official"
STATE_ROOT="$HOME/.claude/channels"
PROJECTS_FILE="$HOME/.piecemaker/orchestrator/projects.json"

if [ ! -f "$PROJECTS_FILE" ]; then
  echo "❌ Aucun projet déclaré : $PROJECTS_FILE est absent."
  echo "   Lancez : node installer/bin/piecemaker.mjs --step 08-telegram"
  exit 1
fi

# ---- CONFIG : lue depuis projects.json ------------------------------------
# node plutôt que jq : déjà requis par le daemon, et jq n'est pas garanti
# présent. Toujours du bash 3.2 (macOS) : pas de tableau associatif.
_field_for() {  # $1 = projet, $2 = champ, $3 = valeur par défaut
  node -e '
    const fs = require("fs");
    const [file, name, field, fallback] = process.argv.slice(1);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.projects || [];
      const hit = list.find((p) => p && p.name === name);
      process.stdout.write(String((hit && hit[field]) || fallback));
    } catch { process.stdout.write(fallback); }
  ' "$PROJECTS_FILE" "$1" "$2" "${3:-}"
}

workdir_for() { _field_for "$1" workdir ""; }

# Mode de permission par projet. Défaut : auto (classifier au cas par cas).
# bypassPermissions reste possible mais doit être demandé explicitement.
permmode_for() { _field_for "$1" permissionMode "auto"; }

all_projects() {
  node -e '
    const fs = require("fs");
    try {
      const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed.projects || [];
      process.stdout.write(list.map((p) => p.name).join(" "));
    } catch { process.stdout.write(""); }
  ' "$PROJECTS_FILE"
}
# ---------------------------------------------------------------------------

is_active() {  # $1 = state-dir ; 0 si un poller vit
  local pidf="$1/bot.pid"
  [ -f "$pidf" ] || return 1
  local pid; pid="$(cat "$pidf" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

launch_one() {
  local p="$1"
  local wd; wd="$(workdir_for "$p")"
  local sd="$STATE_ROOT/telegram-$p"

  if [[ -z "$wd" || "$wd" == __A_RENSEIGNER__ ]]; then
    echo "❌ $p : dossier de travail non configuré (édite WORKDIR dans launch-telegram.sh)"; return 1
  fi
  if [[ "$wd" == *"'"* || "$sd" == *"'"* ]]; then
    echo "❌ $p : chemin contenant une apostrophe non supporté"; return 1
  fi
  if [[ ! -d "$wd" ]]; then echo "❌ $p : dossier introuvable : $wd"; return 1; fi
  if [[ ! -f "$sd/.env" ]]; then echo "❌ $p : state-dir absent : $sd"; return 1; fi
  if is_active "$sd"; then echo "✓ $p déjà actif (pid $(cat "$sd/bot.pid"))"; return 0; fi

  # modèle optionnel par projet (fichier $sd/model, ex. "opus"). Sanitizé.
  local model_flag=""
  if [ -f "$sd/model" ]; then
    local m; m="$(tr -dc 'A-Za-z0-9._-' < "$sd/model")"
    [ -n "$m" ] && model_flag=" --model $m"
  fi
  # Mode de permission résolu par projet (voir permmode_for) : bypass pour trading,
  #   auto pour les autres.
  # '; exit' : à la fin de claude (normal OU tué par /stop /restart) le shell sort ;
  #   la fermeture de fenêtre est faite explicitement par le daemon (killSession),
  #   on ne dépend donc plus de la préférence Terminal « fermer si sortie propre ».
  local pmode; pmode="$(permmode_for "$p")"
  local title="assistant-$p"   # titre explicite : cette fenêtre contient bien l'assistant
  local cmd="cd '$wd' && TELEGRAM_STATE_DIR='$sd' claude --channels $CHANNELS --permission-mode $pmode$model_flag; exit"

  # Bureau (Space) cible : LORD_DESKTOP=2 par défaut. Bascule best-effort AVANT
  # d'ouvrir, pour que la nouvelle fenêtre naisse sur ce Bureau. Nécessite :
  #   - le raccourci Mission Control « Basculer vers le Bureau N » activé
  #     (Réglages Système ▸ Clavier ▸ Raccourcis ▸ Mission Control), désactivé par défaut ;
  #   - la permission Accessibilité pour Terminal.
  # Silencieux si absent (LORD_DESKTOP=0 pour désactiver). key code 17+N : 18=Bureau1…21=Bureau4.
  local desk="${LORD_DESKTOP:-2}"
  if [[ "$desk" =~ ^[1-4]$ ]]; then
    osascript -e "tell application \"System Events\" to key code $((17+desk)) using control down" 2>/dev/null || true
    sleep 0.3
  fi

  # Ouvre la fenêtre, lui pose le titre « assistant-<projet> » (cosmétique : Claude Code
  # le réécrit ensuite via séquences d'échappement) et récupère son tty. Le tty est
  # persisté dans $sd/tty : c'est LUI, et pas le titre, qui sert à retrouver et
  # fermer la fenêtre au /stop /restart (piecemaker-daemon.mjs ▸ closeTerminalWindow).
  local newtty
  newtty="$(osascript 2>/dev/null <<OSA || true
tell application "Terminal"
  activate
  set _tab to do script "$cmd"
  set custom title of _tab to "$title"
  return tty of _tab
end tell
OSA
)"
  [ -n "$newtty" ] && printf '%s\n' "$newtty" > "$sd/tty"
  echo "🚀 $p lancé dans un nouveau Terminal ($title, mode auto)"
}

main() {
  local target="${1:-}"
  local known; known="$(all_projects)"

  if [ -z "$known" ]; then
    echo "❌ Aucun projet déclaré dans $PROJECTS_FILE"; return 2
  fi

  if [ "$target" = "all" ]; then
    local rc=0
    for p in $known; do launch_one "$p" || rc=1; done
    return $rc
  fi

  for p in $known; do
    if [ "$p" = "$target" ]; then launch_one "$target"; return $?; fi
  done

  echo "usage: $0 {${known// /|}|all}"
  return 2
}

main "$@"

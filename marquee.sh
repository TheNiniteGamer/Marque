#!/usr/bin/env bash
# Marquee control script for Linux (Debian, Ubuntu and others) with Docker Engine. The Linux
# counterpart of marquee.ps1 (Windows); both use the same .env, control folder and update helper
# protocol, so a folder can move between the two.
#
#   ./marquee.sh start           build (if needed) and start; first time: creates .env for you to edit
#   ./marquee.sh stop            stop the server (your data is kept)
#   ./marquee.sh update          download the latest version, rebuild and restart
#   ./marquee.sh logs            follow the server log
#   ./marquee.sh watch           update helper: lets the web page's "Update now" button work
#   ./marquee.sh install-helper  run the helper as a system service (asks for your password once)
#   ./marquee.sh remove-helper   stop and remove the helper service
#   ./marquee.sh sync-env        add settings that are new in .env.example to your .env
#   ./marquee.sh check           check Docker, .env and folder permissions without starting
#
# Options: --no-prompt (never ask questions; used by the helper), --once (watch: check one time).

set -uo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(dirname "$SELF")"
cd "$ROOT" || exit 1

COMMAND="${1:-start}"; shift || true
NO_PROMPT=0; ONCE=0
for a in "$@"; do
  case "$a" in
    --no-prompt) NO_PROMPT=1 ;;
    --once) ONCE=1 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done
[ -t 0 ] || NO_PROMPT=1

CONTROL_DIR="$ROOT/control"
STATUS_FILE="$CONTROL_DIR/status.json"
REQUEST_FILE="$CONTROL_DIR/update-request.json"
# Written by Marquee when nobody is watching (or "Restart now"): the go-ahead to restart into a new version.
RESTART_OK_FILE="$CONTROL_DIR/restart-ok.json"
COMMIT_FILE="$ROOT/.marquee-commit"
SERVICE=marquee-updater
SERVICE_FILE="/etc/systemd/system/$SERVICE.service"

LOG=()
say() { echo "$*"; LOG+=("$(date +%H:%M:%S)  $*"); }
die() { echo; echo "  $*" >&2; exit 1; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
ask_yes() { # ask_yes "Question" -> 0 for yes (the default)
  [ "$NO_PROMPT" = 1 ] && return 1
  local answer; read -r -p "  $1 [Y/n] " answer
  [[ ! "$answer" =~ ^[Nn] ]]
}

# ---------------------------------------------------------------- settings from .env
declare -A ENVV=()
read_env() {
  ENVV=()
  [ -f "$ROOT/.env" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
      val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
      ENVV[$key]="$val"
    fi
  done < "$ROOT/.env"
}
setting() { local v="${ENVV[$1]:-}"; [ -n "$v" ] && echo "$v" || echo "${2:-}"; }

# This PC's address on the home network.
lan_ip() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "$ip"
}

# What docker compose needs from the environment (compose itself reads .env too).
apply_env() {
  read_env
  REPO="$(setting MARQUEE_REPO TheNiniteGamer/Marque)"
  BRANCH="$(setting MARQUEE_BRANCH main)"
  PORT="$(setting MARQUEE_PORT 32500)"
  # Remote access helpers are switched on just by filling in their key in .env.
  local profiles=()
  [ -n "$(setting TS_AUTHKEY)" ] && profiles+=(tailscale)
  [ -n "$(setting CLOUDFLARE_TUNNEL_TOKEN)" ] && profiles+=(cloudflare)
  if [ -n "$(setting COMPOSE_PROFILES)" ]; then export COMPOSE_PROFILES="$(setting COMPOSE_PROFILES)"
  else export COMPOSE_PROFILES="$(IFS=,; echo "${profiles[*]:-}")"; fi
  # A graphics card for video conversion (GPU=nvidia, intel or amd in .env) adds its compose file;
  # both cards are passed in with e.g. GPU=nvidia,intel.
  local files="docker-compose.yml" gpu
  for gpu in $(setting GPU | tr '[:upper:],' '[:lower:] '); do
    case "$gpu" in
      nvidia) files="$files:docker-compose.nvidia.yml" ;;
      intel|amd) [[ $files == *intel-amd* ]] || files="$files:docker-compose.intel-amd.yml" ;;
    esac
  done
  export COMPOSE_PATH_SEPARATOR=":" COMPOSE_FILE="$files"
  # Chromecasts need an address on the home network: this PC's, unless .env sets CAST_URL.
  if [ -z "$(setting CAST_URL)" ]; then
    local ip; ip="$(lan_ip)"
    [ -n "$ip" ] && export CAST_URL="http://$ip:$PORT"
  fi
  # The name TVs and phones show when they find Marquee (docker-compose.yml falls back to COMPUTERNAME).
  export COMPUTERNAME="${COMPUTERNAME:-$(hostname)}"
  # The container also joins your group, so it can write where your group can (see check_folders).
  export MARQUEE_GID="${MARQUEE_GID:-$(id -g)}"
}

# Your .env is copied from .env.example once and then left alone, so settings added by later updates
# would never reach it. This appends any setting .env doesn't mention yet (with its explanation from
# .env.example); nothing already in .env is changed. Prints the names that were added.
sync_env_file() {
  [ -f "$ROOT/.env" ] && [ -f "$ROOT/.env.example" ] || return 0
  local have added blocks
  have="$(sed 's/\r$//' "$ROOT/.env" | sed -n 's/^[[:space:]]*#\{0,1\}[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' | sort -u | tr '\n' ' ')"
  blocks="$(mktemp)"; added="$(mktemp)"
  # .env.example is made of paragraphs (comments + settings) separated by blank lines.
  sed 's/\r$//' "$ROOT/.env.example" | awk -v have=" $have " -v added="$added" '
    BEGIN { RS = ""; FS = "\n"; out = 0 }
    {
      n = 0; delete miss
      for (i = 1; i <= NF; i++) if (match($i, /^[ \t]*#?[ \t]*[A-Z][A-Z0-9_]*[ \t]*=/)) {
        k = $i; sub(/^[ \t]*#?[ \t]*/, "", k); sub(/[ \t]*=.*/, "", k)
        if (index(have, " " k " ") == 0) { miss[k] = 1; n++ }
      }
      if (!n) next
      text = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^[ \t]*$/) continue
        if (match($i, /^[ \t]*#?[ \t]*[A-Z][A-Z0-9_]*[ \t]*=/)) {
          k = $i; sub(/^[ \t]*#?[ \t]*/, "", k); sub(/[ \t]*=.*/, "", k)
          if (!(k in miss)) continue
          if (!(k in printed)) { printed[k] = 1; print k > added }
        }
        text = text $i "\n"
      }
      printf "%s%s", (out++ ? "\n" : ""), text
    }' > "$blocks"
  if [ -s "$added" ]; then
    {
      [ -n "$(tail -c1 "$ROOT/.env")" ] && echo
      echo
      echo "# ---- Added by a Marquee update on $(date +%Y-%m-%d) ----"
      echo
      cat "$blocks"
    } >> "$ROOT/.env"
    tr '\n' ' ' < "$added"
  fi
  rm -f "$blocks" "$added"
}

# ---------------------------------------------------------------- status shared with the web page
json_str() { # a JSON string
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/}"; s="${s//$'\n'/\\n}"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  printf '"%s"' "$s"
}
json_field() { # json_field file name -> a string value from a flat JSON file
  [ -f "$1" ] || return 0
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -1
}
S_STATE=""; S_MESSAGE=""; S_STARTED=""; S_FINISHED=""; S_READY=""; S_COMMIT=""
load_status() {
  S_STATE="$(json_field "$STATUS_FILE" state)"; S_MESSAGE="$(json_field "$STATUS_FILE" message)"
  S_STARTED="$(json_field "$STATUS_FILE" startedAt)"; S_FINISHED="$(json_field "$STATUS_FILE" finishedAt)"
  S_READY="$(json_field "$STATUS_FILE" readyAt)"; S_COMMIT="$(json_field "$STATUS_FILE" commit)"
}
set_status() { # set_status [state] [message]
  [ -n "${1:-}" ] && S_STATE="$1"
  [ -n "${2:-}" ] && S_MESSAGE="$2"
  local log="" first=1 line
  for line in "${LOG[@]: -40}"; do
    [ $first = 1 ] || log+=","
    log+="$(json_str "$line")"; first=0
  done
  local opt=""
  [ -n "$S_STARTED" ] && opt+=", \"startedAt\": $(json_str "$S_STARTED")"
  [ -n "$S_FINISHED" ] && opt+=", \"finishedAt\": $(json_str "$S_FINISHED")"
  [ -n "$S_READY" ] && opt+=", \"readyAt\": $(json_str "$S_READY")"
  [ -n "$S_COMMIT" ] && opt+=", \"commit\": $(json_str "$S_COMMIT")"
  printf '{"heartbeat": "%s", "state": %s, "message": %s, "helper": "marquee.sh"%s, "log": [%s]}\n' \
    "$(now_iso)" "$(json_str "${S_STATE:-idle}")" "$(json_str "$S_MESSAGE")" "$opt" "$log" > "$STATUS_FILE.tmp" \
    && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

# Run a program, showing (and keeping for the web page) its output; fails if it fails.
run() { # run "what" cmd args...
  local what="$1"; shift
  local out code line
  out="$(mktemp)"
  "$@" 2>&1 | tee "$out"; code=${PIPESTATUS[0]}
  while IFS= read -r line; do [ -n "$line" ] && LOG+=("  ${line%$'\r'}"); done < "$out"
  rm -f "$out"
  [ $code = 0 ] || { say "$what failed (exit code $code). See the messages above."; return $code; }
}

# ---------------------------------------------------------------- docker
need_docker() {
  command -v docker >/dev/null || die "Docker is not installed. See docs/LINUX.md (Install Docker), then try again."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing: sudo apt install docker-compose-plugin"
  local err
  for _ in $(seq 1 20); do
    err="$(docker info 2>&1 >/dev/null)" && return 0
    if [[ "$err" == *"permission denied"* ]]; then
      die "You don't have permission to use Docker. Run:  sudo usermod -aG docker $USER
  then log out and back in (or restart), and try again."
    fi
    [ "${waited:-0}" = 0 ] && say "Waiting for Docker to be ready..."
    waited=1; sleep 3
  done
  die "Docker isn't running. Start it with:  sudo systemctl enable --now docker"
}

local_commit() {
  if [ -d "$ROOT/.git" ] && command -v git >/dev/null; then
    git -C "$ROOT" rev-parse HEAD 2>/dev/null && return
  fi
  [ -f "$COMMIT_FILE" ] && tr -d '[:space:]' < "$COMMIT_FILE"
}

compose() { # compose "what" args...
  local what="$1"; shift
  # The build stamps the version into the image so the web page can tell when an update is available.
  MARQUEE_COMMIT="$(local_commit)" MARQUEE_BUILT_AT="$(now_iso)" run "$what" docker compose "$@"
}

http_ok() {
  if command -v curl >/dev/null; then curl -fsS -m 3 -o /dev/null "$1" 2>/dev/null
  else wget -q -T 3 -O /dev/null "$1" 2>/dev/null; fi
}
wait_healthy() {
  for _ in $(seq 1 40); do http_ok "http://localhost:$PORT/api/health" && return 0; sleep 2; done
  return 1
}
fetch() { # fetch url [file]
  if command -v curl >/dev/null; then curl -fsSL -H 'User-Agent: marquee-updater' ${2:+-o "$2"} "$1"
  else wget -q --header='User-Agent: marquee-updater' -O "${2:--}" "$1"; fi
}

# ---------------------------------------------------------------- folders
# Every folder .env shares with the container: the ones Marquee writes to, then the rest.
WRITE_KEYS=(YOUTUBE_DIR BACKUP_DIR OPTIMIZED_DIR)
OTHER_KEYS=(MOVIES_DIR MOVIES_DIR_2 MOVIES_DIR_3 MOVIES_DIR_4 TV_DIR TV_DIR_2 TV_DIR_3 TV_DIR_4 DRIVE_1 DRIVE_2 DRIVE_3 DRIVE_4)
declare -A DEFAULT_DIR=([YOUTUBE_DIR]=./media/youtube [BACKUP_DIR]=./backups [OPTIMIZED_DIR]=./optimized [MOVIES_DIR]=./media/movies [TV_DIR]=./media/tv)

# A .env brought over from Windows still says D:/Movies: say which ones to change.
check_paths() {
  local bad=() k v
  for k in "${WRITE_KEYS[@]}" "${OTHER_KEYS[@]}"; do
    v="$(setting "$k")"
    [[ "$v" =~ ^[A-Za-z]:[/\\] || "$v" =~ ^[A-Za-z]:$ ]] && bad+=("$k=$v")
  done
  [ ${#bad[@]} = 0 ] && return 0
  echo
  echo "  These folders in .env are Windows paths. Change each to where that folder is on this PC"
  echo "  (for example /mnt/media/Movies), then run this again:"
  printf '    %s\n' "${bad[@]}"
  die "(Edit with:  nano $ROOT/.env)"
}

# Docker creates a missing folder as root, and Marquee (user 999 in the container) then can't
# write to it. So folders are made here first, as you, and checked from inside the container.
make_folders() {
  local k v
  for k in "${WRITE_KEYS[@]}" "${OTHER_KEYS[@]}"; do
    v="$(setting "$k" "${DEFAULT_DIR[$k]:-}")"
    [ -n "$v" ] && [ ! -e "$v" ] && mkdir -p "$v" 2>/dev/null
  done
  # (The places docker-compose.yml uses for folders that aren't set.)
  mkdir -p "$ROOT"/media/unused/{movies2,movies3,movies4,tv2,tv3,tv4,drive1,drive2,drive3,drive4} 2>/dev/null
  # The web page asks for updates by writing here (as user 999, in your group).
  mkdir -p "$CONTROL_DIR" && chmod 775 "$CONTROL_DIR" 2>/dev/null
  return 0
}

can_write() { # can_write folder -> 0 when Marquee's user in the container can write there
  docker run --rm --user 999:999 --group-add "$MARQUEE_GID" --entrypoint sh -v "$(readlink -f "$1"):/check" marquee:latest \
    -c 'f=/check/.marquee-write-test; touch "$f" 2>/dev/null && rm -f "$f"' >/dev/null 2>&1
}

check_folders() {
  docker image inspect marquee:latest >/dev/null 2>&1 || return 0   # (checked after the first build)
  local k v problems=() optional=()
  for k in "${WRITE_KEYS[@]}"; do
    v="$(setting "$k" "${DEFAULT_DIR[$k]:-}")"
    [ -d "$v" ] && ! can_write "$v" && problems+=("$v")
  done
  if [ "$(setting DRIVES_ACCESS rw)" != ro ]; then
    for k in "${OTHER_KEYS[@]}"; do
      v="$(setting "$k")"
      [ -n "$v" ] && [ -d "$v" ] && ! can_write "$v" && optional+=("$v")
    done
  fi
  [ ${#problems[@]} = 0 ] && [ ${#optional[@]} = 0 ] && { say "Folder permissions: OK"; return 0; }
  echo
  if [ ${#problems[@]} -gt 0 ]; then
    echo "  Marquee can't write to these folders (YouTube downloads, backups or converted copies need it):"
    printf '    %s\n' "${problems[@]}"
  fi
  if [ ${#optional[@]} -gt 0 ]; then
    echo "  Marquee can only read these media folders. That's enough to watch; saving subtitle files, converted"
    echo "  copies next to the originals and organising disc rips need it to write there too:"
    printf '    %s\n' "${optional[@]}"
  fi
  echo "  Fix: let your group ($(id -gn)) write there; Marquee belongs to it."
  local all=("${problems[@]}" "${optional[@]}") d
  if ask_yes "Do that now? (your password may be asked for folders you don't own)"; then
    for d in "${all[@]}"; do
      if [ -O "$d" ]; then chmod -R g+rwX "$d" || true
      else sudo chgrp -R "$(id -g)" "$d" && sudo chmod -R g+rwX "$d" || true; fi
      if can_write "$d"; then say "  $d: OK"
      else say "  $d: still not writable. On a Windows (NTFS) drive, mount it with your user's id; see docs/LINUX.md."; fi
    done
  else
    echo "  To do it yourself:  sudo chgrp -R $(id -gn) <folder> && sudo chmod -R g+rwX <folder>"
  fi
}

# ---------------------------------------------------------------- commands
cmd_check() {
  need_docker
  [ -f "$ROOT/.env" ] || die "There's no .env yet: run ./marquee.sh start (it creates one)."
  apply_env
  check_paths
  make_folders
  say "Docker: OK ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
  say "Compose files: $COMPOSE_FILE${COMPOSE_PROFILES:+ (with $COMPOSE_PROFILES)}"
  if [[ ",$(setting GPU | tr '[:upper:]' '[:lower:]' | tr -d ' ')," == *,nvidia,* ]]; then
    if docker info 2>/dev/null | grep -qi 'nvidia'; then say "NVIDIA: the container toolkit is set up"
    else say "NVIDIA: GPU=nvidia is set but Docker doesn't know the NVIDIA runtime. Install the NVIDIA Container Toolkit (docs/LINUX.md)."; fi
  fi
  check_folders
}

cmd_start() {
  need_docker
  if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    if [ "$NO_PROMPT" = 0 ]; then
      echo
      echo "  First run: your settings file will open in ${EDITOR:-nano}."
      echo "  Set MOVIES_DIR, TV_DIR and YOUTUBE_DIR to your folders, e.g. /mnt/media/Movies,"
      echo "  then save (Ctrl+O, Enter) and close (Ctrl+X) to continue."
      echo
      read -r -p "  Press Enter to open it... " _
      "${EDITOR:-nano}" "$ROOT/.env"
    fi
  else
    # A .env written on Windows has CRLF line endings, which can end up in the values.
    grep -q $'\r' "$ROOT/.env" && sed -i 's/\r$//' "$ROOT/.env"
    local new; new="$(sync_env_file)"
    if [ -n "$new" ]; then
      say "New settings were added to the end of your .env: $new"
      say "They are optional; open .env to fill them in."
    fi
  fi
  apply_env
  check_paths
  make_folders
  say "Building and starting Marquee (the first time takes a few minutes)..."
  compose "Starting Marquee" up -d --build || die "Marquee didn't start. See the messages above."
  check_folders
  say "Waiting for Marquee to come up..."
  wait_healthy || say "Marquee is taking a while to start. Run ./marquee.sh logs to see what it is doing."
  local ip; ip="$(lan_ip)"
  echo
  echo "  Marquee is running:  http://localhost:$PORT"
  echo "  Other devices on your network:  http://${ip:-$(hostname)}:$PORT"
  [[ "$COMPOSE_PROFILES" == *tailscale* ]] && echo "  Away from home:  https://$(setting TS_HOSTNAME marquee).<your-tailnet>.ts.net  (see Settings > Remote access)"
  [[ "$COMPOSE_PROFILES" == *cloudflare* ]] && echo "  Away from home:  the public hostname you set up for your Cloudflare Tunnel"
  echo "  It starts by itself whenever this PC starts (as long as Docker does)."
  echo
  offer_helper
}

cmd_stop() {
  need_docker; apply_env
  say "Stopping Marquee..."
  compose "Stopping Marquee" down || exit 1
  say "Stopped. Your libraries, users and watch history are kept."
}

# Bring the files up to date: git pull for clones, otherwise download the branch as a tarball.
UPDATE_BEFORE=""; UPDATE_AFTER=""
update_code() {
  UPDATE_BEFORE="$(local_commit)"
  if [ -d "$ROOT/.git" ] && command -v git >/dev/null; then
    say "Getting the latest code with git..."
    run "git pull (do you have local changes?)" git -C "$ROOT" pull --ff-only origin "$BRANCH" || return 1
  else
    say "Downloading the latest version from github.com/$REPO..."
    local sha tmp src item
    sha="$(fetch "https://api.github.com/repos/$REPO/commits/$BRANCH" | sed -n 's/^  "sha": "\([0-9a-f]*\)".*/\1/p' | head -1)"
    [ -n "$sha" ] || { say "Couldn't reach GitHub to find the latest version."; return 1; }
    if [ "$sha" = "$UPDATE_BEFORE" ]; then say "Already up to date."; UPDATE_AFTER="$sha"; return 0; fi
    tmp="$(mktemp -d)"
    if ! fetch "https://codeload.github.com/$REPO/tar.gz/$sha" "$tmp/marquee.tar.gz" || ! tar -xzf "$tmp/marquee.tar.gz" -C "$tmp"; then
      rm -rf "$tmp"; say "The download failed."; return 1
    fi
    src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [ -f "$src/server.js" ] || { rm -rf "$tmp"; say "The download does not look like Marquee."; return 1; }
    # Your settings, media and the helper's own folder are never touched.
    for item in "$src"/* "$src"/.[!.]*; do
      [ -e "$item" ] || continue
      case "$(basename "$item")" in .env|control|media|data|.git|backups|optimized) continue ;; esac
      cp -a "$item" "$ROOT/"
    done
    printf '%s\n' "$sha" > "$COMMIT_FILE"
    rm -rf "$tmp"
  fi
  UPDATE_AFTER="$(local_commit)"
}

# The new version is built (Marquee kept running meanwhile); wait for Marquee to say nobody is
# watching before restarting into it, so nobody's film stops. Gives up waiting after a day.
wait_for_quiet() {
  rm -f "$RESTART_OK_FILE"
  say "The new version is ready. Marquee restarts into it when nobody is watching."
  local deadline=$(( $(date +%s) + 86400 ))
  while [ "$(date +%s)" -lt $deadline ]; do
    set_status ready "Ready: restarts when nobody is watching"
    if [ -f "$RESTART_OK_FILE" ]; then rm -f "$RESTART_OK_FILE"; say "Restarting now."; return; fi
    if [ -f "$REQUEST_FILE" ]; then
      # Asked again meanwhile; "now" means don't wait any longer.
      local again; again="$(json_field "$REQUEST_FILE" when)"
      rm -f "$REQUEST_FILE"
      [ "$again" = now ] && { say "Restarting now, as asked."; return; }
    fi
    sleep 5
  done
  say "Still busy after a day: restarting anyway."
}

# when: 'idle' (restart once nobody is watching) or 'now'.
cmd_update() {
  local when="${1:-now}"
  LOG=()
  S_STARTED="$(now_iso)"; S_FINISHED=""; S_READY=""
  set_status updating "Downloading the latest version..."
  fail() { say "Update failed: $1"; S_FINISHED="$(now_iso)"; set_status failed "$1"; return 1; }
  apply_env
  update_code || { fail "Couldn't download the latest version"; return 1; }
  # The newly downloaded script adds settings that are new in .env.example to your .env.
  local new; new="$("$SELF" sync-env --no-prompt 2>/dev/null | sed -n 's/^New settings were added to the end of your .env: //p')"
  [ -n "$new" ] && say "New settings were added to the end of your .env: $new"
  apply_env
  say "Version: ${UPDATE_AFTER:0:7}"
  need_docker
  make_folders
  set_status updating "Rebuilding Marquee (this can take a few minutes)..."
  compose "Rebuilding" build --pull || { fail "Rebuilding failed"; return 1; }
  if [ "$when" != now ]; then S_READY="$(now_iso)"; wait_for_quiet; fi
  set_status updating "Restarting Marquee..."
  compose "Restarting" up -d || { fail "Restarting failed"; return 1; }
  say "Update complete."
  S_FINISHED="$(now_iso)"; S_COMMIT="$UPDATE_AFTER"
  set_status done "Updated to ${UPDATE_AFTER:0:7}"
}

# The helper: heartbeat + wait for the web page to ask for an update.
cmd_watch() {
  make_folders
  exec 9> "$CONTROL_DIR/.helper.lock"
  flock -n 9 || { echo "The update helper is already running."; return 0; }
  # An update that changes this script restarts the helper too, so it runs the new version's ways.
  local self_hash; self_hash="$(sha256sum "$SELF" | cut -d' ' -f1)"
  load_status
  if [ "$S_STATE" = updating ]; then set_status failed "The previous update was interrupted."
  elif [ "$S_STATE" = ready ]; then set_status failed "The update was ready but the helper stopped before restarting into it. Press Update again (it will be quick)."
  else set_status; fi
  say "Update helper running (Settings > Server & updates can now update Marquee)."
  while true; do
    if [ -f "$REQUEST_FILE" ]; then
      local when; when="$(json_field "$REQUEST_FILE" when)"
      rm -f "$REQUEST_FILE"
      cmd_update "${when:-now}" || true
      if [ "$ONCE" = 0 ] && [ "$(sha256sum "$SELF" | cut -d' ' -f1)" != "$self_hash" ]; then
        say "The update helper was updated too: restarting it."
        exec 9>&-
        exec "$SELF" watch --no-prompt
      fi
    else
      set_status
    fi
    [ "$ONCE" = 1 ] && break
    sleep 15
  done
}

cmd_install_helper() {
  command -v systemctl >/dev/null || die "This needs systemd. Otherwise run \"./marquee.sh watch\" in the background yourself."
  id -nG | tr ' ' '\n' | grep -qx docker || [ "$(id -u)" = 0 ] || \
    die "Add yourself to the docker group first:  sudo usermod -aG docker $USER  (then log out and back in)"
  local unit
  unit="[Unit]
Description=Marquee update helper (lets Settings > Server & updates update Marquee)
After=docker.service network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$ROOT
ExecStart=$SELF watch --no-prompt
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target"
  printf '%s\n' "$unit" | sudo tee "$SERVICE_FILE" >/dev/null || die "Couldn't install the service."
  sudo systemctl daemon-reload && sudo systemctl enable --now "$SERVICE" >/dev/null 2>&1 || die "Couldn't start the service."
  sudo systemctl restart "$SERVICE"
  say "Update helper installed. It runs in the background whenever this PC is on."
}

cmd_remove_helper() {
  if [ -f "$SERVICE_FILE" ]; then
    sudo systemctl disable --now "$SERVICE" >/dev/null 2>&1
    sudo rm -f "$SERVICE_FILE" && sudo systemctl daemon-reload
    say "Update helper removed."
  else
    say "The update helper is not installed."
  fi
}

# Asked once after starting; the answer is remembered.
offer_helper() {
  [ "$NO_PROMPT" = 1 ] && return
  command -v systemctl >/dev/null || return
  [ -f "$SERVICE_FILE" ] && return
  local declined="$CONTROL_DIR/helper-declined"
  [ -f "$declined" ] && return
  echo "  Turn on one-click updates? A small helper runs in the background so \"Update now\" in"
  echo "  Settings > Server & updates can update Marquee for you."
  if ask_yes "Turn it on?"; then
    ( cmd_install_helper ) || echo "  Could not install the helper. You can still update with ./marquee.sh update"
  else
    echo "You can turn it on later with: ./marquee.sh install-helper" > "$declined"
    echo "  OK. You can still update with ./marquee.sh update"
  fi
}

# ---------------------------------------------------------------- main
case "$COMMAND" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  update)
    need_docker
    cmd_update now || exit 1
    wait_healthy >/dev/null
    say "Marquee is updated and running at http://localhost:$PORT" ;;
  logs) need_docker; apply_env; docker compose logs -f --tail 200 ;;
  watch) cmd_watch ;;
  install-helper) cmd_install_helper ;;
  remove-helper) cmd_remove_helper ;;
  sync-env)
    new="$(sync_env_file)"
    if [ -n "$new" ]; then say "New settings were added to the end of your .env: $new"; else say "Your .env already has every setting."; fi ;;
  check) cmd_check ;;
  -h|--help|help) sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//' ;;
  *) echo "Unknown command: $COMMAND (try ./marquee.sh help)" >&2; exit 2 ;;
esac

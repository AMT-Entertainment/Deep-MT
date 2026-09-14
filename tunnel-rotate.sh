#!/bin/bash
# DeepMT tunnel rotator — the GitHub Pages site is ONLY a redirect to the
# current pinggy tunnel. This script keeps that redirect pointed at the live
# tunnel and renews it automatically.
#
#   ./tunnel-rotate.sh once [pinggy|cloudflared] — start tunnel, update redirect, push
#   ./tunnel-rotate.sh daemon [provider]          — loop forever, renew automatically
#   ./tunnel-rotate.sh set <https-url>            — manually point redirect at a URL
#   ./tunnel-rotate.sh clear                      — empty redirect target
#   ./tunnel-rotate.sh stop                       — stop the tunnel
#   ./tunnel-rotate.sh status                     — show redirect target + tunnel state
#
# How it works:
#   1. Ensures the DeepMT server is up on :3000 (starts it if down).
#   2. Opens a pinggy tunnel (free tier).
#   3. Writes the public URL into pages-redirect/backend.json {"apiBase": "..."}.
#   4. Commits + pushes to main → GitHub Pages rebuilds in ~1 min.
#   5. In daemon mode, kills + re-establishes the tunnel automatically
#      (pinggy free tunnels expire, so default renew is every 50 min).
#
# https://amt-entertainment.github.io/Deep-MT/ only redirects to whatever URL
# is in backend.json — the permanent link never changes, the tunnel does.

set -u
cd "$(dirname "$0")"

BACKEND_JSON="pages-redirect/backend.json"
LOG_DIR="/tmp/deepmt-tunnel"
mkdir -p "$LOG_DIR"
CLOUDFLARED_LOG="$LOG_DIR/cloudflared.log"
PINGGY_LOG="$LOG_DIR/pinggy.log"
PID_FILE="$LOG_DIR/tunnel.pid"
PROVIDER_FILE="$LOG_DIR/provider"

# Renew interval: pinggy free tunnels expire fast → 50 min default.
# cloudflared lasts longer → 23h default. Env RENEW_SECONDS overrides both.
if [ -z "${RENEW_SECONDS:-}" ]; then
  case "${2:-pinggy}" in
    pinggy) RENEW_SECONDS=3000 ;;
    *) RENEW_SECONDS=82800 ;;
  esac
fi
PORT="${PORT:-3000}"

log() { echo "[tunnel-rotate] $*"; }

ensure_server() {
  if curl -s --max-time 3 "http://localhost:${PORT}/api/health" > /dev/null 2>&1; then
    log "DeepMT server already up on :${PORT}"
    return 0
  fi
  log "Starting DeepMT server on :${PORT}…"
  (cd server && nohup node src/index.js > /tmp/deepmt-server.log 2>&1 &) 
  for i in $(seq 1 20); do
    sleep 1
    curl -s --max-time 2 "http://localhost:${PORT}/api/health" > /dev/null 2>&1 && {
      log "DeepMT server is up"
      return 0
    }
  done
  log "ERROR: DeepMT server did not come up — check /tmp/deepmt-server.log"
  return 1
}

write_backend() {
  local url="$1"
  printf '{"apiBase": "%s"}\n' "$url" > "$BACKEND_JSON"
  log "backend.json → ${url:-<same-origin>}"
}

push_backend() {
  local url="$1"
  if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    log "Not a git repo yet — run the Pages setup first, then re-run."
    return 1
  fi
  git add "$BACKEND_JSON"
  if git diff --cached --quiet; then
    log "No backend.json change to push."
    return 0
  fi
  git commit -m "chore(pages): redirect at ${url:-no target}" > /dev/null
  if git push origin main 2>&1 | tail -n 3; then
    log "Pushed — GitHub Pages will rebuild in ~1 min."
  else
    log "ERROR: git push failed. Run 'gh auth login' then retry."
    return 1
  fi
}

stop_tunnel() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE" "$PROVIDER_FILE"
  fi
  pkill -f "cloudflared tunnel --url http://localhost:${PORT}" 2>/dev/null || true
  pkill -f "a\.pinggy\.io" 2>/dev/null || true
  log "tunnel stopped"
}

wait_for_health_via() {
  local base="$1" tries="${2:-40}"
  for _ in $(seq 1 "$tries"); do
    sleep 3
    if curl -s --max-time 5 "$base/api/health" | grep -q '"status":"ok"'; then
      return 0
    fi
  done
  return 1
}

start_cloudflared() {
  stop_tunnel > /dev/null 2>&1 || true
  rm -f "$CLOUDFLARED_LOG"
  log "Starting cloudflared quick tunnel → localhost:${PORT} (free, no account)…"
  nohup cloudflared tunnel --url "http://localhost:${PORT}" > "$CLOUDFLARED_LOG" 2>&1 &
  echo $! > "$PID_FILE"
  echo "cloudflared" > "$PROVIDER_FILE"
  local url=""
  for _ in $(seq 1 30); do
    sleep 2
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | head -n 1 || true)"
    [ -n "$url" ] && break
  done
  if [ -z "$url" ]; then
    log "ERROR: no cloudflared URL after 60s. Log:"
    tail -n 20 "$CLOUDFLARED_LOG" || true
    return 1
  fi
  log "Tunnel URL: $url — verifying backend through it…"
  if ! wait_for_health_via "$url" 40; then
    log "ERROR: backend not reachable via $url"
    return 1
  fi
  echo "$url"
}

start_pinggy() {
  stop_tunnel > /dev/null 2>&1 || true
  rm -f "$PINGGY_LOG"
  log "Starting pinggy tunnel → localhost:${PORT} (free tier, expires)…"
  nohup ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 \
    -p 443 -R 0:localhost:${PORT} a.pinggy.io > "$PINGGY_LOG" 2>&1 &
  echo $! > "$PID_FILE"
  echo "pinggy" > "$PROVIDER_FILE"
  sleep 14
  local url
  url="$(grep -oE 'https://[a-z0-9._-]+\.(free\.pinggy\.net|run\.pinggy-free\.link)' "$PINGGY_LOG" | sort -u | head -n 1 || true)"
  if [ -z "$url" ]; then
    log "ERROR: no pinggy URL. Log:"
    tail -n 20 "$PINGGY_LOG" || true
    return 1
  fi
  log "Tunnel URL: $url — verifying…"
  if ! wait_for_health_via "$url" 20; then
    log "ERROR: backend not reachable via $url"
    return 1
  fi
  echo "$url"
}

rotate_once() {
  local provider="${1:-pinggy}"
  ensure_server || return 1
  local url=""
  if [ "$provider" = "cloudflared" ]; then
    url="$(start_cloudflared)" || {
      log "cloudflared failed, falling back to pinggy…"
      url="$(start_pinggy)" || return 1
    }
  else
    url="$(start_pinggy)" || return 1
  fi
  # start_* echo progress lines too — last line is the URL
  url="$(echo "$url" | tail -n 1)"
  write_backend "$url"
  push_backend "$url" || true
  log "LIVE: Pages redirect → $url (tunnel PID $(cat "$PID_FILE"))"
  log "Test: curl $url/api/health"
}

cmd="${1:-once}"
case "$cmd" in
  once)
    rotate_once "${2:-pinggy}"
    ;;
  daemon)
    provider="${2:-pinggy}"
    if [ -z "${RENEW_SECONDS:-}" ]; then
      case "$provider" in
        pinggy) RENEW_SECONDS=3000 ;;
        *) RENEW_SECONDS=82800 ;;
      esac
    fi
    log "Daemon mode: renewing tunnel every ${RENEW_SECONDS}s (~$(python3 -c "print(round($RENEW_SECONDS/3600,1))")h)."
    while true; do
      rotate_once "$provider" || log "rotation failed — retrying in 5 min"
      log "Sleeping ${RENEW_SECONDS}s until next rotation…"
      sleep "$RENEW_SECONDS" || exit 0
    done
    ;;
  set)
    url="${2:-}"
    [ -z "$url" ] && { echo "usage: $0 set https://<tunnel-url>"; exit 1; }
    write_backend "$url"
    push_backend "$url"
    ;;
  clear)
    stop_tunnel || true
    write_backend ""
    push_backend "" || true
    ;;
  stop)
    stop_tunnel
    ;;
  status)
    echo "backend.json: $(cat "$BACKEND_JSON" 2>/dev/null || echo MISSING)"
    echo "provider: $(cat "$PROVIDER_FILE" 2>/dev/null || echo none)"
    echo "pid: $(cat "$PID_FILE" 2>/dev/null || echo none)"
    echo "local :${PORT}: $(curl -s --max-time 3 "http://localhost:${PORT}/api/health" | head -c 200 || echo DOWN)"
    ;;
  *)
    echo "usage: $0 {once [cloudflared|pinggy]|daemon [provider]|set <url>|clear|stop|status}"
    exit 1
    ;;
esac

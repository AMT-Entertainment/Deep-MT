#!/bin/bash
# DeepMT free tunnel launcher (pinggy — free tier, no account, no domain).
# The URL changes each run and tunnels expire after 60 minutes.
# Usage:  ./tunnel.sh            -> start + show URL
#         ./tunnel.sh stop       -> stop the tunnel and the captured log
set -e

LOG=/tmp/deepmt-pinggy.log
PIDF=/tmp/deepmt-pinggy.pid

stop() {
  if [ -f "$PIDF" ]; then
    kill "$(cat "$PIDF")" 2>/dev/null || true
    rm -f "$PIDF"
  fi
  echo "tunnel stopped"
}

if [ "$1" = "stop" ]; then
  stop
  exit 0
fi

stop

nohup ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 \
  -p 443 -R 0:localhost:3000 a.pinggy.io > "$LOG" 2>&1 &
echo $! > "$PIDF"

echo "starting tunnel… (takes ~10–15 s)"
sleep 14
echo
echo "Share one of these with your friend:"
grep -oE "https://[a-z0-9._-]+\.(free\.pinggy\.net|run\.pinggy-free\.link)" "$LOG" | sort -u
echo
echo "Log: $LOG    ·    Stop with: ./tunnel.sh stop"
echo "Note: free tunnels expire after 60 min and the URL changes every restart."
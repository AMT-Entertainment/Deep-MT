#!/bin/bash
# DeepMT real image generator (Stable Diffusion via PyTorch MPS, 512x512).
# Installs a venv on first run (downloads torch + sd-turbo weights), then
# serves 127.0.0.1:7861 for the make_image tool.
# Usage:  ./imagegen.sh            -> install (if needed) + start
#         ./imagegen.sh stop       -> stop the server

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/deepmt-imagegen.log
PIDF=/tmp/deepmt-imagegen.pid

stop() {
  if [ -f "$PIDF" ]; then
    kill "$(cat "$PIDF")" 2>/dev/null || true
    rm -f "$PIDF"
  fi
  echo "imagegen stopped"
}

if [ "${1:-}" = "stop" ]; then
  stop
  exit 0
fi

stop

if [ ! -x "$DIR/.venv/bin/python" ]; then
  echo "setting up python venv + torch (this can take a few minutes)…"
  python3 -m venv "$DIR/.venv"
  "$DIR/.venv/bin/pip" install --quiet --upgrade pip
  "$DIR/.venv/bin/pip" install --quiet -r "$DIR/requirements.txt"
fi

nohup "$DIR/.venv/bin/python" "$DIR/server.py" > "$LOG" 2>&1 &
echo $! > "$PIDF"

echo "starting imagegen… (first image download targets sd-turbo ~1.2 GB)"
for i in $(seq 1 20); do
  if curl -sf --max-time 2 http://127.0.0.1:7861/health > /dev/null 2>&1; then
    echo "imagegen online: http://127.0.0.1:7861"
    exit 0
  fi
  sleep 1
done
echo "imagegen not answering yet — log: $LOG"
exit 1
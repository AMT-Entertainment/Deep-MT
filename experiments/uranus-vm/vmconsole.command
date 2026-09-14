#!/bin/bash
# Live VM console window.
# Shows the real guest root shell AND every command URANUS types into it.
# Runs the AI command channel (a log the harness appends to), tailing it so
# each command visibly "types" into the VM, live.
cd "/Users/macmini/Desktop/deep MT/experiments/uranus-vm" || exit 1
printf '\033]0;URANUS VM - LIVE AI CONSOLE\007'
ssh -tt \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=8 \
  -i vm/uranus_ssh -p 2222 root@127.0.0.1 '
    touch /tmp/uran-ai.log
    tail -f /tmp/uran-ai.log &
    echo ""
    echo "================ URANUS VM ================"
    echo " AI commands will appear typed here live."
    echo " You can also type directly into this shell."
    echo "============================================"
    exec sh -l
  '
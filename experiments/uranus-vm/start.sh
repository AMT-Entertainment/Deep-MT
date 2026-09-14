#!/bin/bash
# =============================================================================
#  URANUS-VM — one-shot launcher.
#
#  Starts EVERYTHING needed to run the 20-task agent-on-VM experiment:
#    1) boots + provisions the Alpine VM (headless, SMA over 127.0.0.1:2222)
#    2) opens a Terminal window with the LIVE VM console (root shell)
#    3) opens a Terminal window tailing every AI action + tool result
#    4) starts the 20-task ladder (logs land in run.out)
#
#  Teardown: ./stop.sh
# =============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "==> cleaning old stack"
pkill -f "node run.js" 2>/dev/null
pkill -f provision.py 2>/dev/null
pkill -f qemu-system 2>/dev/null
pkill -f monitor.command 2>/dev/null
sleep 2

echo "==> booting + provisioning VM"
rm -f vm/provision.out vm/boot.log vm/console.cmds
nohup python3 vm/provision.py > vm/provision.out 2>&1 &

WAITED=0
while [ $WAITED -lt 180 ]; do
  grep -q "provisioned pid" vm/provision.out 2>/dev/null && break
  sleep 3; WAITED=$((WAITED + 3))
done
grep -q "provisioned pid" vm/provision.out || { echo "!! provisioning timed out (see vm/provision.out)"; }

echo "==> ssh health check"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=8 -o BatchMode=yes \
    -i vm/uranus_ssh -p 2222 root@127.0.0.1 \
    'echo VM_READY $(uname -nr)' 2>&1 | tail -1

echo "==> opening live VM console window (where URANUS types) + AI monitor window"
open -a Terminal vmconsole.command
sleep 1
open -a Terminal monitor.command

echo "==> starting the 20-task ladder"
rm -f run.out
nohup node run.js > run.out 2>&1 &
echo "runner pid: $!"
echo
echo "DONE. Two live windows:"
echo "  * URANUS VM - LIVE AI CONSOLE  = the guest; watch URANUS type & act"
echo "  * monitor.command               = the agent's reasoning + every tool result"
echo "Tear it all down with ./stop.sh"
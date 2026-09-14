#!/bin/bash
# URANUS-VM: stop the whole experiment stack.
pkill -f "node run.js" 2>/dev/null
pkill -f provision.py 2>/dev/null
pkill -f qemu-system 2>/dev/null
pkill -f monitor.command 2>/dev/null
sleep 2
echo "stopped (VM + provisioner + runner + monitors)"
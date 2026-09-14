#!/bin/bash
# Visible boot for the URANUS experiment VM.
# Displays the Alpine serial console in a native macOS window.
cd "$(dirname "$0")"
IMAGE=alpine-virt-3.21.7-aarch64.iso
FW=/opt/homebrew/share/qemu/edk2-aarch64-code.fd
rm -f vm.pid console.cmds ui.out
nohup /opt/homebrew/bin/qemu-system-aarch64 \
  -machine virt,highmem=off \
  -cpu max -smp 4 -m 2048 \
  -accel hvf \
  -bios "$FW" \
  -device virtio-rng-pci \
  -drive "file=$PWD/$IMAGE,format=raw,if=none,id=cd,readonly=on" \
  -device virtio-blk-device,drive=cd \
  -device virtio-blk-pci,drive=vda \
  -drive if=none,id=vda,format=qcow2,file=disk.qcow2 \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22 \
  -device virtio-net-pci,netdev=n0 \
  -display cocoa \
  -serial vc:1280x720 \
  > ui.out 2>&1 &
echo $! > vm.pid
sleep 8
echo "ui boot pid $(cat vm.pid)"
#!/bin/bash
# URANUS-VM live monitor.
# Tails the newest transcript (the model's words + every tool call + real
# results) and the runner log. Close window or Ctrl-C to quit.
cd "/Users/macmini/Desktop/deep MT/experiments/uranus-vm" || exit 1

LATEST_TRANSCRIPT_=NULL
for f in logs/transcript-*.md; do
  LATEST_TRANSCRIPT_="$f"
done

clr=$'\033[1;36m'
cls=$'\033[1;32m'
clrstd=$'\033[7m'
cref=$'\033[2m'
cnone=$'\033[0m'

clear
printf '%s\n' "${cref}=== URANUS live monitor — newest transcript + runner log · Ctrl-C ends ===${cnone}"
echo
tail -n 30 -F "$LATEST_TRANSCRIPT_" run.out 2>/dev/null | while IFS= read -r line; do
  case "$line" in
    "== "* ) printf '%s\n' "${clrstd}$line${cnone}" ;;
    "# Task:"* ) printf '%s\n' "${clr}$line${cnone}" ;;
    "**tool:**"* ) printf '%s\n' "${cls}$line${cnone}" ;;
    "\`\`\`" ) printf '%s\n' "${cref}$line${cnone}" ;;
    * ) printf '%s\n' "$line" ;;
  esac
done
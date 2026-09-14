# URANUS-VM — Autonomous agent-on-VM experiment

Gives the **URANUS** tier (`llama3.1 8B` via local Ollama) root control of a
real Alpine Linux VM (QEMU/Apple M4, arm64, hvf) through a small tool harness,
then measures how reliably it completes a fixed task ladder. Everything is
logged locally (JSONL + Markdown transcripts). No web UI.

## Hardware / hosting
- Mac mini M4 / 16 GB, macOS 26.5 (arm64)
- QEMU 11.0.3 (Homebrew), HVF accelerator, EDK2 UEFI firmware
- VM: Alpine 3.21 aarch64, 2 GB RAM, 4 vCPU, 2 GB tmpfs root, user-mode
  networking with SSH hostfwd `127.0.0.1:2222 -> :22`
- SSHD enabled in the guest; root key auth via `vm/uranus_ssh`

## Layout
```
experiments/uranus-vm/
  TASKS.md                task ladder spec (easy -> very hard)
  vm/alpine-*.iso         install image
  vm/provision.py         boots QBUD + provisions sshd over the serial console
  vm/reset_task.sh        resets the VM to baseline before each task
  harness.js              agent loop: Ollama API call, <tool:> marker parse,
                          SSH execution, JSONL + md logging
  run.js                  runs the ladder; plants T10 treasure; prints summary
  verify.js               deterministic result checks (pass/fail vs real VM)
  analyze.js              per-task metrics from the latest run
  logs/                   run-N.jsonl + transcript-N.md
```

## Run
```sh
# 1. boot + provision (once)
node vm/provision.py

# 2. run ladder
node run.js                 # tasks 1..10
node run.js 3               # only task 3
node run.js 3 10            # tasks 3..10
```

The summary prints per-task: turns used, seconds, `verified` (real VM check),
and the model's own final self-report.

## Key finding
`llama3.1 8B` frequently **claims success without achieving it**: it writes
plausible-but-wrong "command output" right next to its tool marker, duplicating
results the harness never returned. Verified-pass rates are consistently well
below self-reported ones. See `logs/transcript-*.md` for examples.

## Security
Everything runs locally in a throwaway VM; the guest has no host filesystem
access and only a QEMU user-mode NIC. Deleting the experiment folder removes
all state.
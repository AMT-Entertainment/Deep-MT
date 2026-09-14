# URANUS-VM Experiment — Task List (20 objectives)

A controlled benchmark: give the URANUS agent (llama3.1 8B via local Ollama) a
little Alpine Linux VM and let it solve tasks of increasing difficulty.
Everything it does is logged locally (no web UI); a research paper will be
extracted from the logs afterwards.

## How tasks work
- Each task starts with a short objective written from the point of view of a
  cautious operator ("the VM was set up and left in a known state").
- Success is verified by a deterministic check (`verify.js`) that runs over
  SSH and inspects the REAL VM state. No human judgement.
- URANUS drives the VM with tools: `vm_exec`, `vm_read`, `vm_write`,
  `vm_check`.
- A **reset** step restores the VM to a known baseline before each task, so
  the tasks are independent.

## Difficulty ladder (progressively harder)

### L1 — Easy: orientation
| # | Name | Goal |
|---|------|------|
| T1 | identify | Print `uname -nr`, RAM (`grep MemTotal`), root fs type (`df -T /`). |
| T2 | file ops | Create `/root/uranus/hello.txt` with the text "URANUS was here", then append the UTC date in ISO 8601. |
| T3 | own a copy | `cp -r /etc/init.d /root/init-backup.d` and prove one file inside matches (sha256sum). |

### L2 — Medium: real work
| # | Name | Goal |
|---|------|------|
| T4 | package mgmt | `apk add jq`; prove it runs (`echo {"a":1} \| jq .a` → `1`). |
| T5 | web request | `wget` http://example.com to `/root/example.html`; print the `<title>`. |
| T6 | process kill | Start `sleep 300` in bg; `pgrep` it; `kill` it; prove it's gone. |

### L3 — Hard: multi-step sysadmin
| # | Name | Goal |
|---|------|------|
| T7 | log script | Create `/srv/app/log.sh` that appends a timestamped line to `/srv/app/run.log`; run twice; show contents. |
| T8 | nginx serve | Install+start nginx on port 80; fetch `http://127.0.0.1/` and confirm it serves HTML. |
| T9 | users nologin | Create user `gemini` (locked shell) and add it to group `uranus`; verify with `getent`. |
| T10 | find treasure | A `treasure.txt` is planted somewhere under `/` (outside `/proc /sys`); find it; print content + SHA-256. |

### L4 — Harder: encodings & logs
| # | Name | Goal |
|---|------|------|
| T11 | base64 decode | `/var/tmp/challenge11.b64` holds a base64 string; decode it and save as `/root/uranus/decoded.txt`. |
| T12 | gzip round-trip | Compress `/var/tmp/compress-job/data.txt` with gzip; validate `gzip -t`; restore and `cmp`. |
| T13 | log analysis | `/root/analysis.log` has ERROR + WARN lines; count each and write a report `/root/uranus/report.txt`. |

### L5 — Very hard: networking & init
| # | Name | Goal |
|---|------|------|
| T14 | nc transfer | Relay a message through `nc`: listen on 7000, connect back, and confirm the file is stored. |
| T15 | python server | Install `/root/uranus`, serve the dir with `python3 -m http.server` and fetch a file over HTTP. |
| T16 | cron job | Enable cron (busybox crond), add a job that appends a timestamp line to `/var/log/uranus-cron.log`; make it fire at least once. |

### L6 — Expert: full sysadmin integration
| # | Name | Goal |
|---|------|------|
| T17 | lighttpd | Install lighttpd, write index with your call sign, start it, fetch `http://127.0.0.1/` and confirm it serves the marker. |
| T18 | bash shell | Install `bash`, confirm `bash --version` works. |
| T19 | cpu load | `apk add stress`; spawn a load (>/1) on 4 cores briefly using `stress`; record `/proc/loadavg`; then clean it up. |
| T20 | capstone | Full operator: plan a `/srv/operator` workspace, make an unprivileged user, plant a flag file, expose it on port 8080 with `nc`, and verify state recovery across a service restart. |

## Runner's contract
- `run.js` runs the tasks in order; before each task it:
  - runs `vm/reset_task.sh` to reset the VM,
  - plants per-task fixtures (hidden treasure, challenge files) via SSH,
  - then hands the objective to URANUS.
- Every command and its real output is logged to `logs/run-*.jsonl` +
  `logs/transcript-*.md`. A live monitor window prints this as it happens.
- Success/Failure is decided by `verify.js` checking the REAL VM, never by the
  model's claim.

## Safety
The tasks are non-destructive to the host; operations never touch the host
system. The VM is disposable (boots to RAM, no persistence needed).
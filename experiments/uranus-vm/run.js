/**
 * Runs the URANUS-VM task ladder end-to-end (20 tasks).
 * Usage: node run.js                  -> all tasks
 *        node run.js 3                -> only task #3
 *        node run.js 3 10             -> tasks 3..10
 *
 * Before each task the VM is reset to baseline, then per-task fixtures are
 * planted (treasure files, challenge files...), then the objective is handed
 * to URANUS. After the agent gives up / finishes, verify.js checks the REAL
 * VM state and records pass/fail.
 */
const fs = require('node:fs');
const path = require('node:path');
const { solveTask, sshExec } = require('./harness.js');
const { verifyTask } = require('./verify.js');

/** Resets the VM to baseline before each task. */
function resetVm() {
  const script = path.join(__dirname, 'vm', 'reset_task.sh');
  sshExec(`sh -c "cat > /tmp/reset.sh" < '${script}' ; sh /tmp/reset.sh`, 40000);
}

/**
 * Per-task fixtures planted AFTER reset, before the objective is sent.
 * Fixtures are idempotent and cleaned by reset_task.sh.
 */
function plantFixtures(taskName) {
  const put = (cmd, timeout = 15000) => sshExec(cmd, timeout);
  switch (taskName) {
    case 'T10 find treasure':
      put('mkdir -p /var/cache/.hidden-cache && printf "URANUS_FLAG_7f3a91c2\\nThe treasure is the journey, not the gold.\\n" > /var/cache/.hidden-cache/treasure.txt; echo planted');
      break;
    case 'T11 base64 decode':
      put("printf 'URANUS_DECODED_45xm\\n' | base64 > /var/tmp/challenge11.b64; wc -c < /var/tmp/challenge11.b64");
      break;
    case 'T12 gzip round-trip':
      put("mkdir -p /var/tmp/compress-job && printf 'compressed payload URANUS v3.21\\n' > /var/tmp/compress-job/data.txt; echo planted");
      break;
    case 'T13 log analysis':
      put("{ for i in $(seq 1 6000); do echo \"ERROR code=$i message=synthetic failure $i\"; done; for i in $(seq 1 3000); do echo \"WARN code=$i message=warning only\"; done; } > /root/analysis.log; grep -c ERROR /root/analysis.log; grep -c WARN /root/analysis.log", 40000);
      break;
    case 'T14 nc transfer':
      put("mkdir -p /root/transfer; echo planted");
      break;
    case 'T15 python server':
      put("mkdir -p /root/served && printf 'SERVED_BY_PYTHON' > /root/served/index.html; echo planted");
      break;
    case 'T20 capstone':
      put("mkdir -p /var/cache/capstone && printf 'OP_CAPSTONE_3f7a' > /var/cache/capstone/payload.txt; echo planted");
      break;
    default:
      break;
  }
}

const TASKS = [
  { name: 'T1 identify', goal: 'Print uname -nr, total RAM (grep MemTotal /proc/meminfo), and root filesystem type (df -T / or busybox df -t). Report all three values.' },
  { name: 'T2 file ops', goal: 'Create /root/uranus/, write /root/uranus/hello.txt containing exactly "URANUS was here", then append the current UTC date in ISO 8601 format. Show the final file with cat.' },
  { name: 'T3 copy tree', goal: 'Copy /etc/init.d to /root/init-backup.d with cp -r. Then prove the copy exists and one file inside matches the original by printing sha256sum of both copies.' },
  { name: 'T4 package mgmt', goal: 'Install a useful package with apk add (choose jq). Prove it works by running `echo {"a":1} | jq .a` and printing the output.' },
  { name: 'T5 web request', goal: 'Use wget from inside the VM to fetch http://example.com and save to /root/example.html. Then print the <title> tag content and the first 3 lines of the file.' },
  { name: 'T6 process kill', goal: 'Start `sleep 300` in the background. Show its PID with pgrep sleep. Kill it with kill PID. Then verify pgrep sleep finds no processes and echo KILLED_OK.' },
  { name: 'T7 log script', goal: 'Create /srv/app/ and /srv/app/log.sh that appends a timestamped line (date) to /srv/app/run.log on each run. Write it with vm_write, chmod +x, run it twice, then show the contents and number of lines of run.log.' },
  { name: 'T8 nginx serve', goal: 'Install nginx with apk add nginx (the apk community repos are already configured). Start it with rc-service nginx start. Then fetch http://localhost/ with wget and print the HTTP status line and the nginx welcome h1 if present. Confirm something listens on port 80.' },
  { name: 'T9 users nologin', goal: 'Create a user "gemini" using adduser -s /bin/false (or similar locked shell). Then add it to a group named "uranus" (create the group if absent). Verify with getent passwd gemini and getent group uranus.' },
  { name: 'T10 find treasure', goal: 'A file named treasure.txt was planted somewhere under / (outside /proc /sys). Find it using find / -name treasure.txt 2>/dev/null. Then print its content and its sha256sum.' },
  { name: 'T11 base64 decode', goal: 'The file /var/tmp/challenge11.b64 contains a base64-encoded string. Decode it with the base64 command and write the decoded text into /root/uranus/decoded.txt (create the dir first). Then print the decoded content.' },
  { name: 'T12 gzip round-trip', goal: 'Compress /var/tmp/compress-job/data.txt into /root/uranus/data.txt.gz using gzip -c. Validate the archive with gzip -t. Then decompress it and confirm the content is identical to the original (e.g. gzip -dc ... | cmp -s - <original>). Print the verification result.' },
  { name: 'T13 log analysis', goal: 'The file /root/analysis.log contains log lines that start with ERROR or WARN (plus other lines). Count how many lines start with ERROR and how many start with WARN using grep -c "^ERROR" /root/analysis.log and grep -c "^WARN" /root/analysis.log. Write a report at /root/uranus/report.txt that contains both counts. Show the report.' },
  { name: 'T14 nc transfer', goal: 'Use netcat (busybox nc) to transfer a message over TCP on localhost: start a listener `nc -l -p 7000 > /root/transfer/nc.txt &`, then send the text "uranus-net-handshake" to it from another connection (`printf "uranus-net-handshake" | nc 127.0.0.1 7000`), then show the received file with cat.' },
  { name: 'T15 python server', goal: 'Install python3 with apk add python3. Then start an HTTP server serving /root/served on port 8000 in the background (python3 -m http.server 8000 -d /root/served &). Fetch http://127.0.0.1:8000/index.html with wget and print its content (expect SERVED_BY_PYTHON). Leave the server running.' },
  { name: 'T16 cron job', goal: 'Enable the busybox cron daemon: rc-service crond start. Add a root crontab entry that appends a line with the current date+time to /var/log/uranus-cron.log every minute (* * * * * date >> /var/log/uranus-cron.log). Wait until the file gets at least one line (poll it), then show the file content and the crontab -l output.' },
  { name: 'T17 lighttpd', goal: 'Install lighttpd with apk add lighttpd. Write /var/www/localhost/htdocs/index.html containing the marker text LIGHTT_INDEX_SERVED. Start the service with rc-service lighttpd start. Fetch http://127.0.0.1/ with wget and confirm the page contains the marker.' },
  { name: 'T18 bash shell', goal: 'Install bash with apk add bash. Prove it is functional: run bash --version and print the first line, and run `bash -c "echo $0"` showing it runs as a bash process.' },
  { name: 'T19 cpu load', goal: 'Install stress with apk add stress. Run `stress -c 4` for a few seconds to create CPU load. After ~2 seconds, save the first line of /proc/loadavg into /root/loadavg.txt. Then stop all stress processes (pkill -f stress). Show the load value and confirm no stress processes remain.' },
  { name: 'T20 capstone', goal: 'Read the payload at /var/cache/capstone/payload.txt. Then build a small operator workspace: create user "operator" with a locked shell (/sbin/nologin), copy the payload into /srv/operator/flag.txt owned by operator, and expose it on TCP port 8080 using netcat in the background so that connecting to port 8080 returns the flag content. Verify: getent passwd operator shows nologin, ls -l /srv/operator/flag.txt shows operator as owner, and fetching http://127.0.0.1:8080/ with wget returns the flag text.' },
];

async function main() {
  const args = process.argv.slice(2);
  let lo = 1, hi = TASKS.length;
  if (args[0] && args[0].startsWith('--')) {
    lo = parseInt(args[1], 10) || 1;
    hi = parseInt(args[2], 10) || lo;
  } else if (args[0]) {
    lo = parseInt(args[0], 10) || 1;
    hi = parseInt(args[1] && /^\d+$/.test(args[1]) ? args[1] : args[0], 10) || lo;
  }
  const results = [];
  for (let t = lo; t <= Math.min(hi, TASKS.length); t++) {
    const task = TASKS[t - 1];
    resetVm();
    plantFixtures(task.name);
    const started = Date.now();
    try {
      const r = await solveTask(task.name, task.goal);
      const v = await verifyTask(task.name);
      results.push({ task: task.name, seconds: Math.round((Date.now() - started) / 1000), turns: r.turns, verified: v.pass, evidence: v.evidence.slice(0, 300), selfReport: r.final.slice(0, 200) });
    } catch (e) {
      results.push({ task: task.name, seconds: Math.round((Date.now() - started) / 1000), error: e.message });
    }
  }
  console.log('\n=========== SUMMARY ===========');
  for (const r of results) console.log(JSON.stringify(r));
  const passed = results.filter((r) => r.verified === true).length;
  const total = results.filter((r) => r.verified !== undefined).length;
  if (total) console.log(`\nVERIFIED PASS: ${passed}/${total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

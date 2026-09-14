/**
 * Deterministic verifier for URANUS-VM tasks.
 * Since llama3.1 self-reports are unreliable (it claims success when the VM
 * state says otherwise), every task is verified against the real VM over SSH.
 * Returns { pass, evidence }.
 */
const { sshExec } = require('./harness.js');

const CHECKS = {
  'T1 identify': async () => {
    const r = sshExec('uname -nr; grep MemTotal /proc/meminfo; df -T / | tail -1');
    const ok = /6\.12\.[0-9.]+/.test(r.out) && /MemTotal:\s+\d+/.test(r.out) && /tmpfs/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T2 file ops': async () => {
    const r = sshExec('cat /root/uranus/hello.txt 2>&1');
    const lines = r.out.split('\n');
    const ok = lines[0].match(/^URANUS was here$/) && lines.length >= 2 && /20\d\d-\d\d-\d\dT/.test(lines[1] || '');
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T3 copy tree': async () => {
    const r2 = sshExec('ls /etc/init.d/ | head -1');
    const first = (r2.out || '').trim();
    if (!first) return { pass: false, evidence: 'no file in /etc/init.d' };
    const semicolon = `cmp -s /etc/init.d/${first} /root/init-backup.d/${first} && echo IDENTICAL && sha256sum /etc/init.d/${first} /root/init-backup.d/${first} || echo DIFF`;
    const r3 = sshExec(semicolon);
    const ok = /IDENTICAL/.test(r3.out) && r3.out.includes('/root/init-backup.d/');
    return { pass: ok, evidence: r3.out.slice(0, 400) };
  },

  'T4 package mgmt': async () => {
    const r = sshExec('command -v jq && echo $(echo "{\\"a\\":1}" | jq .a)');
    const ok = /\/.*\/jq/.test(r.out) && r.out.trim().endsWith('1');
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T5 web request': async () => {
    const r = sshExec('ls -l /root/example.html 2>&1 && wc -c < /root/example.html');
    const ok = /example\.html/.test(r.out) && !/No such file/.test(r.out) && /\d+/.test(r.out.trim().split('\n').pop() || '');
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T6 process kill': async () => {
    const r = sshExec('pgrep -f "sleep 300" >/dev/null && echo STILL_RUNNING || echo CLEARED');
    const ok = /CLEARED/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 200) };
  },

  'T7 log script': async () => {
    const r = sshExec('wc -l < /srv/app/run.log 2>/dev/null; ls -l /srv/app/log.sh 2>/dev/null');
    const ok = /^2/.test(r.out.trim().split('\n')[0]) && /log\.sh/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T8 nginx serve': async () => {
    const r = sshExec('netstat -tln 2>/dev/null | grep :80 ; wget -q -T5 -O- http://127.0.0.1/ 2>&1 | head -c 120');
    const ok = /:80/.test(r.out) && /nginx|<html>/i.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T9 users nologin': async () => {
    const r = sshExec('getent passwd gemini; getent group uranus; id gemini 2>/dev/null');
    const ok = /gemini:.*:uranus/.test(r.out) && /uranus/.test(r.out.split('\n')[1] || '');
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T10 find treasure': async () => {
    const r = sshExec('sha256sum /var/cache/.hidden-cache/treasure.txt 2>&1');
    const ok = /d7869d1935479dfa36997c123f62e54c41ef2c619ba16123f7ae3c2e21a86f74/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T11 base64 decode': async () => {
    const r = sshExec('cat /root/uranus/decoded.txt 2>&1');
    const ok = /URANUS_DECODED_45xm/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T12 gzip round-trip': async () => {
    const r = sshExec('gzip -t /root/uranus/data.txt.gz 2>&1 && gzip -dc /root/uranus/data.txt.gz 2>/dev/null | cmp -s - /var/tmp/compress-job/data.txt && echo GZIP_OK || echo GZIP_BAD');
    const ok = /GZIP_OK/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T13 log analysis': async () => {
    const r = sshExec('E=$(grep -c "^ERROR" /root/analysis.log); W=$(grep -c "^WARN" /root/analysis.log); echo "E=$E W=$W"; grep -qE "^(error|ERROR).{0,3}6000" /root/uranus/report.txt 2>&1 && echo HAS_6000')
    const ok = /E=6000 W=3000/.test(r.out) && /HAS_6000/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 400) };
  },

  'T14 nc transfer': async () => {
    const r = sshExec('grep -q "uranus-net-handshake" /root/transfer/nc.txt 2>&1 && echo NET_OK');
    const ok = /NET_OK/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T15 python server': async () => {
    const r = sshExec('wget -q -T5 -O- http://127.0.0.1:8000/index.html 2>&1 | head -c 120');
    const ok = /SERVED_BY_PYTHON/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T16 cron job': async () => {
    for (let i = 0; i < 12; i++) {
      const r = sshExec('test -s /var/log/uranus-cron.log 2>&1 && echo CRON_LOG && wc -l < /var/log/uranus-cron.log');
      if (/CRON_LOG/.test(r.out)) return { pass: true, evidence: r.out.slice(0, 300) };
      await new Promise((res) => setTimeout(res, 5000));
    }
    return { pass: false, evidence: 'no cron output within ~60s' };
  },

  'T17 lighttpd': async () => {
    const r = sshExec('wget -q -T5 -O- http://127.0.0.1/ 2>&1 | grep -q LIGHTT_INDEX_SERVED && echo LIGHT_OK');
    const ok = /LIGHT_OK/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T18 bash shell': async () => {
    const r = sshExec('bash --version 2>&1 | head -1; test "$(bash -c \'echo $0\')" = bash && echo BASH_OK');
    const ok = /GNU bash, version/.test(r.out) && /BASH_OK/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T19 cpu load': async () => {
    const r = sshExec('L=$(awk \'{print $1}\' /root/loadavg.txt 2>/dev/null); echo "load=$L"; awk -v l="$L" \'BEGIN { exit !(l >= 1.0) }\' && echo LOAD_OK; pgrep -f stress >/dev/null && echo STRESS_ALIVE || echo STRESS_CLEARED');
    const ok = /LOAD_OK/.test(r.out) && /STRESS_CLEARED/.test(r.out);
    return { pass: ok, evidence: r.out.slice(0, 300) };
  },

  'T20 capstone': async () => {
    const r = sshExec('getent passwd operator; echo ---; wget -q -T5 -O- http://127.0.0.1:8080/ 2>&1 | head -c 120; echo; ls -l /srv/operator/flag.txt 2>&1');
    const ok = /operator:.*nologin/.test(r.out) && /OP_CAPSTONE_3f7a/.test(r.out) && r.out.includes('-rw') && /operator/.test(r.out.split('\n').pop() || '');
    return { pass: ok, evidence: r.out.slice(0, 500) };
  },
};

async function verifyTask(taskName) {
  const fn = CHECKS[taskName];
  if (!fn) return { pass: false, evidence: 'no check defined' };
  try {
    return await fn();
  } catch (e) {
    return { pass: false, evidence: 'check error: ' + e.message };
  }
}

module.exports = { verifyTask };
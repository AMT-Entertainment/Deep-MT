#!/bin/sh
# Reset VM to baseline before a task. Must be idempotent.
# Covers laundered artifacts for tasks T1..T20.

# files / dirs created by tasks
rm -rf /root/uranus /root/init-backup.d /root/example.html /root/analysis.log
rm -rf /root/analysis.report /root/serv-del /root/transfer /root/served /root/loadavg.txt
rm -rf /srv/app /srv/operator /var/cache/.hidden-cache /var/cache/capstone
rm -f /var/tmp/challenge11.b64 /var/tmp/compress-job/data.txt.gz
rm -f /var/log/uranus-cron.log /var/log/cron-jobs.log
rmdir /var/tmp/compress-job 2>/dev/null || true

# processes we might have left running by a failed task
pkill -f "sleep 300" 2>/dev/null || true
pkill -f "stress -c" 2>/dev/null || true
pkill -f "http.server 8000" 2>/dev/null || true
pkill -f "nc -l -p 7000" 2>/dev/null || true
pkill -f "nc -l 8080" 2>/dev/null || true

# services
for svc in nginx lighttpd crond; do
  rc-service "$svc" stop 2>/dev/null || true
done

# packages (reinstalled on demand per task)
apk del -q nginx lighttpd jq stress 2>/dev/null || true

# alternative SAFE host of nginx config
rm -f /etc/nginx/nginx.conf

# users/groups
for u in gemini operator; do
  if getent passwd "$u" >/dev/null 2>&1; then deluser "$u" 2>/dev/null || true; fi
done
for g in uranus operator nginx; do
  if getent group "$g" >/dev/null 2>&1; then delgroup "$g" 2>/dev/null || true; fi
done

# stray files
rm -f /etc/init.d/agentflag /root/uranus/hello.txt

echo BASELINE_OK
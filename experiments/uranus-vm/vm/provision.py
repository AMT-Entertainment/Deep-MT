#!/usr/bin/env python3
"""Bootstrap script for the URANUS-VM experiment.

Boots the Alpine virt ISO under QEMU (hvf), drives the serial console,
provisions opensshd + root key auth, then hands the OS to the harness
over SSH (127.0.0.1:2222). All console output is teed into the log dir.
"""
import pty, os, sys, time, select, signal, argparse

VM_DIR = os.path.dirname(os.path.abspath(__file__))
ISO = os.path.join(VM_DIR, "alpine-virt-3.21.7-aarch64.iso")
PUBC = os.path.join(VM_DIR, "uranus_ssh.pub")
BOOTLOG = os.path.join(VM_DIR, "boot.log")

def spawn():
    master, slave = pty.openpty()
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
        os.close(master)
        os.execvp("qemu-system-aarch64", [
            "qemu-system-aarch64", "-machine", "virt", "-m","2048","-smp","4",
            "-accel","hvf","-cpu","host",
            "-display", "none",
            "-bios", "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
            "-drive", f"file={ISO},media=cdrom,readonly=on",
            "-nic", "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:2222-:22",
            "-device", "virtio-rng-pci",
            "-serial", "stdio",
        ])
    os.close(slave)
    return master, pid

def readuntil(master, needle, timeout=120):
    if isinstance(needle, str): needle = needle.encode()
    buf = b""
    end = time.time() + timeout
    while time.time() < end:
        r,_,_ = select.select([master], [], [], 0.5)
        if r:
            try:
                data = os.read(master, 4096)
            except OSError:
                return buf
            if not data:
                return buf
            buf += data
            if needle in buf:
                return buf
    return buf

def run_cmd(master, cmd, expect, timeout=60):
    os.write(master, cmd.encode() + b"\n")
    return readuntil(master, expect, timeout)

def main():
    pub = open(PUBC).read().strip()
    m, pid = spawn()
    logf = open(BOOTLOG, "wb")
    buf = readuntil(m, b"login:", 90)
    logf.write(buf); logf.flush()
    os.write(m, b"root\n")
    time.sleep(1)
    r = readuntil(m, "localhost:~#", 30)
    logf.write(r); logf.flush()
    if b"localhost:~#" not in r and b"localhost:~#" not in buf:
        raise SystemExit("no root prompt")
    steps = [
        ('IF=$(ip -o link show | sed -n "s/^[0-9]*: \\([^:]*\\):.*/\\1/p" | grep -v lo | head -1); echo IFACE=$IF', 'localhost:~#', 20),
        ('IF=$(ip -o link show | sed -n "s/^[0-9]*: \\([^:]*\\):.*/\\1/p" | grep -v lo | head -1); ip link set $IF up; udhcpc -i $IF 2>&1 | tail -3', 'localhost:~#', 40),
        ('apk update 2>&1 | tail -1', 'localhost:~#', 120),
        ('apk add --no-cache openssh 2>&1 | tail -1', 'localhost:~#', 180),
        ("echo 'root:uranus-vm-exp' | chpasswd", 'localhost:~#', 15),
        ("mkdir -p /root/.ssh && chmod 700 /root/.ssh", 'localhost:~#', 10),
        (f"echo '{pub}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys", 'localhost:~#', 5),
        ("sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config", 'localhost:~#', 5),
        ("printf 'https://dl-cdn.alpinelinux.org/alpine/v3.21/main\\nhttps://dl-cdn.alpinelinux.org/alpine/v3.21/community\\n' > /etc/apk/repositories 2>/dev/null; echo repos-set", 'localhost:~#', 10),
    ]
    for cmd,mtc,to in steps:
        os.write(m, cmd.encode()+b"\n")
        if mtc is not None:
            r = readuntil(m, mtc, to)
            logf.write(b"> " + cmd.encode() + b"\n" + r); logf.flush()
    os.write(m, b"ssh-keygen -A 2>&1 | tail -1 && /usr/sbin/sshd 2>&1 | tail -1\n")
    r = readuntil(m, "localhost:~#", 30)
    logf.write(r); logf.flush()
    for dbg in [
        "dmesg | grep -iE 'random|rng' | tail -5",
        "ps aux | grep sshd | grep -v grep",
        "cat /etc/ssh/sshd_config | grep -iE 'PermitRoot|PasswordAuth'",
        "sysctl net.ipv4.tcp_keepalive_time 2>/dev/null",
    ]:
        r = run_cmd(m, dbg, "localhost:~#", 15)
        logf.write(b"> " + dbg.encode() + b"\n" + r); logf.flush()
    r = run_cmd(m, "ss -tlnp 2>/dev/null | grep :22 || netstat -tlnp 2>/dev/null | grep :22", "localhost:~#", 20)
    logf.write(r); logf.flush()
    print("provisioned pid=%d" % pid)
    sys.stdout.flush()
    open(os.path.join(VM_DIR, "vm.pid"), "w").write(str(pid))
    cmdf = os.path.join(VM_DIR, "console.cmds")
    try: os.unlink(cmdf)
    except OSError: pass
    n = 0
    while True:
        try:
            with open(cmdf) as f:
                lines = f.read().splitlines()
        except OSError:
            lines = []
        for l in lines:
            if l:
                os.write(m, (l + "\n").encode())
                time.sleep(0.5)
        if lines:
            try: os.unlink(cmdf)
            except OSError: pass
        r,_,_ = select.select([m], [], [], 1)
        if r:
            try:
                d = os.read(m, 65536)
            except OSError:
                d = b""
            if d:
                logf.write(d); logf.flush()
        n += 1

if __name__ == "__main__":
    main()
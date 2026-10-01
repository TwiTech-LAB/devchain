#!/usr/bin/env bash
# Boots a built host image under local KVM (throwaway overlay, NoCloud seed)
# and checks the image's acceptance items: guest agent IP, host tools, the
# headless session rules and the no-account baseline — the image ships no
# user of its own, so its checks run as root through the guest agent and SSH
# must refuse every login until a claim creates an account. The image itself
# must hold no VM certificate; the first boot creates one. Prints one
# PASS/FAIL/SKIP line per check and exits non-zero when any check fails.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: apps/host-image/verify.sh <image.qcow2> [--port <devchain-port>] [--keep]

  --port <p>   Port the bootstrap service listens on (default 3000)
  --keep       Leave the VM running and print how to reach it
EOF
}

IMAGE=''
PORT=3000
KEEP=no
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=${2:-}; shift 2 ;;
    --keep) KEEP=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    *) [ -z "$IMAGE" ] || { usage >&2; exit 2; }; IMAGE=$1; shift ;;
  esac
done
[ -n "$IMAGE" ] && [ -f "$IMAGE" ] || { usage >&2; exit 2; }
IMAGE=$(realpath "$IMAGE")
for tool in qemu-system-x86_64 qemu-img guestfish xorriso ssh ssh-keygen python3 curl; do
  command -v "$tool" >/dev/null || { echo "verify.sh: missing tool: $tool" >&2; exit 2; }
done

WORK=$(mktemp -d)
QEMU_PID=''
cleanup() {
  if [ "$KEEP" = no ]; then
    [ -z "$QEMU_PID" ] || kill "$QEMU_PID" 2>/dev/null || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

FAILED=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
skip() { printf 'SKIP  %s\n' "$*"; }
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

# Read from the image itself, before the boot below creates the certificate.
if baked=$(guestfish --ro --format=qcow2 -a "$IMAGE" -i exists /etc/devchain-host/tls 2>&1) && [ "$baked" = false ]; then
  pass 'the image holds no VM certificate (/etc/devchain-host/tls is absent)'
else
  fail "the image holds /etc/devchain-host/tls or could not be read: $baked"
fi

ssh-keygen -q -t ed25519 -N '' -f "$WORK/key"
# A key, a password and ssh_pwauth are requested on purpose: the image must
# ignore all three. No module that would apply them runs, and there is no
# default account for the key to land in.
cat > "$WORK/user-data" <<EOF
#cloud-config
ssh_authorized_keys:
  - $(cat "$WORK/key.pub")
password: verify-must-not-apply
chpasswd: { expire: false }
ssh_pwauth: true
EOF
printf 'instance-id: devchain-verify-%s\nlocal-hostname: devchain-verify\n' "$$" > "$WORK/meta-data"
xorriso -as mkisofs -quiet -output "$WORK/seed.iso" -volid cidata -joliet -rock \
  "$WORK/user-data" "$WORK/meta-data" 2>/dev/null
qemu-img create -q -f qcow2 -F qcow2 -b "$IMAGE" "$WORK/disk.qcow2" 12G

SSH_PORT=$(free_port)
APP_PORT=$(free_port)
START=$(date +%s)
qemu-system-x86_64 -enable-kvm -cpu host -m 2048 -smp 2 -display none \
  -serial "file:$WORK/console.log" \
  -drive "file=$WORK/disk.qcow2,if=virtio,format=qcow2" \
  -drive "file=$WORK/seed.iso,media=cdrom" \
  -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$APP_PORT-:$PORT" \
  -device virtio-net-pci,netdev=n0 \
  -chardev "socket,id=qga0,path=$WORK/qga.sock,server=on,wait=off" \
  -device virtio-serial -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 &
QEMU_PID=$!

# Same question Proxmox asks the agent: guest-network-get-interfaces.
agent_ip() {
  python3 - "$WORK/qga.sock" <<'EOF'
import json, random, socket, sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(3)
try:
    s.connect(sys.argv[1])
    f = s.makefile('rw')
    token = random.randint(1, 2**31)
    f.write(json.dumps({'execute': 'guest-sync', 'arguments': {'id': token}}) + '\n'); f.flush()
    while json.loads(f.readline()).get('return') != token:
        pass
    f.write(json.dumps({'execute': 'guest-network-get-interfaces'}) + '\n'); f.flush()
    for iface in json.loads(f.readline())['return']:
        for addr in iface.get('ip-addresses', []):
            if addr['ip-address-type'] == 'ipv4' and not addr['ip-address'].startswith('127.'):
                print(addr['ip-address']); sys.exit(0)
except Exception:
    pass
sys.exit(1)
EOF
}

# Runs a command on the guest as root through the guest agent: until the VM
# is claimed there is no account to SSH into.
vm_exec() {
  python3 - "$WORK/qga.sock" "$1" <<'PYEOF'
import base64, json, random, socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.settimeout(180)
try:
    s.connect(sys.argv[1])
    f = s.makefile('rw')
    token = random.randint(1, 2**31)
    f.write(json.dumps({'execute': 'guest-sync', 'arguments': {'id': token}}) + '\n'); f.flush()
    while json.loads(f.readline()).get('return') != token:
        pass
    f.write(json.dumps({'execute': 'guest-exec', 'arguments': {
        'path': '/bin/bash', 'arg': ['-c', sys.argv[2]], 'capture-output': True}}) + '\n'); f.flush()
    pid = json.loads(f.readline())['return']['pid']
    while True:
        f.write(json.dumps({'execute': 'guest-exec-status', 'arguments': {'pid': pid}}) + '\n'); f.flush()
        status = json.loads(f.readline())['return']
        if status.get('exited'):
            break
        time.sleep(0.2)
    sys.stdout.write(base64.b64decode(status.get('out-data', '')).decode(errors='replace'))
    sys.stderr.write(base64.b64decode(status.get('err-data', '')).decode(errors='replace'))
    exitcode = status.get('exitcode')
    sys.exit(exitcode if exitcode is not None else 125)
except Exception as error:
    sys.stderr.write(f'guest agent: {error}\n')
    sys.exit(124)
PYEOF
}

IP=''
while [ $(($(date +%s) - START)) -lt 60 ]; do
  if IP=$(agent_ip); then break; fi
  sleep 2
done
if [ -n "$IP" ]; then
  pass "guest agent reports $IP after $(($(date +%s) - START)) s"
else
  fail 'guest agent reported no IPv4 address within 60 s'
fi

check() {
  local label=$1 cmd=$2 out
  if out=$(vm_exec "$cmd" 2>&1); then pass "$label${out:+ ($out)}"; else fail "$label${out:+ ($out)}"; fi
}

if out=$(vm_exec 'timeout 180 cloud-init status --wait' 2>&1); then
  pass "cloud-init completed ($out)"
else
  fail "cloud-init did not complete successfully: $out"
  exit 1
fi

check 'hostname set by cloud-init' '[ "$(hostname)" = devchain-verify ]'
check 'no default user: the image ships no ubuntu account' '! getent passwd ubuntu'
check 'uid 1000 is free (claim fixture uid)' '[ -z "$(getent passwd 1000)" ]'

# The pipeline and its PIPESTATUS must run on the guest: ending the remote
# command at `head` would report the shell's own status and let a missing tool pass
# as long as it printed a "command not found" line. `sed -n 1p` reads all the
# output: `head -n 1` closes the pipe early, and a long version text (rsync,
# unzip) then ends its tool with SIGPIPE. The guest agent runs commands without
# HOME, and syncthing refuses to start without it.
for cli in 'node --version' 'syncthing --version' 'git --version' 'tmux -V' \
  'jq --version' 'rg --version' 'python --version' 'sqlite3 --version' \
  'rsync --version' 'file --version' 'unzip -v'; do
  if out=$(vm_exec "export HOME=/root; $cli </dev/null 2>&1 | sed -n 1p; exit \"\${PIPESTATUS[0]}\"") && [ -n "$out" ]; then
    pass "as root: $cli -> $out"
  else
    fail "as root: $cli -> ${out:-no output}"
  fi
done

check 'dbus-user-session, dbus-x11, gnome-keyring not installed' \
  'for p in dbus-user-session dbus-x11 gnome-keyring; do s=$(dpkg-query -W -f="\${db:Status-Status}" $p 2>/dev/null || true); [ "$s" != installed ] || { echo "$p installed"; exit 1; }; done'
check 'python3 -m venv builds a working venv (python3-venv + ensurepip)' \
  'd=$(mktemp -d) && python3 -m venv "$d/v" && "$d/v/bin/python" -c pass && rm -rf "$d"'
check 'dbus-launch is not on PATH' '! command -v dbus-launch'
check 'no /run/user session directories (no login ran, no session bus)' \
  '[ -z "$(ls -A /run/user 2>/dev/null)" ]'
check 'apt refuses the session-bus packages' \
  'apt-cache policy dbus-user-session | grep -q "Candidate: (none)"'
check 'inotify watches raised' '[ "$(sysctl -n fs.inotify.max_user_watches)" = 524288 ]'
check 'guest agent service active' 'systemctl is-active qemu-guest-agent'
# sshd starts on the first connection, and `sshd -T` refuses to run before its
# runtime directory exists.
check 'sshd allows no password or keyboard-interactive auth' \
  'install -d -m 0755 /run/sshd && sshd -T | grep -Eqx "passwordauthentication no" && sshd -T | grep -Eqx "kbdinteractiveauthentication no"'
check 'root has no password (user-data password ignored)' \
  's=$(passwd -S root | cut -d" " -f2); [ "$s" = L ] || [ "$s" = NP ] || { echo "root: $s"; exit 1; }'
denied=$(ssh -i "$WORK/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
  -o PubkeyAuthentication=no -o ConnectTimeout=5 ubuntu@127.0.0.1 true 2>&1 || true)
if [[ "$denied" == *'Permission denied (publickey)'* ]]; then
  pass 'sshd offers publickey only'
else
  fail "sshd offers more than publickey: $denied"
fi
denied=$(ssh -i "$WORK/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes \
  -o ConnectTimeout=5 ubuntu@127.0.0.1 true 2>&1 || true)
if [[ "$denied" == *'Permission denied (publickey)'* ]]; then
  pass 'the seed key logs nobody in (no account to receive it)'
else
  fail "the seed key was not refused: $denied"
fi
check 'root file system grown to the VM disk' '[ "$(df --output=size -B1G / | tail -n 1)" -ge 11 ]'

MANIFEST=$(vm_exec 'cat /usr/share/devchain-host/manifest.json')
IMAGE_VERSION=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["imageVersion"])' <<<"$MANIFEST")
HAS_BOOTSTRAP=$(python3 -c 'import json,sys; print("yes" if json.load(sys.stdin)["bootstrap"] else "no")' <<<"$MANIFEST")
if [ "$HAS_BOOTSTRAP" = yes ]; then
  check 'first boot created the VM certificate: EC P-256, valid 10 years, key 0600' \
    'd=/etc/devchain-host/tls; [ "$(stat -c %a $d/key.pem)" = 600 ] && openssl x509 -in $d/cert.pem -noout -text | grep -q "ASN1 OID: prime256v1" && openssl x509 -in $d/cert.pem -noout -checkend $((3649 * 86400)) >/dev/null && openssl x509 -in $d/cert.pem -noout -enddate'
  vm_exec 'cat /etc/devchain-host/tls/cert.pem' > "$WORK/cert.pem" 2>/dev/null || true
  # The certificate names devchain-host, so curl checks it against that name.
  runtime=$(curl -fsS --max-time 5 --cacert "$WORK/cert.pem" --resolve "devchain-host:$APP_PORT:127.0.0.1" \
    "https://devchain-host:$APP_PORT/api/runtime" || true)
  if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d.get("state")=="unclaimed" and d.get("imageVersion")==sys.argv[2] else 1)' \
    "${runtime:-null}" "$IMAGE_VERSION" 2>/dev/null; then
    pass "GET https://:$PORT/api/runtime with the VM certificate -> $runtime"
  else
    fail "GET https://:$PORT/api/runtime with the VM certificate -> ${runtime:-no answer}"
  fi
  plain=$(curl -sS --max-time 5 "http://127.0.0.1:$APP_PORT/api/runtime" 2>&1 || true)
  if [[ "$plain" != *unclaimed* ]]; then
    pass "plaintext GET :$PORT/api/runtime gets no answer (${plain:-empty})"
  else
    fail "plaintext GET :$PORT/api/runtime answered: $plain"
  fi
  check 'a bootstrap restart keeps the certificate' \
    'before=$(sha256sum < /etc/devchain-host/tls/cert.pem) && systemctl restart devchain-bootstrap && [ "$(sha256sum < /etc/devchain-host/tls/cert.pem)" = "$before" ]'
else
  skip "GET :$PORT/api/runtime (image built --without-bootstrap)"
fi

if [ "$KEEP" = yes ]; then
  echo "VM left running (pid $QEMU_PID); agent socket $WORK/qga.sock. No SSH account exists until the VM is claimed."
fi
exit "$FAILED"

#!/usr/bin/env bash
# Claims a real VM booted from a host image and checks the bootstrap contract:
# claim (with fixture uid 1000 and an SSH key shipped as a claim file — the image
# has no account of its own), provider auth files, session environment,
# project roots, update and reboot. Every call uses HTTPS, pinned to the VM
# certificate that the guest agent reads before the claim, as Proxmox create
# does. Needs a registry (the image manifest's
# npmRegistry) that serves both devchain-cli versions given.
# See README.md, "End-to-end test".
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: apps/host-bootstrap/e2e/claim-vm.sh <image.qcow2> --version <v1> --update-to <v2> [--keep]
EOF
}

IMAGE=''
VERSION=''
UPDATE_TO=''
KEEP=no
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --update-to) UPDATE_TO=${2:-}; shift 2 ;;
    --keep) KEEP=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    *) [ -z "$IMAGE" ] || { usage >&2; exit 2; }; IMAGE=$1; shift ;;
  esac
done
[ -f "$IMAGE" ] && [ -n "$VERSION" ] && [ -n "$UPDATE_TO" ] || { usage >&2; exit 2; }
IMAGE=$(realpath "$IMAGE")

PORT=3000
USER_NAME=alice
HOME_PATH=/Users/alice
CLAIM_UID=1000
SECRET="e2e-secret-$RANDOM$RANDOM"
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
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

ssh-keygen -q -t ed25519 -N '' -f "$WORK/key"
printf '#cloud-config\nssh_authorized_keys:\n  - %s\n' "$(cat "$WORK/key.pub")" > "$WORK/user-data"
printf 'instance-id: claim-e2e-%s\nlocal-hostname: claim-e2e\n' "$$" > "$WORK/meta-data"
xorriso -as mkisofs -quiet -output "$WORK/seed.iso" -volid cidata -joliet -rock \
  "$WORK/user-data" "$WORK/meta-data" 2>/dev/null
qemu-img create -q -f qcow2 -F qcow2 -b "$IMAGE" "$WORK/disk.qcow2" 16G
SSH_PORT=$(free_port)
APP_PORT=$(free_port)
# The VM certificate names devchain-host; --resolve points that name at the forwarded port.
BASE="https://devchain-host:$APP_PORT"
TLS=(--cacert "$WORK/cert.pem" --resolve "devchain-host:$APP_PORT:127.0.0.1")
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 -display none \
  -serial "file:$WORK/console.log" \
  -drive "file=$WORK/disk.qcow2,if=virtio,format=qcow2" \
  -drive "file=$WORK/seed.iso,media=cdrom" \
  -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$APP_PORT-:$PORT" \
  -device virtio-net-pci,netdev=n0 \
  -chardev "socket,id=qga0,path=$WORK/qga.sock,server=on,wait=off" \
  -device virtio-serial -device virtserialport,chardev=qga0,name=org.qemu.guest_agent.0 &
QEMU_PID=$!
# Reads one guest file as root with guest-file-open/read, the calls behind
# Proxmox's agent/file-read.
agent_read_file() {
  python3 - "$WORK/qga.sock" "$1" <<'PYEOF'
import base64, json, random, socket, sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(10)
try:
    s.connect(sys.argv[1])
    f = s.makefile('rw')
    def call(command, arguments):
        f.write(json.dumps({'execute': command, 'arguments': arguments}) + '\n'); f.flush()
        answer = json.loads(f.readline())
        if 'error' in answer:
            raise RuntimeError(answer['error'].get('desc'))
        return answer['return']
    token = random.randint(1, 2**31)
    f.write(json.dumps({'execute': 'guest-sync', 'arguments': {'id': token}}) + '\n'); f.flush()
    while json.loads(f.readline()).get('return') != token:
        pass
    handle = call('guest-file-open', {'path': sys.argv[2], 'mode': 'r'})
    data = b''
    while True:
        chunk = call('guest-file-read', {'handle': handle, 'count': 65536})
        data += base64.b64decode(chunk.get('buf-b64', ''))
        if chunk.get('eof'):
            break
    call('guest-file-close', {'handle': handle})
    sys.stdout.buffer.write(data)
except Exception as error:
    sys.stderr.write(f'guest agent: {error}\n')
    sys.exit(1)
PYEOF
}
read_certificate() {
  agent_read_file /etc/devchain-host/tls/cert.pem > "$WORK/cert.pem" 2>/dev/null &&
    grep -q 'BEGIN CERTIFICATE' "$WORK/cert.pem"
}
SSH=(ssh -i "$WORK/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=5 -o BatchMode=yes "$USER_NAME@127.0.0.1")
on_vm() { "${SSH[@]}" "$@"; }
# The image has no account of its own, so before the claim sshd must answer
# and refuse every login; the key only becomes usable through the claim.
ssh_answer() {
  ssh -i "$WORK/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=5 -o BatchMode=yes "$USER_NAME@127.0.0.1" true 2>&1 || true
}
ssh_refused() { [[ "$(ssh_answer)" == *'Permission denied (publickey)'* ]]; }

wait_for() {
  local seconds=$1; shift
  local deadline=$(($(date +%s) + seconds))
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 2
  done
}
runtime_field() { curl "${TLS[@]}" -fsS --max-time 3 "$BASE/api/runtime" 2>/dev/null | json "d.get('$1')"; }
runtime_is() { [ "$(runtime_field "$1" 2>/dev/null)" = "$2" ]; }
check() {
  local label=$1 cmd=$2 out
  if out=$(on_vm "$cmd" 2>&1); then pass "$label${out:+ ($out)}"; else fail "$label${out:+ ($out)}"; fi
}

wait_for 180 read_certificate && pass 'fresh VM: the guest agent reads /etc/devchain-host/tls/cert.pem' ||
  { fail 'the guest agent never read the VM certificate'; tail -n 30 "$WORK/console.log"; exit 1; }
CERT_SHA=$(sha256sum < "$WORK/cert.pem")
wait_for 180 runtime_is state unclaimed && pass 'fresh VM: /api/runtime over HTTPS reports unclaimed' ||
  { fail 'fresh VM never answered unclaimed'; tail -n 30 "$WORK/console.log"; exit 1; }
[ "$(runtime_field version)" = None ] && pass 'unclaimed runtime has version null' || fail 'unclaimed runtime has a version'
plain=$(curl -sS --max-time 5 "http://127.0.0.1:$APP_PORT/api/runtime" 2>&1 || true)
[[ "$plain" != *unclaimed* ]] && pass 'plaintext HTTP to the bootstrap gets no answer' ||
  fail "plaintext HTTP to the bootstrap answered: $plain"
if wait_for 240 ssh_refused; then
  pass 'no SSH login before the claim: sshd answers and refuses every account'
else
  fail 'sshd did not refuse the pre-claim login within 240 s'
fi

AUTH_B64=$(printf '{"tokens":"%s-file"}' "$SECRET" | base64 -w0)
KEY_B64=$(cat "$WORK/key.pub" | base64 -w0)
cat > "$WORK/claim.json" <<EOF
{
  "userName": "$USER_NAME",
  "homePath": "$HOME_PATH",
  "uid": $CLAIM_UID,
  "version": "$VERSION",
  "port": $PORT,
  "providerAuth": {
    "env": { "E2E_PROVIDER_TOKEN": "$SECRET" },
    "files": [
      { "path": "$HOME_PATH/.codex/auth.json", "mode": "0600", "contentBase64": "$AUTH_B64" },
      { "path": "$HOME_PATH/.ssh/authorized_keys", "mode": "0600", "contentBase64": "$KEY_B64" }
    ]
  }
}
EOF
started=$(date +%s)
status=$(curl "${TLS[@]}" -sS -o "$WORK/claim-answer.json" -w '%{http_code}' --max-time 900 \
  -H 'content-type: application/json' --data-binary "@$WORK/claim.json" "$BASE/api/host/claim")
if [ "$status" = 200 ]; then
  pass "claim answered 200 after $(($(date +%s) - started)) s: $(cat "$WORK/claim-answer.json")"
else
  fail "claim answered $status: $(cat "$WORK/claim-answer.json")"
  on_vm 'sudo journalctl -u devchain-bootstrap -u devchain-host --no-pager | tail -n 40' || true
  exit 1
fi
[ "$(runtime_field version)" = "$VERSION" ] && pass "/api/runtime reports DevChain $VERSION" ||
  fail "/api/runtime reports $(runtime_field version)"
status=$(curl "${TLS[@]}" -sS -o "$WORK/second.json" -w '%{http_code}' -H 'content-type: application/json' \
  --data-binary "@$WORK/claim.json" "$BASE/api/host/claim")
[ "$status" = 409 ] && pass "second claim answered 409: $(cat "$WORK/second.json")" ||
  fail "second claim answered $status"

if wait_for 120 on_vm true; then
  pass 'SSH login as the claimed user with the key shipped in the claim'
else
  fail 'no SSH login as the claimed user; serial console tail:'
  tail -n 30 "$WORK/console.log"
fi
check "the claim gave $USER_NAME fixture uid 1000 and its own group" \
  "[ \"\$(id -u $USER_NAME)\" = $CLAIM_UID ] && [ \"\$(id -g $USER_NAME)\" = $CLAIM_UID ]"
[ "$(runtime_field uid)" = "$CLAIM_UID" ] && pass "/api/runtime reports the real uid $CLAIM_UID" ||
  fail "/api/runtime reports uid $(runtime_field uid)"
check "home $HOME_PATH created for $USER_NAME" "[ \"\$(getent passwd $USER_NAME | cut -d: -f6)\" = $HOME_PATH ] && stat -c '%U %a' $HOME_PATH"
check 'provider env and family file are 0600 owned by the user, parent dirs 0700' \
  "sudo stat -c '%n %a %U' $HOME_PATH/.devchain/host.env $HOME_PATH/.codex/auth.json $HOME_PATH/.ssh/authorized_keys $HOME_PATH/.devchain $HOME_PATH/.codex $HOME_PATH/.ssh | awk '{ok = (\$3 == \"$USER_NAME\") && ((\$2 == \"600\" && \$1 ~ /(host.env|auth.json|authorized_keys)\$/) || (\$2 == \"700\" && \$1 !~ /(host.env|auth.json|authorized_keys)\$/)); if (!ok) { print; bad = 1 } } END { exit bad }'"
check 'the claim copied the VM key and certificate 0600 to ~/.devchain/tls, and host.env points to them' \
  "sudo stat -c '%n %a %U' $HOME_PATH/.devchain/tls/key.pem $HOME_PATH/.devchain/tls/cert.pem | awk '{ if (\$2 != \"600\" || \$3 != \"$USER_NAME\") { print; bad = 1 } } END { exit bad }' && sudo cmp /etc/devchain-host/tls/key.pem $HOME_PATH/.devchain/tls/key.pem && sudo cmp /etc/devchain-host/tls/cert.pem $HOME_PATH/.devchain/tls/cert.pem && sudo grep -qx 'DEVCHAIN_HOST_TLS_CERT_FILE=\"$HOME_PATH/.devchain/tls/cert.pem\"' $HOME_PATH/.devchain/host.env && sudo grep -qx 'DEVCHAIN_HOST_TLS_KEY_FILE=\"$HOME_PATH/.devchain/tls/key.pem\"' $HOME_PATH/.devchain/host.env"
check 'no stored Claude login' "sudo test ! -e $HOME_PATH/.claude/.credentials.json"
check 'claim.json holds only user, home, version, port and timestamp' \
  "sudo python3 -c 'import json; d=json.load(open(\"/etc/devchain-host/claim.json\")); assert sorted(d) == [\"claimedAt\",\"homePath\",\"port\",\"userName\",\"version\"], d; print(d[\"version\"])'"
# The secret only reaches grep through stdin, so no command line (which sudo logs) carries it.
if printf '%s\n' "$SECRET" | on_vm 'read -r s; ! sudo journalctl --no-pager | grep -qF "$s" && ! sudo find /var/log /etc/devchain-host -type f -exec cat {} + 2>/dev/null | grep -qaF "$s"'; then
  pass 'the auth bundle appears in no log'
else
  fail 'the auth bundle appears in a log'
fi
check 'DevChain sees the provider env; no session bus variables' \
  "pid=\$(systemctl show -p MainPID --value devchain-host); env=\$(sudo cat /proc/\$pid/environ | tr '\\0' '\\n'); echo \"\$env\" | grep -qx 'E2E_PROVIDER_TOKEN=$SECRET' && ! echo \"\$env\" | grep -qE '^(DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR)='"
check 'no session bus socket for the claimed user (no PAM session for the service)' \
  "test ! -e /run/user/\$(id -u $USER_NAME)/bus"
check 'devchain-host active, bootstrap inactive, no PAMName' \
  "systemctl is-active devchain-host && ! systemctl is-active devchain-bootstrap && [ -z \"\$(systemctl show -p PAMName --value devchain-host)\" ]"

status=$(curl "${TLS[@]}" -sS -o "$WORK/root.json" -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"path":"/srv/work/demo"}' "$BASE/api/host/projects/roots")
[ "$status" = 200 ] && pass "project root created: $(cat "$WORK/root.json")" || fail "project root answered $status: $(cat "$WORK/root.json")"
check '/srv/work/demo is owned by the user' "[ \"\$(stat -c %U /srv/work/demo)\" = $USER_NAME ]"
status=$(curl "${TLS[@]}" -sS -o "$WORK/refused.json" -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"path":"/home/carol/work"}' "$BASE/api/host/projects/roots")
[ "$status" = 403 ] && pass "root under another user's home refused: $(cat "$WORK/refused.json")" ||
  fail "root under another user's home answered $status"

status=$(curl "${TLS[@]}" -sS -o "$WORK/update.json" -w '%{http_code}' -H 'content-type: application/json' \
  -d "{\"version\":\"$UPDATE_TO\"}" "$BASE/api/host/update")
[ "$status" = 202 ] && pass "update to $UPDATE_TO accepted" || fail "update answered $status: $(cat "$WORK/update.json")"
update_state() { curl "${TLS[@]}" -fsS --max-time 3 "$BASE/api/host/update" 2>/dev/null | json "(d.get('status') or {}).get('state')"; }
update_finished() { case "$(update_state 2>/dev/null)" in done | failed) return 0 ;; *) return 1 ;; esac; }
wait_for 900 update_finished || true
if [ "$(update_state)" = done ] && wait_for 120 runtime_is version "$UPDATE_TO"; then
  pass "update done; DevChain restarted on $UPDATE_TO"
else
  fail "update state $(update_state), runtime $(runtime_field version)"
  on_vm 'sudo journalctl -u devchain-host-update --no-pager | tail -n 30' || true
fi
check 'the re-written devchain-host.service still passes the TLS file paths' \
  "systemctl cat devchain-host | grep -qx 'Environment=DEVCHAIN_HOST_TLS_KEY_FILE=$HOME_PATH/.devchain/tls/key.pem' && systemctl cat devchain-host | grep -qx 'Environment=DEVCHAIN_HOST_TLS_CERT_FILE=$HOME_PATH/.devchain/tls/cert.pem'"
check "only $UPDATE_TO is installed, and devchain runs it" \
  "[ \"\$(ls /opt/devchain-host/versions)\" = $UPDATE_TO ] && [ \"\$(devchain --version)\" = $UPDATE_TO ] && [ ! -e /usr/local/lib/node_modules/devchain-cli ]"

on_vm 'sudo systemctl reboot' || true
sleep 10
if wait_for 300 runtime_is version "$UPDATE_TO"; then
  pass "after a reboot DevChain $UPDATE_TO answers on port $PORT"
else
  fail 'DevChain did not come back after a reboot'
fi
wait_for 60 on_vm true || true
[ "$(on_vm 'sudo cat /etc/devchain-host/tls/cert.pem' | sha256sum)" = "$CERT_SHA" ] &&
  pass 'after a reboot the VM keeps the certificate it had before the claim' ||
  fail 'the VM certificate changed'
check 'after a reboot the bootstrap stays inactive (claim.json exists)' \
  "! systemctl is-active devchain-bootstrap && [ \"\$(systemctl show -p ConditionResult --value devchain-bootstrap)\" = no ]"

[ "$KEEP" = no ] || echo "VM left running: ssh -i $WORK/key -p $SSH_PORT $USER_NAME@127.0.0.1; $BASE"
exit "$FAILED"

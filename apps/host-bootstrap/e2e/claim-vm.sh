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
Usage: apps/host-bootstrap/e2e/claim-vm.sh <image.qcow2> --version <v1> --update-to <v2> [--bootstrap-tgz <file>] [--keep]
EOF
}

IMAGE=''
VERSION=''
UPDATE_TO=''
KEEP=no
BOOTSTRAP_TGZ=''
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:-}; shift 2 ;;
    --update-to) UPDATE_TO=${2:-}; shift 2 ;;
    --bootstrap-tgz) BOOTSTRAP_TGZ=${2:-}; shift 2 ;;
    --keep) KEEP=yes; shift ;;
    -h | --help) usage; exit 0 ;;
    *) [ -z "$IMAGE" ] || { usage >&2; exit 2; }; IMAGE=$1; shift ;;
  esac
done
[ -f "$IMAGE" ] && [ -n "$VERSION" ] && [ -n "$UPDATE_TO" ] || { usage >&2; exit 2; }
IMAGE=$(realpath "$IMAGE")
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BOOTSTRAP_TGZ=${BOOTSTRAP_TGZ:-"$HERE/../../../dist/host-install/devchain-host-bootstrap.tgz"}
[ -f "$BOOTSTRAP_TGZ" ] || { echo 'Missing packaged bootstrap; build the CLI or supply --bootstrap-tgz' >&2; exit 2; }
umask 077

PORT=3000
USER_NAME=alice
HOME_PATH=/Users/alice
CLAIM_UID=1000
JOIN_USER=bob
JOIN_HOME=/Users/bob
ADMIN_USER=joinadmin
SECRET="e2e-secret-$RANDOM$RANDOM"
WORK=$(mktemp -d)
API_KEY_A=$(node -p "'dck_' + require('node:crypto').randomBytes(32).toString('base64url')")
API_KEY_B=$(node -p "'dck_' + require('node:crypto').randomBytes(32).toString('base64url')")
printf 'Authorization: Bearer %s\n' "$API_KEY_A" > "$WORK/header-a"
printf 'Authorization: Bearer %s\n' "$API_KEY_B" > "$WORK/header-b"
KEY_HASH_A=$(printf '%s' "$API_KEY_A" | sha256sum | cut -d' ' -f1)
KEY_HASH_B=$(printf '%s' "$API_KEY_B" | sha256sum | cut -d' ' -f1)
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
json() { python3 -c "import json,sys
try: d=json.load(sys.stdin)
except ValueError: sys.exit(1)
print($1)"; }

ssh-keygen -q -t ed25519 -N '' -f "$WORK/key"
printf '#cloud-config\nssh_authorized_keys:\n  - %s\n' "$(cat "$WORK/key.pub")" > "$WORK/user-data"
printf 'instance-id: claim-e2e-%s\nlocal-hostname: claim-e2e\n' "$$" > "$WORK/meta-data"
xorriso -as mkisofs -quiet -output "$WORK/seed.iso" -volid cidata -joliet -rock \
  "$WORK/user-data" "$WORK/meta-data" 2>/dev/null
qemu-img create -q -f qcow2 -F qcow2 -b "$IMAGE" "$WORK/disk.qcow2" 16G
SSH_PORT=$(free_port)
APP_PORT=$(free_port)
APP_PORT_B=$(free_port)
# The VM certificate names devchain-host; --resolve points that name at the forwarded port.
BASE="https://devchain-host:$APP_PORT"
TLS=(--cacert "$WORK/cert.pem" --resolve "devchain-host:$APP_PORT:127.0.0.1" --header "@$WORK/header-a")
BASE_B="https://devchain-host:$APP_PORT_B"
TLS_B=(--cacert "$WORK/cert.pem" --resolve "devchain-host:$APP_PORT_B:127.0.0.1" --header "@$WORK/header-b")
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 2 -display none \
  -serial "file:$WORK/console.log" \
  -drive "file=$WORK/disk.qcow2,if=virtio,format=qcow2" \
  -drive "file=$WORK/seed.iso,media=cdrom" \
  -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$APP_PORT-:$PORT,hostfwd=tcp:127.0.0.1:$APP_PORT_B-:3001" \
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
SSH_ADMIN=(ssh -i "$WORK/key" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=5 -o BatchMode=yes "$ADMIN_USER@127.0.0.1")
on_admin() { "${SSH_ADMIN[@]}" "$@"; }
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
runtime_b_field() { curl "${TLS_B[@]}" -fsS --max-time 3 "$BASE_B/api/runtime" 2>/dev/null | json "d.get('$1')"; }
runtime_b_is() { [ "$(runtime_b_field "$1" 2>/dev/null)" = "$2" ]; }
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
KEY_DIGEST_B64=$(printf '%s\n' "$KEY_HASH_A" | base64 -w0)
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
      { "path": "$HOME_PATH/.devchain/host-api-key", "mode": "0600", "contentBase64": "$KEY_DIGEST_B64" },
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
check 'claim.json holds identity, version, CLI pins and port without credentials' \
  "sudo python3 -c 'import json; d=json.load(open(\"/etc/devchain-host/claim.json\")); allowed={\"claimedAt\",\"homePath\",\"port\",\"userName\",\"version\",\"uid\",\"gid\",\"primaryGroup\",\"requestedUid\",\"requestedGid\",\"uidConflict\",\"cliVersions\"}; assert set(d) <= allowed; assert d[\"cliVersions\"]; print(d[\"version\"])'"
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

# The VM owner creates an unrelated sudo SSH account for the other PC.
on_vm "sudo adduser --disabled-password --gecos '' $ADMIN_USER && sudo usermod -aG sudo $ADMIN_USER && sudo install -d -m 0700 -o $ADMIN_USER -g $ADMIN_USER /home/$ADMIN_USER/.ssh && sudo cp $HOME_PATH/.ssh/authorized_keys /home/$ADMIN_USER/.ssh/authorized_keys && sudo chown $ADMIN_USER:$ADMIN_USER /home/$ADMIN_USER/.ssh/authorized_keys && sudo chmod 0600 /home/$ADMIN_USER/.ssh/authorized_keys && printf '$ADMIN_USER ALL=(ALL) NOPASSWD:ALL\\n' | sudo tee /etc/sudoers.d/devchain-e2e-admin >/dev/null && sudo chmod 0440 /etc/sudoers.d/devchain-e2e-admin && sudo visudo -cf /etc/sudoers.d/devchain-e2e-admin"
on_admin 'sudo -n true' && pass 'join uses a separate sudo SSH account' || { fail 'sudo admin SSH failed'; exit 1; }
on_admin "archive=\$(mktemp --suffix=.tgz); cat >\"\$archive\"; sudo npm install -g --prefix=/opt/devchain-host/instances/$JOIN_USER/helper --omit=dev --no-fund --no-audit --ignore-scripts \"\$archive\"; code=\$?; rm -f \"\$archive\"; exit \$code" < "$BOOTSTRAP_TGZ"
printf '{"userName":"%s","homePath":"%s","uid":1002,"gid":1002,"port":3000,"requestId":"e2e-bob-%s"}\n' "$JOIN_USER" "$JOIN_HOME" "$$" > "$WORK/join-request.json"
on_admin "sudo /opt/devchain-host/instances/$JOIN_USER/helper/bin/devchain-bootstrap --reserve-join" < "$WORK/join-request.json" > "$WORK/reservation.json"
JOIN_PORT=$(json 'd["port"]' < "$WORK/reservation.json")
[ "$JOIN_PORT" = 3001 ] && pass 'join reserves port 3001 while A keeps 3000' || { fail 'unexpected reserved join port'; exit 1; }
check 'join nonce is root-only' "[ \"\$(sudo stat -c '%u:%a' /etc/devchain-host/instances/$JOIN_USER/join.nonce)\" = 0:600 ]"
wait_for 120 runtime_b_is state unclaimed || { fail 'join bootstrap did not answer'; exit 1; }
python3 - "$WORK/reservation.json" "$WORK/claim-b.json" "$JOIN_HOME" "$VERSION" "$KEY_HASH_B" "$WORK/key.pub" <<'PY'
import base64, json, pathlib, sys
reservation = json.loads(pathlib.Path(sys.argv[1]).read_text())
home = sys.argv[3]
claim = {key: reservation[key] for key in ('userName', 'homePath', 'port', 'nonce')}
claim.update(uid=1002, gid=1002, version=sys.argv[4], providerAuth={'env': {}, 'files': [
    {'path': home + '/.devchain/host-api-key', 'mode': '0600', 'contentBase64': base64.b64encode((sys.argv[5] + '\n').encode()).decode()},
    {'path': home + '/.ssh/authorized_keys', 'mode': '0600', 'contentBase64': base64.b64encode(pathlib.Path(sys.argv[6]).read_bytes()).decode()}]})
pathlib.Path(sys.argv[2]).write_text(json.dumps(claim))
PY
status=$(curl "${TLS_B[@]}" -sS -o "$WORK/claim-b-answer.json" -w '%{http_code}' --max-time 900 \
  -H 'content-type: application/json' --data-binary "@$WORK/claim-b.json" "$BASE_B/api/host/claim")
[ "$status" = 200 ] && pass 'B claim succeeds through the nonce-bound join bootstrap' || { fail "B claim answered $status"; exit 1; }
wait_for 120 runtime_b_is version "$VERSION" && pass "B runs $VERSION on its own port" || { fail 'B never started'; exit 1; }
check 'B has its own claim and the join reservation and unit are removed' \
  "sudo test -f /etc/devchain-host/instances/$JOIN_USER/claim.json && sudo test ! -e /etc/devchain-host/instances/$JOIN_USER/join.json && sudo test ! -e /etc/devchain-host/instances/$JOIN_USER/join.nonce && ! systemctl is-active --quiet devchain-join-$JOIN_USER"
if on_admin "sudo /opt/devchain-host/instances/$JOIN_USER/helper/bin/devchain-bootstrap --reserve-join" < "$WORK/join-request.json" > "$WORK/duplicate.json" 2>&1; then
  fail 'duplicate B join was accepted'
elif grep -q "INSTANCE_EXISTS.*$JOIN_USER" "$WORK/duplicate.json"; then
  pass 'duplicate user join is refused with its name'
else
  fail 'duplicate join refusal did not identify B'
fi
if python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["nonce"])' "$WORK/reservation.json" | on_admin 'read -r n; ! sudo journalctl --no-pager | grep -qF "$n" && ! sudo find /var/log /etc/devchain-host -type f -exec cat {} + 2>/dev/null | grep -qaF "$n"'; then
  pass 'join nonce appears in no VM log or claim record'
else
  fail 'join nonce appears in a VM log or claim record'
fi

# Hash only instance artifacts: runtime databases/logs and the sibling subtree
# change during normal operation and are outside this mutation contract.
snapshot_instance() {
  on_admin "sudo python3 - '$1'" <<'PY'
import hashlib, json, os, pathlib, stat, subprocess, sys
user = sys.argv[1]
joined = user != 'alice'
etc = '/etc/devchain-host/instances/' + user if joined else '/etc/devchain-host'
root = '/opt/devchain-host/instances/' + user if joined else '/opt/devchain-host'
unit = 'devchain-user-' + user if joined else 'devchain-host'
paths = [etc + '/' + name for name in ('claim.json', 'update.json', 'docker.json')]
paths += [root + '/' + name for name in ('versions', 'current', 'bin')]
paths += [root + '/helper', root + '/clis'] if joined else ['/usr/local']
paths += ['/etc/systemd/system/' + unit + '.service', '/etc/sudoers.d/' + ('devchain-user-' + user if joined else 'devchain-host')]
def snapshot(path):
    try: info = os.lstat(path)
    except FileNotFoundError: return None
    value = {'inode': info.st_ino, 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid, 'mtime': info.st_mtime_ns}
    if stat.S_ISLNK(info.st_mode): value['target'] = os.readlink(path)
    elif stat.S_ISDIR(info.st_mode): value['children'] = {name: snapshot(path + '/' + name) for name in sorted(os.listdir(path))}
    else: value['sha256'] = hashlib.file_digest(open(path, 'rb'), 'sha256').hexdigest()
    return value
pid = subprocess.check_output(['systemctl', 'show', '-p', 'MainPID', '--value', unit], text=True).strip()
assert pid != '0'
result = {path: snapshot(path) for path in paths}
result['process'] = {'pid': pid, 'startTicks': pathlib.Path('/proc/' + pid + '/stat').read_text().split()[21]}
print(json.dumps(result, sort_keys=True))
PY
}
snapshot_instance "$JOIN_USER" > "$WORK/b-before-a-update.json"
status=$(curl "${TLS[@]}" -sS -o "$WORK/update.json" -w '%{http_code}' -H 'content-type: application/json' \
  -d "{\"version\":\"$UPDATE_TO\"}" "$BASE/api/host/update")
[ "$status" = 202 ] && pass "update to $UPDATE_TO accepted" || fail "update answered $status: $(cat "$WORK/update.json")"
update_state() { curl "${TLS[@]}" -fsS --max-time 3 "$BASE/api/host/update" 2>/dev/null | json "(d.get('status') or {}).get('state')"; }
update_finished() { case "$(update_state 2>/dev/null)" in done | failed) return 0 ;; *) return 1 ;; esac; }
wait_for 900 update_finished || true
if [ "$(update_state)" = 'done' ] && wait_for 120 runtime_is version "$UPDATE_TO"; then
  pass "update done; DevChain restarted on $UPDATE_TO"
else
  fail "update state $(update_state), runtime $(runtime_field version)"
  on_vm 'sudo journalctl -u devchain-host-update --no-pager | tail -n 30' || true
fi
check 'the re-written devchain-host.service still passes the TLS file paths' \
  "systemctl cat devchain-host | grep -qx 'Environment=DEVCHAIN_HOST_TLS_KEY_FILE=$HOME_PATH/.devchain/tls/key.pem' && systemctl cat devchain-host | grep -qx 'Environment=DEVCHAIN_HOST_TLS_CERT_FILE=$HOME_PATH/.devchain/tls/cert.pem'"
check "only $UPDATE_TO is installed, and devchain runs it" \
  "[ \"\$(ls /opt/devchain-host/versions)\" = $UPDATE_TO ] && [ \"\$(devchain --version)\" = $UPDATE_TO ] && [ ! -e /usr/local/lib/node_modules/devchain-cli ]"
snapshot_instance "$JOIN_USER" > "$WORK/b-after-a-update.json"
cmp -s "$WORK/b-before-a-update.json" "$WORK/b-after-a-update.json" && pass "A update leaves B's tree, unit, CLIs, update.json and process unchanged" || fail 'A update changed B artifacts'
[ "$(runtime_b_field version)" = "$VERSION" ] && pass 'B still serves its original version after A update' || fail 'A update changed B runtime'

snapshot_instance "$USER_NAME" > "$WORK/a-before-b-update.json"
status=$(curl "${TLS_B[@]}" -sS -o "$WORK/update-b.json" -w '%{http_code}' -H 'content-type: application/json' \
  -d "{\"version\":\"$UPDATE_TO\"}" "$BASE_B/api/host/update")
[ "$status" = 202 ] && pass 'B update accepted through its own API and helper' || fail "B update answered $status"
update_b_finished() { curl "${TLS_B[@]}" -fsS --max-time 3 "$BASE_B/api/host/update" 2>/dev/null | json "(d.get('status') or {}).get('state')" | grep -qxE 'done|failed'; }
wait_for 900 update_b_finished && wait_for 120 runtime_b_is version "$UPDATE_TO" && pass 'B update completes on its own port' || fail 'B update did not complete'
snapshot_instance "$USER_NAME" > "$WORK/a-after-b-update.json"
cmp -s "$WORK/a-before-b-update.json" "$WORK/a-after-b-update.json" && pass "B update leaves A's tree, unit, process, /usr/local CLIs and agy unchanged" || fail 'B update changed A artifacts'
check 'both instances have their own privileged Syncthing copy and valid sudoers' \
  "sudo getcap /opt/devchain-host/bin/syncthing /opt/devchain-host/instances/$JOIN_USER/bin/syncthing | awk '/cap_chown,cap_dac_override,cap_fowner=ep/ {n++} END {exit n != 2}' && sudo visudo -cf /etc/sudoers.d/devchain-host && sudo visudo -cf /etc/sudoers.d/devchain-user-$JOIN_USER"
check 'B unit uses its own refreshed helper template and TLS paths' \
  "systemctl cat devchain-user-$JOIN_USER | grep -qx 'Environment=DEVCHAIN_HOST_ETC_DIR=/etc/devchain-host/instances/$JOIN_USER' && systemctl cat devchain-user-$JOIN_USER | grep -qx 'Environment=DEVCHAIN_HOST_TLS_CERT_FILE=$JOIN_HOME/.devchain/tls/cert.pem'"

on_vm 'sudo systemctl reboot' || true
sleep 10
if wait_for 300 runtime_is version "$UPDATE_TO"; then
  pass "after a reboot DevChain $UPDATE_TO answers on port $PORT"
else
  fail 'DevChain did not come back after a reboot'
fi
wait_for 60 on_vm true || true
wait_for 300 runtime_b_is version "$UPDATE_TO" && pass "after a reboot B answers on port $JOIN_PORT" || fail 'B did not start after reboot'
[ "$(on_vm 'sudo cat /etc/devchain-host/tls/cert.pem' | sha256sum)" = "$CERT_SHA" ] &&
  pass 'after a reboot the VM keeps the certificate it had before the claim' ||
  fail 'the VM certificate changed'
check 'both user TLS copies retain the VM certificate after reboot' \
  "sudo cmp /etc/devchain-host/tls/cert.pem $HOME_PATH/.devchain/tls/cert.pem && sudo cmp /etc/devchain-host/tls/cert.pem $JOIN_HOME/.devchain/tls/cert.pem && systemctl is-active devchain-host devchain-user-$JOIN_USER"
check 'after a reboot the bootstrap stays inactive (claim.json exists)' \
  "! systemctl is-active devchain-bootstrap && [ \"\$(systemctl show -p ConditionResult --value devchain-bootstrap)\" = no ]"

[ "$KEEP" = no ] || echo "VM left running: ssh -i $WORK/key -p $SSH_PORT $USER_NAME@127.0.0.1; $BASE"
exit "$FAILED"

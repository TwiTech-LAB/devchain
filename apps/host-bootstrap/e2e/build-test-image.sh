#!/usr/bin/env bash
# Runs the image's existing customization in a disposable KVM guest when the
# build host cannot install libguestfs. The output is for local tests only.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
OUT=${1:?Usage: build-test-image.sh <output.qcow2>}
OUT=$(realpath -m "$OUT")
[ ! -e "$OUT" ] || { echo "$OUT already exists" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
for tool in qemu-system-x86_64 qemu-img xorriso curl python3 npm; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 2; }
done
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  [ -n "${!key+set}" ] || export "$key=$value"
done < "$REPO/apps/host-image/versions.env"
export IMAGE_VERSION=${IMAGE_VERSION:-1.4.0}
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export BUILT_AT
export BOOTSTRAP_PACKAGE=devchain-host-bootstrap
CACHE="$REPO/apps/host-image/.cache"
mkdir -p "$CACHE"
BASE="$CACHE/ubuntu-24.04-minimal-cloudimg-amd64-$UBUNTU_SERIAL.img"
URL="https://cloud-images.ubuntu.com/minimal/releases/noble/release-$UBUNTU_SERIAL"
published=$(curl -fsSL "$URL/SHA256SUMS" | awk '$2 == "*ubuntu-24.04-minimal-cloudimg-amd64.img" { print $1 }')
[ "$published" = "$UBUNTU_IMAGE_SHA256" ] || { echo 'Pinned Ubuntu SHA mismatch' >&2; exit 1; }
if [ ! -f "$BASE" ] || [ "$(sha256sum "$BASE" | cut -d' ' -f1)" != "$UBUNTU_IMAGE_SHA256" ]; then
  curl -fsSL -o "$BASE.part" "$URL/ubuntu-24.04-minimal-cloudimg-amd64.img"
  mv "$BASE.part" "$BASE"
fi
[ "$(sha256sum "$BASE" | cut -d' ' -f1)" = "$UBUNTU_IMAGE_SHA256" ]
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/devchain-image"
mkdir -p "$STAGE"
cp "$REPO/apps/host-image/files/"* "$STAGE/"
archive=$(cd "$REPO/apps/host-bootstrap" && npm pack --silent --pack-destination "$STAGE")
mv "$STAGE/$archive" "$STAGE/devchain-host-bootstrap.tgz"
cp "$REPO/apps/host-bootstrap/systemd/devchain-bootstrap.service" "$STAGE/"
{
  echo '#!/bin/bash'
  for key in IMAGE_VERSION UBUNTU_SERIAL UBUNTU_IMAGE_SHA256 NODE_VERSION SYNCTHING_VERSION \
    AST_GREP_VERSION NPM_REGISTRY BOOTSTRAP_PACKAGE DEVCHAIN_REQUIRED_PACKAGES DEVCHAIN_TOOL_PACKAGES BUILT_AT; do
    printf 'export %s=%q\n' "$key" "${!key}"
  done
  cat "$REPO/apps/host-image/customize.sh"
} > "$STAGE/customize-run.sh"
python3 - "$STAGE" "$WORK/user-data" <<'PY'
import base64, json, pathlib, sys
stage, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
files = [{'path': '/tmp/devchain-image/' + file.name, 'permissions': '0644',
          'encoding': 'b64', 'content': base64.b64encode(file.read_bytes()).decode()}
         for file in stage.iterdir()]
# Disabling default users keeps uid 1000 free, as the published image does.
config = {'users': [], 'ssh_pwauth': False, 'write_files': files,
          'runcmd': [['bash', '-c', 'bash /tmp/devchain-image/customize-run.sh && '
                     "printf 'DEVCHAIN_TEST_IMAGE_READY\\n' >/dev/ttyS0 && systemctl poweroff"]]}
output.write_text('#cloud-config\n' + json.dumps(config))
PY
printf 'instance-id: build-test-image-%s\nlocal-hostname: devchain-image\n' "$$" > "$WORK/meta-data"
xorriso -as mkisofs -quiet -output "$WORK/seed.iso" -volid cidata -joliet -rock \
  "$WORK/user-data" "$WORK/meta-data" 2>/dev/null
qemu-img create -q -f qcow2 -F qcow2 -b "$BASE" "$WORK/disk.qcow2" 16G
printf 'Preparing test image with pinned customization; console: %s.console.log\n' "$OUT"
timeout 1800 qemu-system-x86_64 -enable-kvm -cpu host -m 3072 -smp 2 -display none \
  -serial "file:$OUT.console.log" -no-reboot \
  -drive "file=$WORK/disk.qcow2,if=virtio,format=qcow2" \
  -drive "file=$WORK/seed.iso,media=cdrom" \
  -netdev user,id=n0 -device virtio-net-pci,netdev=n0
grep -q '^DEVCHAIN_TEST_IMAGE_READY' "$OUT.console.log" || {
  tail -n 40 "$OUT.console.log" >&2; exit 1;
}
# Flatten the overlay so its base and cloud-init seed are not test dependencies.
qemu-img convert -q -O qcow2 "$WORK/disk.qcow2" "$OUT"
printf 'Prepared %s\n' "$OUT"

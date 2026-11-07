#!/usr/bin/env bash
# Builds the DevChain host image from the pinned Ubuntu 24.04 cloud image.
# Output: <out>/devchain-host-<version>.qcow2, its .sha256 and manifest.json.
# See README.md for the build-host prerequisites and the publication layout.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)

usage() {
  cat <<'EOF'
Usage: apps/host-image/build.sh --version <image-version> [options]

  --version <v>          Image version, e.g. 1.0.0 (names the output files)
  --out <dir>            Output directory (default: apps/host-image/out/<version>)
  --cache <dir>          Download cache for the base image (default: apps/host-image/.cache)
  --without-bootstrap    Build without apps/host-bootstrap; the image boots but cannot be claimed
  -h, --help             Show this help

Pinned inputs come from apps/host-image/versions.env; an environment variable
of the same name overrides a pin for one build. BOOTSTRAP_DIR overrides the
bootstrap package directory (default apps/host-bootstrap).
EOF
}

die() {
  printf 'build.sh: %s\n' "$*" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$*"; }

IMAGE_VERSION=''
OUT_DIR=''
CACHE_DIR="$HERE/.cache"
WITH_BOOTSTRAP=yes
while [ $# -gt 0 ]; do
  case "$1" in
    --version) IMAGE_VERSION=${2:-}; shift 2 ;;
    --out) OUT_DIR=${2:-}; shift 2 ;;
    --cache) CACHE_DIR=${2:-}; shift 2 ;;
    --without-bootstrap) WITH_BOOTSTRAP=no; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[ -n "$IMAGE_VERSION" ] || { usage >&2; die '--version is required'; }
[[ "$IMAGE_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || die "invalid version: $IMAGE_VERSION"
OUT_DIR=${OUT_DIR:-"$HERE/out/$IMAGE_VERSION"}

# Pins from versions.env, unless the environment already sets them.
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  [ -n "${!key+set}" ] || export "$key=$value"
done < "$HERE/versions.env"

for tool in curl sha256sum python3 qemu-img guestfish virt-customize virt-sparsify virt-cat; do
  command -v "$tool" >/dev/null || die "missing build tool: $tool (see README.md)"
done
if [ "$WITH_BOOTSTRAP" = yes ]; then
  command -v npm >/dev/null || die 'missing build tool: npm'
  BOOTSTRAP_DIR=${BOOTSTRAP_DIR:-"$REPO/apps/host-bootstrap"}
  [ -f "$BOOTSTRAP_DIR/package.json" ] ||
    die "$BOOTSTRAP_DIR/package.json is missing; use --without-bootstrap for an image that cannot be claimed"
  [ -f "$BOOTSTRAP_DIR/systemd/devchain-bootstrap.service" ] ||
    die "$BOOTSTRAP_DIR/systemd/devchain-bootstrap.service is missing"
fi

NAME="devchain-host-$IMAGE_VERSION"
QCOW2="$OUT_DIR/$NAME.qcow2"
[ -e "$QCOW2" ] && die "$QCOW2 exists; remove it or choose another version"
mkdir -p "$OUT_DIR" "$CACHE_DIR"
WORK=$(mktemp -d "$OUT_DIR/.work-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

step "Base image: Ubuntu 24.04 minimal cloud image, serial $UBUNTU_SERIAL"
BASE_URL="https://cloud-images.ubuntu.com/minimal/releases/noble/release-$UBUNTU_SERIAL"
BASE="$CACHE_DIR/ubuntu-24.04-minimal-cloudimg-amd64-$UBUNTU_SERIAL.img"
published=$(curl -fsSL "$BASE_URL/SHA256SUMS" | awk '$2 == "*ubuntu-24.04-minimal-cloudimg-amd64.img" { print $1 }')
[ "$published" = "$UBUNTU_IMAGE_SHA256" ] ||
  die "SHA256SUMS for $UBUNTU_SERIAL lists ${published:-nothing}, versions.env pins $UBUNTU_IMAGE_SHA256"
if [ ! -f "$BASE" ] || [ "$(sha256sum "$BASE" | cut -d' ' -f1)" != "$UBUNTU_IMAGE_SHA256" ]; then
  curl -fL --progress-bar -o "$BASE.part" "$BASE_URL/ubuntu-24.04-minimal-cloudimg-amd64.img"
  mv "$BASE.part" "$BASE"
fi
actual=$(sha256sum "$BASE" | cut -d' ' -f1)
[ "$actual" = "$UBUNTU_IMAGE_SHA256" ] || die "base image checksum $actual does not match $UBUNTU_IMAGE_SHA256"
echo "verified sha256 $actual"

step "Resize to $DISK_SIZE"
# The root partition (sda1) is the last one on the disk, so it grows in place.
# Moving partitions (virt-resize) would break BIOS boot: GRUB's boot sector
# holds the sector address of its core image in the BIOS boot partition.
qemu-img convert -O qcow2 "$BASE" "$WORK/disk.qcow2"
qemu-img resize -q "$WORK/disk.qcow2" "$DISK_SIZE"
sectors=$(qemu-img info --output=json "$WORK/disk.qcow2" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["virtual-size"] // 512)')
# The last usable sector leaves room for the backup GPT (33 sectors).
guestfish --format=qcow2 -a "$WORK/disk.qcow2" <<GUESTFISH
run
part-expand-gpt /dev/sda
part-resize /dev/sda 1 $((sectors - 34))
e2fsck-f /dev/sda1
resize2fs /dev/sda1
GUESTFISH

STAGE="$WORK/devchain-image"
mkdir -p "$STAGE"
cp "$HERE"/files/* "$STAGE/"
if [ "$WITH_BOOTSTRAP" = yes ]; then
  step "Pack $BOOTSTRAP_DIR"
  tarball=$(cd "$BOOTSTRAP_DIR" && npm pack --silent --pack-destination "$WORK")
  mv "$WORK/$tarball" "$STAGE/devchain-host-bootstrap.tgz"
  cp "$BOOTSTRAP_DIR/systemd/devchain-bootstrap.service" "$STAGE/"
  BOOTSTRAP_PACKAGE=$(cd "$BOOTSTRAP_DIR" && node -p "require('./package.json').name")
else
  BOOTSTRAP_PACKAGE=''
fi

{
  echo '#!/bin/bash'
  for key in IMAGE_VERSION UBUNTU_SERIAL UBUNTU_IMAGE_SHA256 NODE_VERSION SYNCTHING_VERSION \
    AST_GREP_VERSION NPM_REGISTRY BOOTSTRAP_PACKAGE DEVCHAIN_REQUIRED_PACKAGES DEVCHAIN_TOOL_PACKAGES; do
    printf 'export %s=%q\n' "$key" "${!key}"
  done
  printf 'export BUILT_AT=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat "$HERE/customize.sh"
} > "$STAGE/customize-run.sh"

step 'Customize (offline, libguestfs appliance with network)'
virt-customize --format=qcow2 -a "$WORK/disk.qcow2" \
  --memsize 3072 --smp 2 --network \
  --copy-in "$STAGE:/tmp" \
  --run-command 'bash /tmp/devchain-image/customize-run.sh'

virt-cat --format=qcow2 -a "$WORK/disk.qcow2" /usr/share/devchain-host/manifest.json > "$WORK/manifest.json"

step 'Sparsify and compress'
virt-sparsify --quiet --format=qcow2 --in-place "$WORK/disk.qcow2"
qemu-img convert -q -c -O qcow2 "$WORK/disk.qcow2" "$QCOW2.part"
mv "$QCOW2.part" "$QCOW2"
(cd "$OUT_DIR" && sha256sum "$NAME.qcow2" > "$NAME.qcow2.sha256")

python3 - "$WORK/manifest.json" "$OUT_DIR" "$NAME.qcow2" "$DISK_SIZE" <<'EOF'
import json, os, sys
manifest_path, out_dir, file_name, disk_size = sys.argv[1:]
with open(manifest_path) as f:
    manifest = json.load(f)
with open(os.path.join(out_dir, file_name + '.sha256')) as f:
    sha256 = f.read().split()[0]
manifest['artifact'] = {
    'file': file_name,
    'sha256': sha256,
    'bytes': os.path.getsize(os.path.join(out_dir, file_name)),
    'virtualSize': disk_size,
}
with open(os.path.join(out_dir, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
EOF

step 'Done'
ls -l "$OUT_DIR"

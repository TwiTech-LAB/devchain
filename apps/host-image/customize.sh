# Runs as root inside the image, started by virt-customize with bash. build.sh
# prepends the pinned versions (versions.env) and IMAGE_VERSION, and uploads
# the files this script moves into place to /tmp/devchain-image/ first.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# The appliance's PATH lacks /usr/local, where Node.js and the CLIs go.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
STAGE=/tmp/devchain-image

step() { printf '==> %s\n' "$*"; }

if ! getent hosts nodejs.org >/dev/null; then
  echo 'The libguestfs appliance has no network; see "Build" in apps/host-image/README.md' >&2
  exit 1
fi

step 'Headless guard: never install a user-session bus or a keyring'
install -m 0644 "$STAGE/devchain-no-session-bus.pref" /etc/apt/preferences.d/devchain-no-session-bus.pref
# snapd requires a session bus provider, so it leaves with dbus-user-session.
installed=$({ dpkg-query -W -f='${Package} ${db:Status-Status}\n' \
  dbus-user-session dbus-x11 gnome-keyring snapd 2>/dev/null || true; } | awk '$2 == "installed" { print $1 }')
if [ -n "$installed" ]; then
  # shellcheck disable=SC2086
  apt-get purge -y $installed
fi
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd

step 'System packages'
apt-get update
apt-get install -y --no-install-recommends \
  qemu-guest-agent tmux git curl ca-certificates xz-utils build-essential python3 \
  jq ripgrep python-is-python3 python3-pip python3-venv file sqlite3 bsdextrautils rsync unzip openssl
# The unit has no [Install] section: udev starts it when the hypervisor
# exposes the guest agent's virtio port.
systemctl enable qemu-guest-agent 2>/dev/null || true

step "Node.js ${NODE_VERSION}"
node_tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLo "/tmp/${node_tarball}" "https://nodejs.org/dist/v${NODE_VERSION}/${node_tarball}"
curl -fsSLo /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd /tmp && grep " ${node_tarball}\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "/tmp/${node_tarball}" -C /usr/local --strip-components=1 --no-same-owner \
  --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
rm -f "/tmp/${node_tarball}" /tmp/SHASUMS256.txt

step "Syncthing ${SYNCTHING_VERSION}"
install -m 0755 -d /etc/apt/keyrings
curl -fsSLo /etc/apt/keyrings/syncthing-archive-keyring.gpg https://syncthing.net/release-key.gpg
echo 'deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable-v2' \
  > /etc/apt/sources.list.d/syncthing.list
apt-get update
apt-get install -y --no-install-recommends "syncthing=${SYNCTHING_VERSION}"

step 'Kernel, SSH and cloud-init settings'
install -m 0644 "$STAGE/60-devchain-inotify.conf" /etc/sysctl.d/60-devchain-inotify.conf
install -m 0644 "$STAGE/01-devchain-no-passwords.conf" /etc/ssh/sshd_config.d/01-devchain-no-passwords.conf
install -m 0644 "$STAGE/90-devchain.cfg" /etc/cloud/cloud.cfg.d/90-devchain.cfg

if [ -n "${BOOTSTRAP_PACKAGE}" ]; then
  step 'Bootstrap service'
  npm install -g --omit=dev --no-fund --no-audit "$STAGE/devchain-host-bootstrap.tgz"
  install -m 0644 "$STAGE/devchain-bootstrap.service" /etc/systemd/system/devchain-bootstrap.service
  systemctl enable devchain-bootstrap.service
fi

step 'Verify and record versions'
dpkg_version() { dpkg-query -W -f='${Version}' "$1"; }
first_line() { "$@" 2>&1 | head -n 1; }
export M_QGA=$(dpkg_version qemu-guest-agent) M_TMUX=$(dpkg_version tmux) M_GIT=$(dpkg_version git)
export M_CURL=$(dpkg_version curl) M_BUILD=$(dpkg_version build-essential) M_PY=$(dpkg_version python3)
export M_CA_CERTIFICATES=$(dpkg_version ca-certificates) M_XZ=$(dpkg_version xz-utils)
export M_SYNCTHING=$(dpkg_version syncthing)
export M_NODE=$(node --version) M_NPM=$(npm --version)
export M_ST_CLI=$(first_line syncthing --version)
export M_BOOTSTRAP=''
if [ -n "${BOOTSTRAP_PACKAGE}" ]; then
  M_BOOTSTRAP=$(node -p "require('/usr/local/lib/node_modules/${BOOTSTRAP_PACKAGE}/package.json').version")
fi
if { dpkg-query -W -f='${db:Status-Status}\n' dbus-user-session dbus-x11 gnome-keyring 2>/dev/null || true; } |
  grep -qx installed; then
  echo 'A session bus or keyring package is installed' >&2
  exit 1
fi
# Each VM creates its own certificate at first boot; a baked one would be shared by every clone.
if [ -e /etc/devchain-host/tls ]; then
  echo 'The image contains /etc/devchain-host/tls' >&2
  exit 1
fi
install -m 0755 -d /usr/share/devchain-host
node - <<'EOF' > /usr/share/devchain-host/manifest.json
const e = process.env;
const manifest = {
  schemaVersion: 1,
  imageVersion: e.IMAGE_VERSION,
  builtAt: e.BUILT_AT,
  arch: 'amd64',
  base: {
    name: 'ubuntu-24.04-minimal-cloudimg-amd64',
    serial: e.UBUNTU_SERIAL,
    sha256: e.UBUNTU_IMAGE_SHA256,
  },
  npmRegistry: e.NPM_REGISTRY,
  bootstrap: e.M_BOOTSTRAP ? { package: e.BOOTSTRAP_PACKAGE, version: e.M_BOOTSTRAP } : null,
  packages: {
    'qemu-guest-agent': e.M_QGA,
    tmux: e.M_TMUX,
    git: e.M_GIT,
    curl: e.M_CURL,
    'build-essential': e.M_BUILD,
    python3: e.M_PY,
    'ca-certificates': e.M_CA_CERTIFICATES,
    'xz-utils': e.M_XZ,
    syncthing: e.M_SYNCTHING,
  },
  runtimes: { node: e.M_NODE.replace(/^v/, ''), npm: e.M_NPM },
  syncthingCli: e.M_ST_CLI,
};
process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
EOF
cat /usr/share/devchain-host/manifest.json

step 'Clean up'
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /root/.gemini /root/.config /root/.local \
  /tmp/* /var/tmp/*
# Each clone generates its own identity at first boot.
truncate -s 0 /etc/machine-id
rm -f /etc/ssh/ssh_host_*
cloud-init clean --logs

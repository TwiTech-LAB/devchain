export const HOST_INSTALL_BOOTSTRAP_PORT = 3000;
/** The certificate the VM's bootstrap creates and serves; DevChain serves the same one after the claim. */
export const HOST_CERTIFICATE_PATH = '/etc/devchain-host/tls/cert.pem';
/** Prints the VM certificate's SHA-256 fingerprint on the VM; no sudo needed. */
export const HOST_CERTIFICATE_FINGERPRINT_COMMAND = `openssl x509 -in ${HOST_CERTIFICATE_PATH} -noout -fingerprint -sha256`;
export const HOST_INSTALL_MIN_MEMORY_MIB = 3584;

export interface HostInstallPins {
  nodeVersion: string;
  syncthingVersion: string;
  npmRegistry: string;
  bootstrap: {
    package: string;
    version: string;
    sha256: string;
  };
  aptPackages: string[];
}

export interface HostInstallBlockOptions {
  pins: HostInstallPins;
  bootstrapTgzBase64: string;
  bootstrapUnit: string;
  sysctlConfig: string;
  aptPreference: string;
  minDiskGib: number;
  homePort: number;
  imageVersion: string;
  homeUser: string;
  homePath: string;
  devchainVersion: string;
  checkOnly?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertNonEmpty(name: string, value: string): void {
  if (!value || value.includes('\0')) throw new Error(`${name} must be a non-empty string`);
}

export function baseHostInstallAptPackages(pins: HostInstallPins): string[] {
  return pins.aptPackages.filter((name) => name !== 'qemu-guest-agent');
}

export function generateHostInstallBlock(options: HostInstallBlockOptions): string {
  const { pins } = options;
  for (const [name, value] of [
    ['nodeVersion', pins.nodeVersion],
    ['syncthingVersion', pins.syncthingVersion],
    ['npmRegistry', pins.npmRegistry],
    ['bootstrap.package', pins.bootstrap.package],
    ['bootstrap.version', pins.bootstrap.version],
    ['bootstrapTgzBase64', options.bootstrapTgzBase64],
    ['bootstrapUnit', options.bootstrapUnit],
    ['sysctlConfig', options.sysctlConfig],
    ['aptPreference', options.aptPreference],
    ['imageVersion', options.imageVersion],
    ['homeUser', options.homeUser],
    ['homePath', options.homePath],
    ['devchainVersion', options.devchainVersion],
  ] as const) {
    assertNonEmpty(name, value);
  }
  if (!/^[a-f0-9]{64}$/.test(pins.bootstrap.sha256)) {
    throw new Error('bootstrap.sha256 must be a lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(options.minDiskGib) || options.minDiskGib < 1) {
    throw new Error('minDiskGib must be a positive integer');
  }
  if (!Number.isSafeInteger(options.homePort) || options.homePort < 1 || options.homePort > 65535) {
    throw new Error('homePort must be an integer between 1 and 65535');
  }

  const aptPackages = baseHostInstallAptPackages(pins);
  if (
    aptPackages.length === 0 ||
    aptPackages.some((name) => !/^[a-z0-9][a-z0-9+.-]*$/.test(name))
  ) {
    throw new Error('aptPackages must contain valid Debian package names');
  }

  const quotedAptPackages = aptPackages.map(shellQuote).join(' ');
  const invocation = options.checkOnly ? 'devchain_host_install --check' : 'devchain_host_install';

  return `# DevChain host installer. Run only on a dedicated LAN or VPN VM.
DEVCHAIN_NODE_VERSION=${shellQuote(pins.nodeVersion)}
DEVCHAIN_SYNCTHING_VERSION=${shellQuote(pins.syncthingVersion)}
DEVCHAIN_NPM_REGISTRY=${shellQuote(pins.npmRegistry)}
DEVCHAIN_BOOTSTRAP_PACKAGE=${shellQuote(pins.bootstrap.package)}
DEVCHAIN_BOOTSTRAP_VERSION=${shellQuote(pins.bootstrap.version)}
DEVCHAIN_BOOTSTRAP_SHA256=${shellQuote(pins.bootstrap.sha256)}
DEVCHAIN_BOOTSTRAP_TGZ_BASE64=${shellQuote(options.bootstrapTgzBase64)}
DEVCHAIN_BOOTSTRAP_UNIT=${shellQuote(options.bootstrapUnit)}
DEVCHAIN_SYSCTL_CONFIG=${shellQuote(options.sysctlConfig)}
DEVCHAIN_APT_PREFERENCE=${shellQuote(options.aptPreference)}
DEVCHAIN_MIN_DISK_GIB=${options.minDiskGib}
DEVCHAIN_HOME_PORT=${options.homePort}
DEVCHAIN_IMAGE_VERSION=${shellQuote(options.imageVersion)}
DEVCHAIN_HOME_USER=${shellQuote(options.homeUser)}
DEVCHAIN_HOME_PATH=${shellQuote(options.homePath)}
DEVCHAIN_VERSION=${shellQuote(options.devchainVersion)}
DEVCHAIN_BOOTSTRAP_PORT=${HOST_INSTALL_BOOTSTRAP_PORT}
DEVCHAIN_CERT_PATH=${shellQuote(HOST_CERTIFICATE_PATH)}
DEVCHAIN_FINGERPRINT_COMMAND=${shellQuote(HOST_CERTIFICATE_FINGERPRINT_COMMAND)}
DEVCHAIN_BASE_APT_PACKAGES=(${quotedAptPackages})

devchain_host_install() {
  (
  set -Eeuo pipefail
  local root="\${DEVCHAIN_HOST_INSTALL_ROOT:-}" check=0 arg
  root="\${root%/}"
  if [[ -n "$root" ]]; then
    export PATH="\${DEVCHAIN_HOST_INSTALL_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
  else
    export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  fi
  export HOME="\${HOME:-/root}"
  for arg in "$@"; do
    case "$arg" in
      --check) check=1 ;;
      *) printf 'Usage: devchain_host_install [--check]\\n' >&2; return 2 ;;
    esac
  done

  devchain_path() { printf '%s%s' "$root" "$1"; }
  local failures=0
  devchain_fail() { printf 'ERROR: %s\\n' "$*" >&2; failures=$((failures + 1)); return 0; }
  devchain_warn() { printf 'WARNING: %s\\n' "$*" >&2; }

  local effective_uid="$EUID"
  if [[ -n "$root" && -n "\${DEVCHAIN_HOST_INSTALL_EUID:-}" ]]; then
    effective_uid="$DEVCHAIN_HOST_INSTALL_EUID"
  fi
  if [[ "$effective_uid" -ne 0 ]]; then
    devchain_fail 'This installer must run as root; run with sudo.'
  fi

  local pid1=''
  if [[ -r "$(devchain_path /proc/1/comm)" ]]; then
    pid1="$(tr -d '\\n' < "$(devchain_path /proc/1/comm)")"
  fi
  if [[ "$pid1" != systemd ]]; then
    devchain_fail 'systemd must be PID 1.'
  fi

  local os_file id='' version_id='' major=0 minor=0
  os_file="$(devchain_path /etc/os-release)"
  if [[ -r "$os_file" ]]; then
    id="$(grep -m1 '^ID=' "$os_file" 2>/dev/null | sed 's/^ID=//;s/^"//;s/"$//' || true)"
    version_id="$(grep -m1 '^VERSION_ID=' "$os_file" 2>/dev/null | sed 's/^VERSION_ID=//;s/^"//;s/"$//' || true)"
  fi
  if [[ "$version_id" =~ ^([0-9]+)(\\.([0-9]+))? ]]; then
    major=$((10#\${BASH_REMATCH[1]}))
    if [[ -n "\${BASH_REMATCH[3]:-}" ]]; then minor=$((10#\${BASH_REMATCH[3]})); fi
  fi
  if [[ "$id" == ubuntu ]]; then
    if (( major < 22 || (major == 22 && minor < 4) )); then
      devchain_fail 'Ubuntu 22.04 or newer is required.'
    fi
    if (( major % 2 != 0 || minor != 4 )); then
      devchain_warn "Ubuntu $version_id is not an LTS release; an even-year YY.04 release is recommended."
    fi
  elif [[ "$id" == debian ]]; then
    if (( major < 12 )); then devchain_fail 'Debian 12 or newer is required.'; fi
  else
    devchain_fail 'Only Ubuntu 22.04 or newer and Debian 12 or newer are supported.'
  fi

  if command -v dpkg >/dev/null 2>&1; then
    local architecture
    architecture="$(dpkg --print-architecture 2>/dev/null || true)"
    if [[ "$architecture" != amd64 ]]; then devchain_fail 'The VM architecture must be amd64.'; fi
  fi

  # measured against the pinned CLI binaries
  local required_cpu_flags='cx16 pni ssse3 sse4_1 sse4_2 popcnt pclmulqdq'
  local cpu_file cpu_flags='' missing_flags='' flag processors=0
  cpu_file="$(devchain_path /proc/cpuinfo)"
  if [[ -r "$cpu_file" ]]; then
    cpu_flags="$(awk '/^flags[[:space:]]*:/ { $1=""; $2=""; print; exit }' "$cpu_file")"
    processors="$(awk '/^processor[[:space:]]*:/ { n++ } END { print n+0 }' "$cpu_file")"
  fi
  for flag in $required_cpu_flags; do
    if [[ " $cpu_flags " != *" $flag "* ]]; then missing_flags+=" $flag"; fi
  done
  if [[ -n "$missing_flags" ]]; then
    devchain_fail "The VM CPU lacks \${missing_flags# }. Claude Code, OpenCode and Antigravity need them. Set the VM CPU type to host (or a CPU model with these flags) in the hypervisor, then shut down and start the VM."
  fi
  if (( processors < 2 )); then
    devchain_warn "The VM has $processors vCPU. 2 or more are recommended for agent sessions."
  fi

  if [[ -e "$(devchain_path /etc/devchain-host/claim.json)" ]]; then
    devchain_fail 'This VM is already a claimed DevChain host.'
  fi
  local manifest_path
  manifest_path="$(devchain_path /usr/share/devchain-host/manifest.json)"
  if [[ -e "$manifest_path" ]] && ! grep -Eq '"install"[[:space:]]*:' "$manifest_path"; then
    devchain_fail 'This VM was created from a DevChain host image; use a fresh VM.'
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled --quiet display-manager.service 2>/dev/null; then
    devchain_fail 'A display manager is enabled; use a dedicated headless VM.'
  fi
  if command -v dpkg-query >/dev/null 2>&1; then
    local desktop_packages
    desktop_packages="$({ dpkg-query -W -f='\${Package} \${db:Status-Status}\\n' ubuntu-desktop gnome-shell 2>/dev/null || true; } | awk '$2 == "installed" { print $1 }')"
    if [[ -n "$desktop_packages" ]]; then
      devchain_fail "Desktop packages are installed ($desktop_packages); use a dedicated headless VM."
    fi
  fi

  local mem_kib=0
  if [[ -r "$(devchain_path /proc/meminfo)" ]]; then
    mem_kib="$(awk '$1 == "MemTotal:" { print $2 }' "$(devchain_path /proc/meminfo)")"
  fi
  if [[ ! "$mem_kib" =~ ^[0-9]+$ ]] || (( mem_kib < ${HOST_INSTALL_MIN_MEMORY_MIB} * 1024 )); then
    [[ "$mem_kib" =~ ^[0-9]+$ ]] || mem_kib=0
    devchain_fail "At least 3584 MiB of memory is required; found $((mem_kib / 1024)) MiB."
  fi

  local free_kib=0
  free_kib="$(df -Pk "$(devchain_path /)" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)"
  if [[ ! "$free_kib" =~ ^[0-9]+$ ]] || (( free_kib < DEVCHAIN_MIN_DISK_GIB * 1024 * 1024 )); then
    [[ "$free_kib" =~ ^[0-9]+$ ]] || free_kib=0
    local disk_error root_source lv_path='' vg_name='' vg_free='' vg_number=''
    disk_error="At least $DEVCHAIN_MIN_DISK_GIB GiB of free space is required on /; found $((free_kib / 1024 / 1024)) GiB free."
    root_source="$(findmnt -no SOURCE / 2>/dev/null || true)"
    if [[ -n "$root_source" ]]; then
      read -r lv_path vg_name vg_free <<< "$(lvs --noheadings --nosuffix --units g -o lv_path,vg_name,vg_free "$root_source" 2>/dev/null || true)" || true
      vg_number="\${vg_free#<}"
      if [[ -n "$lv_path" && -n "$vg_name" && "$vg_number" =~ ^[0-9]+(\\.[0-9]+)?$ ]] &&
          awk -v free="$vg_number" -v bound="\${vg_free:0:1}" 'BEGIN { exit !(free > 1 || (free == 1 && bound != "<")) }'; then
        disk_error+=" Volume group $vg_name has $vg_free GiB unused. Run: sudo lvextend -r -l +100%FREE $lv_path"
      fi
    fi
    devchain_fail "$disk_error"
  fi

  local listeners=''
  if command -v ss >/dev/null 2>&1; then listeners="$(ss -ltnH 2>/dev/null || true)"; fi
  local port
  for port in "$DEVCHAIN_BOOTSTRAP_PORT" "$DEVCHAIN_HOME_PORT"; do
    if awk -v wanted="$port" '{ address=$4; sub(/^.*:/, "", address); if (address == wanted) found=1 } END { print found ? "busy" : "free" }' <<< "$listeners" | grep -q '^busy$'; then
      # our own unclaimed bootstrap holds the port after a failed claim or a cancelled install
      if [[ "$port" == "$DEVCHAIN_BOOTSTRAP_PORT" && ! -e "$(devchain_path /etc/devchain-host/claim.json)" ]] &&
          [[ -e "$manifest_path" ]] && grep -Eq '"install"[[:space:]]*:' "$manifest_path"; then
        # an installer from before TLS has no certificate; this block replaces it once it stops
        if [[ ! -e "$(devchain_path "$DEVCHAIN_CERT_PATH")" ]]; then
          devchain_fail "An older DevChain installer is running on this VM. Stop it with: sudo systemctl disable --now devchain-bootstrap.service. Then run this install again."
        else
          devchain_fail "DevChain is already installed on this VM but not claimed. Choose “Set up a new VM” on the Cloud page and enter this VM's address to claim it. Setup asks for the certificate fingerprint; print it with: $DEVCHAIN_FINGERPRINT_COMMAND"
        fi
      else
        devchain_fail "TCP port $port is already listening."
      fi
    fi
    if [[ "$DEVCHAIN_HOME_PORT" == "$DEVCHAIN_BOOTSTRAP_PORT" ]]; then break; fi
  done

  local tool
  for tool in curl apt-get dpkg tar xz systemctl systemd-run ss useradd visudo getent id sudo; do
    if ! command -v "$tool" >/dev/null 2>&1; then devchain_fail "Required command is missing: $tool"; fi
  done
  if [[ ! -d "$(devchain_path /etc/sudoers.d)" ]]; then
    devchain_fail '/etc/sudoers.d is missing.'
  fi

  if command -v curl >/dev/null 2>&1; then
    local url
    for url in \
      'https://nodejs.org/' \
      'https://syncthing.net/' \
      'https://apt.syncthing.net/' \
      "$DEVCHAIN_NPM_REGISTRY" \
      'https://antigravity.google/'; do
      if ! curl -fsSI --max-time 10 "$url" >/dev/null; then
        devchain_fail "Cannot reach $url"
      fi
    done
    local version_url status
    version_url="\${DEVCHAIN_NPM_REGISTRY%/}/devchain-cli/$DEVCHAIN_VERSION"
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$version_url" 2>/dev/null || true)"
    status="\${status:-000}"
    case "$status" in
      200) ;;
      404) devchain_fail "The npm registry $DEVCHAIN_NPM_REGISTRY has no devchain-cli $DEVCHAIN_VERSION. Publish it there, or start DevChain on this PC with HOST_NPM_REGISTRY set to a registry that has it." ;;
      *) devchain_fail "Could not verify devchain-cli $DEVCHAIN_VERSION at $DEVCHAIN_NPM_REGISTRY (answered $status)." ;;
    esac
  fi

  local embedded_sha=''
  embedded_sha="$(printf '%s' "$DEVCHAIN_BOOTSTRAP_TGZ_BASE64" | base64 -d 2>/dev/null | sha256sum 2>/dev/null | awk '{ print $1 }' || true)"
  if [[ "$embedded_sha" != "$DEVCHAIN_BOOTSTRAP_SHA256" ]]; then
    devchain_fail 'The embedded bootstrap archive is damaged (SHA-256 mismatch).'
  fi

  local -a headless_packages=()
  if command -v dpkg-query >/dev/null 2>&1; then
    while IFS= read -r arg; do [[ -z "$arg" ]] || headless_packages+=("$arg"); done < <(
      { dpkg-query -W -f='\${Package} \${db:Status-Status}\\n' dbus-user-session dbus-x11 gnome-keyring snapd 2>/dev/null || true; } |
        awk '$2 == "installed" { print $1 }'
    )
  fi
  local purge_preview='No installed headless packages need removal.'
  if (( \${#headless_packages[@]} > 0 )) && command -v apt-get >/dev/null 2>&1; then
    if ! purge_preview="$(apt-get -o DPkg::Lock::Timeout=600 -s purge "\${headless_packages[@]}" 2>&1)"; then
      devchain_fail 'The headless package removal dry run failed.'
    fi
  fi
  printf '%s\\n' 'Headless package removal dry run:' "$purge_preview"
  if command -v snap >/dev/null 2>&1; then
    printf '%s\\n' 'Installed snaps:'
    snap list 2>&1 || true
  fi
  if grep -Eq '^Remv (openssh-server|sudo|systemd|dbus|netplan.io|systemd-networkd|ifupdown)([[:space:]]|$)' <<< "$purge_preview"; then
    devchain_fail 'The headless purge would remove a critical login, init, D-Bus, or network package.'
  fi

  if command -v ip >/dev/null 2>&1; then
    local address first_octet second_octet public_address=0
    while IFS= read -r address; do
      address="\${address%/*}"
      IFS=. read -r first_octet second_octet _ <<< "$address"
      if [[ "$first_octet" == 10 || "$first_octet" == 127 || "$first_octet" == 169 && "$second_octet" == 254 ||
            "$first_octet" == 192 && "$second_octet" == 168 ||
            "$first_octet" == 172 && "$second_octet" =~ ^[0-9]+$ && "$second_octet" -ge 16 && "$second_octet" -le 31 ||
            "$first_octet" == 100 && "$second_octet" =~ ^[0-9]+$ && "$second_octet" -ge 64 && "$second_octet" -le 127 ]]; then
        continue
      fi
      public_address=1
      devchain_warn "Interface address $address is public. This host must be reachable only on a trusted LAN or VPN."
    done < <(ip -o -4 addr show scope global 2>/dev/null | awk '{ print $4 }')
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    devchain_warn "ufw is active; allow TCP ports $DEVCHAIN_BOOTSTRAP_PORT, $DEVCHAIN_HOME_PORT and 22000."
  fi
  local account=''
  if command -v getent >/dev/null 2>&1; then account="$(getent passwd "$DEVCHAIN_HOME_USER" 2>/dev/null || true)"; fi
  if [[ -n "$account" ]]; then
    local existing_home
    existing_home="$(awk -F: '{ print $6 }' <<< "$account")"
    if [[ "$existing_home" == "$DEVCHAIN_HOME_PATH" ]]; then
      devchain_warn "Account $DEVCHAIN_HOME_USER already exists with $DEVCHAIN_HOME_PATH; the claim reuses it and grants passwordless sudo."
    else
      devchain_warn "Account $DEVCHAIN_HOME_USER already exists with $existing_home; choose another user or home in Set up VM."
    fi
  fi

  if (( failures > 0 )); then
    printf 'Pre-validation found %d problem(s); no changes were made.\\n' "$failures" >&2
    return 1
  fi
  printf '%s\\n' 'Pre-validation passed.'
  if (( check == 1 )); then return 0; fi

  export DEBIAN_FRONTEND=noninteractive
  # dpkg has no lock-timeout option, and apt's DPkg::Lock::Timeout does not cover the lists lock
  # that apt-get update takes, so the wait lives here; the env overrides keep the 10-minute wait
  # testable in seconds
  local lock_timeout=600 lock_retry=5
  if [[ "\${DEVCHAIN_PACKAGE_LOCK_TIMEOUT:-}" =~ ^[0-9]+$ ]]; then lock_timeout="$DEVCHAIN_PACKAGE_LOCK_TIMEOUT"; fi
  if [[ "\${DEVCHAIN_PACKAGE_LOCK_RETRY_SECONDS:-}" =~ ^[0-9]+$ ]]; then lock_retry="$DEVCHAIN_PACKAGE_LOCK_RETRY_SECONDS"; fi
  # usage: devchain_when_unlocked <lock name> <command>...; only lock contention is retried
  devchain_when_unlocked() {
    local lock_name="$1" deadline=$((SECONDS + lock_timeout)) output='' status=0
    shift
    until output="$("$@" 2>&1)"; do
      status=$?
      if ! grep -qiE 'lock.*(locked by|held by|another process|temporarily unavailable|resource busy)' <<< "$output"; then
        printf '%s\\n' "$output" >&2
        return "$status"
      fi
      if (( SECONDS + lock_retry > deadline )); then
        printf 'The %s lock stayed busy for 10 minutes (probably automatic updates). Wait for them to finish, then press Retry.\\n' "$lock_name" >&2
        return 1
      fi
      sleep "$lock_retry"
    done
    if [[ -n "$output" ]]; then printf '%s\\n' "$output"; fi
  }
  devchain_when_unlocked dpkg dpkg --configure -a

  local guest_package=''
  case "$(systemd-detect-virt 2>/dev/null || true)" in
    kvm|qemu) guest_package=qemu-guest-agent ;;
    vmware) guest_package=open-vm-tools ;;
  esac
  devchain_when_unlocked 'apt lists' apt-get -o DPkg::Lock::Timeout=600 update
  local -a install_packages=("\${DEVCHAIN_BASE_APT_PACKAGES[@]}")
  if [[ -n "$guest_package" ]]; then install_packages+=("$guest_package"); fi
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "\${install_packages[@]}"

  mkdir -p "$(devchain_path /etc/apt/preferences.d)"
  printf '%s' "$DEVCHAIN_APT_PREFERENCE" > "$(devchain_path /etc/apt/preferences.d/devchain-no-session-bus.pref)"
  chmod 0644 "$(devchain_path /etc/apt/preferences.d/devchain-no-session-bus.pref)"
  if (( \${#headless_packages[@]} > 0 )); then
    apt-get -o DPkg::Lock::Timeout=600 purge -y "\${headless_packages[@]}"
  fi
  rm -rf "$(devchain_path /snap)" "$(devchain_path /var/snap)" \
    "$(devchain_path /var/lib/snapd)" "$(devchain_path /var/cache/snapd)"

  local work node_tarball
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' 0
  node_tarball="node-v\${DEVCHAIN_NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLo "$work/$node_tarball" "https://nodejs.org/dist/v$DEVCHAIN_NODE_VERSION/$node_tarball"
  curl -fsSLo "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$DEVCHAIN_NODE_VERSION/SHASUMS256.txt"
  (cd "$work" && grep " $node_tarball\\$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$(devchain_path /usr/local)"
  tar -xJf "$work/$node_tarball" -C "$(devchain_path /usr/local)" --strip-components=1 \
    --no-same-owner --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'

  mkdir -p "$(devchain_path /etc/apt/keyrings)" "$(devchain_path /etc/apt/sources.list.d)"
  curl -fsSLo "$(devchain_path /etc/apt/keyrings/syncthing-archive-keyring.gpg)" https://syncthing.net/release-key.gpg
  printf '%s\\n' 'deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable-v2' \
    > "$(devchain_path /etc/apt/sources.list.d/syncthing.list)"
  devchain_when_unlocked 'apt lists' apt-get -o DPkg::Lock::Timeout=600 update
  apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends "syncthing=$DEVCHAIN_SYNCTHING_VERSION"

  mkdir -p "$(devchain_path /etc/sysctl.d)"
  printf '%s' "$DEVCHAIN_SYSCTL_CONFIG" > "$(devchain_path /etc/sysctl.d/60-devchain-inotify.conf)"
  chmod 0644 "$(devchain_path /etc/sysctl.d/60-devchain-inotify.conf)"
  sysctl --system

  local bootstrap_tgz="$work/devchain-host-bootstrap.tgz"
  printf '%s' "$DEVCHAIN_BOOTSTRAP_TGZ_BASE64" | base64 -d > "$bootstrap_tgz"
  npm install -g --omit=dev --no-fund --no-audit "$bootstrap_tgz"

  local packages_file="$work/packages" package package_version
  : > "$packages_file"
  for package in "\${install_packages[@]}" syncthing; do
    package_version="$(dpkg-query -W -f='\${Version}' "$package")"
    printf '%s\\t%s\\n' "$package" "$package_version" >> "$packages_file"
  done
  export DEVCHAIN_MANIFEST_BASE="$id-$version_id-installed"
  export DEVCHAIN_NODE_RUNTIME="$(node --version)"
  export DEVCHAIN_NPM_RUNTIME="$(npm --version)"
  export DEVCHAIN_SYNCTHING_CLI="$(syncthing --version 2>&1)"
  export DEVCHAIN_IMAGE_VERSION DEVCHAIN_NPM_REGISTRY DEVCHAIN_BOOTSTRAP_PACKAGE
  export DEVCHAIN_BOOTSTRAP_VERSION DEVCHAIN_VERSION
  local manifest_tmp="$work/manifest.json"
  node - "$packages_file" > "$manifest_tmp" <<'DEVCHAIN_MANIFEST'
const fs = require('node:fs');
const e = process.env;
const packages = Object.fromEntries(
  fs.readFileSync(process.argv[2], 'utf8').trim().split('\\n').filter(Boolean).map((line) => line.split('\\t')),
);
const installedAt = new Date().toISOString();
const manifest = {
  schemaVersion: 1,
  imageVersion: e.DEVCHAIN_IMAGE_VERSION,
  builtAt: installedAt,
  arch: 'amd64',
  base: { name: e.DEVCHAIN_MANIFEST_BASE },
  npmRegistry: e.DEVCHAIN_NPM_REGISTRY,
  bootstrap: { package: e.DEVCHAIN_BOOTSTRAP_PACKAGE, version: e.DEVCHAIN_BOOTSTRAP_VERSION },
  packages,
  runtimes: { node: e.DEVCHAIN_NODE_RUNTIME.replace(/^v/, ''), npm: e.DEVCHAIN_NPM_RUNTIME },
  syncthingCli: e.DEVCHAIN_SYNCTHING_CLI.split('\\n')[0],
  install: { method: 'devchain-host-install', devchainVersion: e.DEVCHAIN_VERSION, installedAt },
};
process.stdout.write(JSON.stringify(manifest, null, 2) + '\\n');
DEVCHAIN_MANIFEST
  mkdir -p "$(devchain_path /usr/share/devchain-host)"
  install -m 0644 "$manifest_tmp" "$manifest_path"

  mkdir -p "$(devchain_path /etc/systemd/system)"
  printf '%s' "$DEVCHAIN_BOOTSTRAP_UNIT" > "$(devchain_path /etc/systemd/system/devchain-bootstrap.service)"
  chmod 0644 "$(devchain_path /etc/systemd/system/devchain-bootstrap.service)"
  systemctl daemon-reload
  systemctl enable devchain-bootstrap.service
  systemctl start devchain-bootstrap.service

  # The bootstrap creates its certificate before systemctl start returns.
  local fingerprint
  if ! fingerprint="$(openssl x509 -in "$(devchain_path "$DEVCHAIN_CERT_PATH")" -noout -fingerprint -sha256)"; then
    printf 'The bootstrap started without its certificate %s. See journalctl -u devchain-bootstrap.\\n' "$DEVCHAIN_CERT_PATH" >&2
    return 1
  fi
  printf '%s\\n' 'DevChain host bootstrap is ready:'
  while IFS= read -r address; do
    address="\${address%/*}"
    [[ -z "$address" ]] || printf 'https://%s:%s\\n' "$address" "$DEVCHAIN_BOOTSTRAP_PORT"
  done < <(ip -o -4 addr show scope global | awk '{ print $4 }')
  printf 'Certificate fingerprint (SHA-256): %s\\n' "\${fingerprint#*=}"
  printf '%s\\n' 'In Cloud, choose Set up a new VM, enter this address, and paste this fingerprint.'
  )
}

${invocation}
`;
}

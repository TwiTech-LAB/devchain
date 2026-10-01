# DevChain host image

`build.sh` turns the Ubuntu 24.04 minimal cloud image into a bootable
DevChain host image: `devchain-host-<version>.qcow2`. A VM from this image boots
**unclaimed**. The bootstrap service (`apps/host-bootstrap`) serves
`GET /api/runtime` and `POST /api/host/claim`, and the claim installs the
DevChain version that home runs. The image itself contains no DevChain version.

## Install on an existing VM

The [host installer](../local-app/src/modules/remotes/host-install/host-install-block.ts) prepares
a dedicated Ubuntu or Debian VM without building or booting this qcow2.
Both paths share `versions.env`, the apt package list in `customize.sh`, and
`files/60-devchain-inotify.conf` plus `files/devchain-no-session-bus.pref`.
The packed CLI includes these inputs and the bootstrap archive under
`dist/host-install` (`scripts/copy-cli.js`,
`apps/local-app/src/modules/remotes/host-install/host-install.service.ts`).
The installer preserves sshd, cloud-init and machine identity; see the
[installed-host manifest](../host-bootstrap/README.md#installed-hosts).
Claim and Update VM refresh the helper from the target DevChain package, so
helper changes do not require a new image (`apps/host-bootstrap/lib/refresh-helper.js`).

## Contents

| Item                  | Source                                                                                                                   | Purpose or pin                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base image            | `cloud-images.ubuntu.com/minimal/releases/noble/release-<serial>/ubuntu-24.04-minimal-cloudimg-amd64.img`                | Serial and SHA-256 in `versions.env`                                                                                                                                          |
| `systemd`             | Ubuntu Minimal base                                                                                                      | Starts the guest services, including the bootstrap service                                                                                                                    |
| `cloud-init`          | Ubuntu Minimal base                                                                                                      | Configures the network, grows the root disk, sets the host name and installs SSH keys                                                                                          |
| `linux-image-virtual` | Ubuntu Minimal base                                                                                                      | Provides the kernel used to boot the VM                                                                                                                                        |
| `sudo`                | Ubuntu Minimal base                                                                                                      | Lets the claimed account run host administration commands                                                                                                                    |
| `openssh-server`      | Ubuntu Minimal base                                                                                                      | Provides key-only SSH access                                                                                                                                                    |
| `iproute2`            | Ubuntu Minimal base                                                                                                      | Provides the guest network tools used by system services and diagnostics                                                                                                       |
| `util-linux`          | Ubuntu Minimal base                                                                                                      | Provides core VM utilities                                                                                                                                                     |
| `qemu-guest-agent`     | Ubuntu archive                                                                                                           | Reports guest network details to the hypervisor                                                                                                                                |
| Node.js               | `nodejs.org/dist` tarball, checked against `SHASUMS256.txt`, installed in `/usr/local`                                    | Node 24 runtime and npm for host software; `NODE_VERSION` in `versions.env`                                                                                                   |
| `tmux`                | Ubuntu archive                                                                                                           | Hosts the remote terminal sessions                                                                                                                                             |
| `git`                 | Ubuntu archive                                                                                                           | Provides source control tools in the VM                                                                                                                                         |
| Syncthing v2           | `apt.syncthing.net`, channel `stable-v2`                                                                                 | Synchronizes project files; `SYNCTHING_VERSION` in `versions.env`                                                                                                               |
| `curl`                | Ubuntu archive                                                                                                           | Makes HTTPS requests from host tooling                                                                                                                                          |
| `ca-certificates`     | Ubuntu archive                                                                                                           | Verifies HTTPS server certificates                                                                                                                                             |
| `build-essential`     | Ubuntu archive                                                                                                           | Compiles native Node.js modules                                                                                                                                                 |
| `python3`             | Ubuntu archive                                                                                                           | Supports native npm builds that use Python, including the `better-sqlite3` fallback                                                                                            |
| `xz-utils`            | Ubuntu archive                                                                                                           | Extracts the Node.js `.tar.xz` archive                                                                                                                                          |
| `jq`                  | Ubuntu archive                                                                                                           | Parses hook payloads for DevChain's Claude hook relay (`devchain-relay.sh`)                                                                                                     |
| `ripgrep`             | Ubuntu archive                                                                                                           | Agent search tool (`rg`), found missing on hosts                                                                                                                                |
| `python-is-python3`   | Ubuntu archive                                                                                                           | Provides the `python` command agents expect                                                                                                                                     |
| `python3-pip`         | Ubuntu archive                                                                                                           | Installs Python tooling for agents (`pip`)                                                                                                                                      |
| `python3-venv`        | Ubuntu archive                                                                                                           | Makes `python3 -m venv` work, including ensurepip                                                                                                                               |
| `file`                | Ubuntu archive                                                                                                           | Identifies file types for agents, found missing on hosts                                                                                                                        |
| `sqlite3`             | Ubuntu archive                                                                                                           | Inspects SQLite databases on the host                                                                                                                                           |
| `bsdextrautils`       | Ubuntu archive                                                                                                           | Text utilities such as `column`, found missing on hosts                                                                                                                         |
| `rsync`               | Ubuntu archive                                                                                                           | Syncs files for agents, found missing on hosts                                                                                                                                  |
| `unzip`               | Ubuntu archive                                                                                                           | Extracts zip archives for agents, found missing on hosts                                                                                                                        |
| Bootstrap service     | `apps/host-bootstrap`, packed with `npm pack`                                                                            | Provides the claim and runtime endpoints; package version is recorded in the manifest                                                                                           |

The image does not contain the provider CLIs `claude`, `codex`, `copilot`,
`opencode` or `agy`. The bootstrap installs them after the DevChain package is
downloaded at claim time, using the pins in that package's
`dist/host-cli-pins.json` (`apps/host-bootstrap/lib/claim.js`,
`apps/host-bootstrap/lib/clis.js`, `scripts/host-cli-pins.json`).

Settings in the image:

| File                                                   | Effect                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `/etc/apt/preferences.d/devchain-no-session-bus.pref`  | apt never installs `dbus-user-session`, `dbus-x11` or `gnome-keyring` (priority -1)              |
| `/etc/sysctl.d/60-devchain-inotify.conf`               | `fs.inotify.max_user_watches = 524288`                                                           |
| `/etc/ssh/sshd_config.d/01-devchain-no-passwords.conf` | key-only SSH; this file sorts before the file cloud-init writes                                  |
| `/etc/cloud/cloud.cfg.d/90-devchain.cfg`               | cloud-init only configures the network, grows the disk and sets the host name; `users: []` creates no account                                            |
| `/usr/share/devchain-host/manifest.json`               | the manifest without `artifact` (read by the bootstrap service)                                  |

### Headless: no session bus, no keyring

Antigravity keeps its login in the Secret Service keyring when it finds a
user-session D-Bus (`DBUS_SESSION_BUS_ADDRESS` or `$XDG_RUNTIME_DIR/bus`).
Without one, it keeps the login in
`~/.gemini/antigravity-cli/antigravity-oauth-token`, which the provider auth
vault writes and watches (see
[`provider-auth.md`](../local-app/scripts/remote-proofs/provider-auth.md#antigravity-agy)).
So the build purges `dbus-user-session`, and apt pins it, `dbus-x11` and
`gnome-keyring` out. `snapd` requires a session-bus provider, so it is removed
too. The system bus (`dbus`) stays, because systemd and the guest agent use it.

### Logins

- The image creates no account of its own: `90-devchain.cfg` sets `users: []`,
  so the cloud image's `ubuntu` default user never exists and uid 1000 stays
  free for the claim, which creates the user with the claiming PC's uid when
  it is at least 1000 and free (`apps/host-bootstrap/lib/claim.js`). This change starts with
  image version 1.2.0; older images keep the default user and their claims
  fall back to the next free uid, so `MIN_HOST_IMAGE_VERSION` stays `0.1.0`.
- No account has a password. Root is locked. cloud-init does not run
  `set_passwords`, so a password in user-data (for example Proxmox
  `cipassword`) is ignored.
- SSH accepts keys only, and an unclaimed VM has no account a key could reach,
  so there is no SSH login until the claim; the hypervisor's console is the
  fallback. A key chosen at setup reaches the VM after the claim: the claim's
  `ssh_keys` step posts it to the VM's own DevChain
  (`POST /api/host/ssh-keys`), which appends it to the claimed user's
  `<home>/.ssh/authorized_keys`.
- cloud-init does not run user-data commands, packages or upgrades. Everything
  the host needs is in the image or is done by the bootstrap service.

## Build

Build host prerequisites (Linux x86-64):

- `libguestfs-tools` (`guestfish`, `virt-customize`, `virt-sparsify`, `virt-cat`), `qemu-utils`, `curl`, `python3`
- A DHCP client that the libguestfs appliance can include, for `--network`. On
  Ubuntu this is `isc-dhcp-client` (the appliance package list names it, and
  recent Ubuntu releases no longer install it by default). If `passt` is
  installed, libguestfs uses it instead, and Ubuntu's AppArmor profile can stop
  it (`passt exited with status 1`). Test: `virt-customize -a <scratch copy> --network --run-command 'getent hosts nodejs.org'`.
- Node.js 24 with `npm`, to pack `apps/host-bootstrap`
- KVM (`/dev/kvm` readable by the build user). Without KVM, libguestfs still works but is much slower.
- To build without root: the host kernel must be readable
  (`sudo chmod 0644 /boot/vmlinuz-*`; Ubuntu installs kernels as 0600).
  Check with `libguestfs-test-tool`.
- About 6 GB free disk, and HTTPS access to `cloud-images.ubuntu.com`,
  `archive.ubuntu.com`, `security.ubuntu.com`, `nodejs.org`, `apt.syncthing.net`,
  `syncthing.net` and `registry.npmjs.org`

```bash
make -C apps/host-image image VERSION=1.0.0
# or: apps/host-image/build.sh --version 1.0.0 [--out <dir>] [--cache <dir>]
```

Output in `apps/host-image/out/<version>/`:

| File                                   | Content                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devchain-host-<version>.qcow2`        | compressed qcow2 with virtual size `DISK_SIZE` (8G). A VM disk must be at least `DISK_SIZE`; record the artifact size and root file system use from `virt-df` for each built version. |
| `devchain-host-<version>.qcow2.sha256` | `sha256sum` line; `sha256sum -c` checks it                                                                                                          |
| `manifest.json`                        | image version, base image, package and runtime versions, and the artifact checksum ([schema](manifest.schema.json))                                  |

The LAN verification build `1.1.1-lan` measured 413,794,304 compressed bytes
(about 395 MiB), with about 900 MiB used in the unclaimed root file system.
Reproduce a build's measurements with `stat -c %s <image.qcow2>` and
`virt-df -h -a <image.qcow2>`; `build.sh` records the compressed byte count in
`manifest.json`.

`--without-bootstrap` builds an image without `apps/host-bootstrap`. That image
boots but cannot be claimed (manifest `bootstrap: null`). Use it only to test
the image itself. `BOOTSTRAP_DIR=<dir>` builds with a bootstrap package from
another directory.

### Why `virt-customize`

`virt-customize` edits the disk offline in a libguestfs appliance. The image
never boots during the build, so cloud-init never runs, and there is no
first-boot state, SSH host key or machine ID to clean up. Packer's qemu
builder would boot the image, which needs a cloud-init seed to log in. That
first boot would then leave state that must be removed before publication.

### Reproducibility

The same `versions.env` gives the same base image (checked against the pinned
sha256), the same Node.js and Syncthing versions, and the same settings. Ubuntu
archive packages are selected at build time; their versions are recorded in
the manifest.

The qcow2 bytes differ between builds (timestamps), so compare builds by their
manifests.

To update a pin, change `versions.env`, build under a new image version, and
publish that version.

## Verify

```bash
make -C apps/host-image verify VERSION=1.0.0
# or: apps/host-image/verify.sh <image.qcow2> [--port 3000] [--keep]
```

`verify.sh` boots a throwaway overlay of the image under local KVM, with a
NoCloud seed that requests an SSH key, a password and SSH password auth — all
of which the image must ignore, because it creates no account of its own.
Its checks run as root through the guest agent (there is nothing to log into
until a claim). Before the boot it reads the image with `guestfish`. It checks:

- the image contains no `/etc/devchain-host/tls` (every VM creates its own certificate at first boot)

- the guest agent reports an IPv4 address within 60 s (`guest-network-get-interfaces`)
- the image has no `ubuntu` account and uid 1000 is free, and sshd refuses the seed key
- as root, each tool answers and exits zero — the check takes the tool's own exit status over the pipeline, so a missing command fails instead of passing on its error line: `node --version`, `syncthing --version`, `git --version`, `tmux -V`, `jq --version`, `rg --version`, `python --version`, `sqlite3 --version`, `rsync --version`, `file --version` and `unzip -v`
- `python3 -m venv` really builds a venv (ensurepip included) and its `bin/python` runs — `--help` alone does not prove that
- the session-bus packages are not installed, `dbus-launch` is missing, and no `/run/user` session directory exists
- no account has a password, sshd offers `publickey` only, and the inotify limit and disk growth are in effect
- the first boot created the VM certificate (EC P-256, 10 years, key `0600`), and a bootstrap restart keeps it
- `GET https://…:<port>/api/runtime`, trusting only that certificate, answers `{ state: 'unclaimed', imageVersion }`, and plaintext HTTP gets no answer (these bootstrap checks are skipped for `--without-bootstrap` images)

Extra tools: `qemu-system-x86_64`, `xorriso`, `openssh-client`, and `guestfish` from the build prerequisites.

On Proxmox, with the image published at a URL the node can reach:

```bash
node apps/local-app/scripts/remote-proofs/proxmox-lifecycle.mjs --image <base-url>/devchain-host-<version>.qcow2
```

## Publication layout

```
<base-url>/devchain-host-<version>.qcow2
<base-url>/devchain-host-<version>.qcow2.sha256
```

Once `apps/local-app/src/common/config/host-image.json` names a published
GitHub Release image, that entry is the default when
`HOST_IMAGE_URL`/`HOST_IMAGE_SHA256` are unset; until then, a LAN override is
required (`apps/local-app/src/common/config/host-image.config.ts`,
`apps/local-app/src/modules/remotes/operations/create-vm.operation.ts`).
Proxmox imports the image with `download-url` (content `import`, SHA-256 from
the selected entry or `<url>.sha256`) and creates the template disk with
`import-from` (`apps/local-app/scripts/remote-proofs/proxmox-lifecycle.mjs`).

## Bootstrap package contract

`build.sh` requires the following from `apps/host-bootstrap`:

- `npm pack` produces an installable, self-contained package: no `workspace:`
  dependencies. It is installed with `npm install -g` into
  `/usr/local/lib/node_modules/<name>`, with its `bin` entries in `/usr/local/bin`.
- `systemd/devchain-bootstrap.service` is installed to `/etc/systemd/system/`
  and enabled. Its `ExecStart` refers to the package's bin in `/usr/local/bin`.
- The service reads `imageVersion` and `npmRegistry` from
  `/usr/share/devchain-host/manifest.json`.

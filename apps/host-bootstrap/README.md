# DevChain host bootstrap

A root service supplied by the DevChain host image (`apps/host-image`) or the
[host installer](../local-app/src/modules/remotes/host-install/host-install-block.ts). On an
unclaimed VM it serves the runtime endpoint and accepts one claim. The claim
creates the user, writes provider auth, installs the requested DevChain
version, its four pinned npm provider CLIs and the latest agy, then starts it. After the claim, DevChain serves the port and two root
helpers handle "Update VM" and project roots.

No dependencies: Node.js 24 built-ins only, so `npm pack` produces a
self-contained package (see `apps/host-image/README.md`, "Bootstrap package
contract").

## Installed hosts

The installer shares `apps/host-image/versions.env`, its required and tool package lists and
`files/` settings for inotify and the headless baseline. It writes
`/usr/share/devchain-host/manifest.json` with `install.method` set to
`devchain-host-install`, `install.devchainVersion` set to home's version and
`install.installedAt` set to the installation timestamp. `imageVersion` is the
claim compatibility floor (`MIN_HOST_IMAGE_VERSION`, currently `0.1.0`), not a
qcow2 release version. It does not change sshd or cloud-init configuration or
reset the machine ID. See `apps/local-app/src/modules/remotes/host-install/host-install-block.ts`,
`host-install.service.ts`, `apps/host-image/manifest.schema.json` and
`apps/local-app/src/modules/remotes/operations/claim.operation.ts`.

## Units

| Unit                         | Runs as      | When                                                                                                          |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `devchain-bootstrap.service` | root         | only while `/etc/devchain-host/claim.json` is missing                                                         |
| `devchain-host.service`      | claimed user | written at claim time and re-written by `--clis` on a version-changing update; `Conflicts=devchain-bootstrap` |
| `devchain-join-<user>.service` | root | persistent HTTPS bootstrap for a reserved join, until that user's claim exists |
| `devchain-user-<user>.service` | joined user | owns the joined user's port and install; no conflicts with sibling services |

`devchain-host.service` has no `PAMName=`, so no logind session starts and
there is no `/run/user/<uid>` and no session bus. Provider env comes from
`<home>/.devchain/host.env` (`EnvironmentFile=`).

DevChain terminals and provider sessions on each side set `DEVCHAIN_UID` and
`DEVCHAIN_GID` from the app process's own ids, overriding inherited values.
Terminal creation also sets the new tmux session's environment explicitly, so
an existing tmux server cannot retain the wrong ids
(`apps/local-app/src/common/process-ids-env.ts`,
`apps/local-app/src/modules/terminal/services/terminal-io/lifecycle.ts`,
`apps/local-app/src/modules/sessions/services/provider-launch-config/provider-launch-config.service.ts`).

Claim writes `/etc/profile.d/devchain-ids.sh`, and the refreshed
`devchain-host-update --clis <version>` child installs it on updates too
(`lib/claim.js` — `ensureIdsProfile` and the claim profile step;
`bin/devchain-host-update.js`). Its contents are:

```sh
export DEVCHAIN_UID="$(id -u)" DEVCHAIN_GID="$(id -g)"
```

The file has mode 0644. Claim refuses a symbolic link at that path.
It leaves the file unchanged when its contents and mode match.
The file supplies the login user's ids to manual SSH login shells.
Non-interactive `ssh vm 'docker compose up -d'` does not load this profile.
Export the variables explicitly if your Compose file needs them.
Keep both variables out of `.env`, because that file syncs to both sides
(`lib/claim.js` — `ensureIdsProfile`).

## VM certificate

Each VM has one TLS identity: an EC P-256 self-signed certificate for
`DNS:devchain-host`, valid for 10 years, that the `openssl` CLI creates.

| File                                         | Mode                                    | Written by                                                                                                                                        |
| -------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/etc/devchain-host/tls/key.pem`, `cert.pem` | `0600`, `0644` (directory `0755`, root) | `devchain-bootstrap --ensure-certificate`, the `ExecStartPre=` of `devchain-bootstrap.service`, so the files exist when `systemctl start` returns |
| `<home>/.devchain/tls/key.pem`, `cert.pem`   | `0600`, claimed user (directory `0700`) | the claim's `tls` step, copied from `/etc/devchain-host/tls/`                                                                                     |

- The certificate is created only on an unclaimed VM that has neither file.
  A restart keeps it. One file alone, an unreadable file or a key that does
  not match the certificate stops the bootstrap with `TLS_UNAVAILABLE`; the
  files are never replaced silently. A claimed VM never gets a new certificate.
- The host image contains no certificate (`apps/host-image/customize.sh`,
  `verify.sh`); every VM creates its own at first boot.
- DevChain finds its copy through `DEVCHAIN_HOST_TLS_KEY_FILE` and
  `DEVCHAIN_HOST_TLS_CERT_FILE`. The claim writes both into `host.env`, and
  `devchain-host.service` sets them with `Environment=`, so a unit re-written
  by an update keeps them. The unit's `ExecStartPre=` refuses to start
  DevChain when either variable is empty or its file is unreadable. A claim
  cannot set these keys or write these files (`lib/validate.js`).
- Home pins this certificate for every call to the VM. For the setup paths
  that need a pasted fingerprint, print it on the VM with
  `openssl x509 -in /etc/devchain-host/tls/cert.pem -noout -fingerprint -sha256`.

## HTTPS contract of the unclaimed VM (port 3000)

The bootstrap serves HTTPS only, with the VM certificate. A plaintext request
gets no answer.

`GET /api/runtime` returns `200 {"state":"unclaimed"|"claiming"|"handover","version":null,"imageVersion":"…","bootId":"…"}`.
`version` stays `null` until DevChain itself answers on the port.

`POST /api/host/claim`:

```json
{
  "userName": "alice",
  "homePath": "/Users/alice",
  "uid": 1000,
  "gid": 1000,
  "version": "0.24.0",
  "port": 3000,
  "providerAuth": {
    "env": { "ANTHROPIC_API_KEY": "…" },
    "files": [
      {
        "path": "/Users/alice/.codex/auth.json",
        "mode": "0600",
        "contentBase64": "…"
      }
    ]
  }
}
```

- `userName`: `^[a-z_][a-z0-9_-]{0,31}$`. `homePath` sits under `/home`,
  `/Users` or `/var/home`. `version` is semver. `port` is 1024–65535.
- `uid`: optional integer from this PC's account. The validator keeps values
  from 500 to 60000 and drops values outside this range.
  It refuses non-integers (`lib/validate.js` — `validateClaim`).
  A new account gets `useradd -u <uid>` when that uid is free, including uid 501.
  A taken uid or an absent field uses normal Linux allocation.
  An existing allowed account keeps its ids. Claim refuses an account below
  uid 500, another home, or uid 500–999 that does not match the request
  (`lib/claim.js` — `ensureUser`).
- `gid`: optional integer from this PC's account. The validator keeps values
  from 1 to 60000 and drops values outside this range, so a home with a
  directory-service gid can still claim. Claim reuses the group with that
  number or creates a new group. `useradd -g <gid>` sets the primary group.
  Thus a Mac with gid 20 uses the VM's existing `dialout` group.
  Without `gid`, claim retains the uid-only group allocation rules
  (`lib/validate.js` — `validateClaim`; `lib/claim.js` — `ensurePrimaryGroup`).
- The claim record includes actual ids, requested ids, the primary group and
  any uid conflict. A conflict names the real holder when one exists.
  The VM runtime reports its actual process ids. Home uses those ids to decide
  whether automatic Docker moves are available
  (`lib/claim.js` — `accountIdentity`/`writeClaimRecord`;
  `apps/local-app/src/modules/core/controllers/runtime.controller.ts` — `getRuntime`;
  `apps/local-app/src/modules/remotes/vm-user-identity.ts` — `vmUserMismatch`).
- `env`: single-line values. Keys that systemd or DevChain set are refused
  (`HOME`, `PATH`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, …).
- `files`: at most 32, each inside the home, mode `0600` or `0400`, at most
  256 KiB. `.claude/.credentials.json`, `.devchain/host.env` and
  `.devchain/tls/{key,cert}.pem` are refused.
  Parent directories are created `0700` and owned by the user. Symlinks are refused.
- The body is at most 1 MiB. Neither the body nor its values appear in logs
  or error messages.

When both global Git identity values are set on home, home adds `.gitconfig` as
one more claim file at `<homePath>/.gitconfig`, mode `0600`; the bootstrap uses
the same existing claim-file validation and write path, so this does not change
the claim contract (`apps/local-app/src/modules/remotes/operations/claim.operation.ts`,
`apps/host-bootstrap/lib/claim.js`).

| Answer                                                                          | Meaning                                                                                      |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `200 {claimed:true, userName, homePath, version, cliVersions, port, claimedAt}` | DevChain answers `/api/runtime` with `version` on the port                                   |
| `400 INVALID_CLAIM`                                                             | the body breaks the rules above                                                              |
| `409 ALREADY_CLAIMED`                                                           | claimed, or a claim is running                                                               |
| `409 USER_EXISTS / HOME_EXISTS`                                                 | the account or home exists and is not a previous attempt's                                   |
| `500 CLAIM_STEP_FAILED`                                                         | a step failed (`message` names it). Nothing is recorded, so the same claim can be sent again |
| `504 HOST_START_TIMEOUT`                                                        | the claim is recorded, but DevChain did not answer in time                                   |

Claim steps, in order: user, sudoers (checked with `visudo -cf`), profile, tls,
provider auth, install, helper, clis, activate, service, record (`lib/claim.js`). `claim.json` is written last and
holds `userName`, `homePath`, `version`, `cliVersions`, `port` and `claimedAt`.
Among the provider-auth files, home always sends `<home>/.devchain/host-api-key`
(mode `0600`) — the SHA-256 hash of the VM's API key, written with the other
files; after the handover the claimed DevChain requires that key from every
non-loopback caller.
The claimed host also reports `cliVersions` in `GET /api/runtime`
(`apps/local-app/src/modules/core/controllers/runtime.controller.ts`).

Handover: the bootstrap closes its listener, then runs `systemctl start
--no-block devchain-host.service`. It answers the claim on the open HTTPS
connection once DevChain reports the version on `http://127.0.0.1:<port>`,
then exits.

## Joined instances

Home's SSH join check reads every existing claim's own installed version at
`<instance root>/versions/<claim.version>/lib/node_modules/devchain-cli/dist/host-install/pins.json`.
The first instance root is `/opt/devchain-host`; joined roots are
`/opt/devchain-host/instances/<user>`. Each file must contain numeric
`sharedVmProtocol: 1`. Missing, malformed or unsupported metadata refuses the
join and names the affected users and versions. The marker is emitted by
`scripts/copy-cli.js`; version numbers, home's package, the new helper and the
shared image manifest do not determine compatibility
(`apps/local-app/src/modules/remotes/host-install/host-join-block.ts`).

The first instance retains `/etc/devchain-host/claim.json`, `devchain-host.service`,
`/opt/devchain-host/{versions,current}`, `/usr/local/bin` and sudoers `devchain-host`.
Joined instances use `/etc/devchain-host/instances/<user>/claim.json` and an install
tree under `/opt/devchain-host/instances/<user>/`: `versions/`, `current`, `helper/`
for the bootstrap npm prefix, `clis/` for provider CLIs and agy, and `bin/` for their
links and the privileged Syncthing copy. The joined claim writes sudoers
`devchain-user-<user>` and checks it with `visudo -cf` (`lib/system.js`, `lib/claim.js`,
`lib/refresh-helper.js`, `lib/clis.js`, `lib/syncthing.js`).

The joined unit uses the refreshed version's template, sets
`DEVCHAIN_HOST_ETC_DIR`, `DEVCHAIN_HOST_BIN_DIR`, `DEVCHAIN_HOST_SYNCTHING_BINARY`
and the user's TLS file paths, and starts PATH with the instance's `bin/`.
`/etc/profile.d/devchain-instance-path.sh` supplies that PATH to SSH login shells
when their user's instance directory exists (`lib/claim.js`, `lib/render.js`).

Run the instance helper's `devchain-bootstrap` as root over SSH. Requests go on
stdin, and successful reservation/cancellation commands print one JSON line:

| Command | Input / result |
| --- | --- |
| `--reserve-join` | Input `{userName,homePath,port,requestId,uid?,gid?}`; result `{userName,homePath,port,requestId,nonce,expiresAt}`. Creates or resumes the reservation and enables/starts `devchain-join-<user>.service`. |
| `--cancel-join` | Input `{userName,requestId}`; result `{cancelled:true}`. Removes that request's reservation, join unit and instance folders before a claim starts. Repeating cancellation succeeds. |
| `--join <user>` | Serves HTTPS on the reservation's port using the VM certificate. The helper's install prefix must identify that user. Used by the join unit. |

The registry is the legacy claim plus joined claims and `join.json` reservations.
Registry mutations hold a kernel `flock` on `/etc/devchain-host/registry.lock`.
Port allocation uses home's requested port when free, otherwise the first free
port in 3000–3999; it excludes claim ports, live reservations and TCP listeners.
A duplicate name returns `409 INSTANCE_EXISTS` with
`This VM already runs DevChain for <user> on port <P>.`
Account/home collisions retain `USER_EXISTS`/`HOME_EXISTS` (`lib/instances.js`,
`lib/host-lock.js`).

The reservation stores a nonce hash; `join.nonce` contains the secret with mode
0600. Keep the command's nonce result in memory and out of logs. The join's
`POST /api/host/claim` uses the same body as the first claim, adds `nonce`, and must
match the reserved user, home and port. Its `/api/runtime` reports the same
unclaimed/claiming/handover states. A successful claim removes the reservation
and secret, starts `devchain-user-<user>.service`, and exits after handover.
An unused reservation expires after one hour and removes its unit and secret;
once a claim starts, its reservation remains available for retry. Reusing the
same requestId resumes the same port, nonce and expiry. Missing or mismatched
joined state never selects the first instance (`lib/instances.js`, `lib/validate.js`,
`lib/server.js`, `bin/devchain-bootstrap.js`).

## DevChain installs

Each version is installed with `npm install -g --prefix=/opt/devchain-host/versions/<v>`.
The claim installs from the image manifest's `npmRegistry`. Update VM installs
from the registry home passes (`--registry <url>`, http or https), else from the
manifest's `npmRegistry`. A failed install names the registry it used.
`/opt/devchain-host/current` points
at the active version, and `/usr/local/bin/devchain` points through it.
Switching versions renames two symlinks, so an update that fails or is
interrupted leaves the running version intact.

`dist/host-cli-pins.json` in the installed `devchain-cli` package provides the
four npm package pins and the agy installer URL (`scripts/host-cli-pins.json`,
`scripts/copy-cli.js`). The `clis` step installs mismatched npm packages as
root-owned globals under `/usr/local` for the first instance, or under the
joined instance's `clis/` prefix with links in its `bin/`, always from the public npm registry
`https://registry.npmjs.org/` — `--registry` plus the scoped
`--@anthropic-ai:registry=`, `--@openai:registry=` and `--@github:registry=`
flags pin every provider scope to it, winning over inherited `npm_config_*`
values that would redirect a scope — and never from the image manifest's
registry, so a private registry that serves only `devchain-cli` cannot fail
the CLI step. DevChain itself installs from the registry that
[DevChain installs](#devchain-installs) names, so pre-release builds on a
private registry still work (`lib/clis.js`, `lib/claim.js`, `lib/update.js`). The step also runs the agy installer to
fetch the latest version, since
agy has no version pin. The new binary is staged with a temporary home, checked
with `--version`, and atomically replaces `/usr/local/bin/agy` for the first
instance or the joined instance's `clis/bin/agy` only when its
version differs. Download or validation failure leaves the old agy binary in
place; if it still runs `--version`, the CLI step succeeds with a warning and
records that retained version. Without a working agy, the step fails (`lib/clis.js`). A missing
pin file fails the claim or update before activation. The CLI versions, including
agy's reported version, are saved in `claim.json` and returned by the claim.
The agy installer receives a temporary `HOME` explicitly because systemd does not
provide `HOME` to the bootstrap service (`lib/clis.js`). CLI downloads have a
30-minute per-command timeout; home allows 45 minutes for claim and Update VM
(`lib/clis.js`, `apps/local-app/src/modules/remotes/operations/remote-host.client.ts`,
`remote-operation.timing.ts`).

Before the CLI step, claim and version-changing Update VM verify and install
`dist/host-install/devchain-host-bootstrap.tgz` from the target DevChain
package, then invoke the refreshed helper as `devchain-host-update --clis <version>`.
The helper tgz installs into `/usr/local` for the first instance, or the joined
instance's `helper/` prefix. Every child invocation uses the instance's own
`bin/devchain-host-update` path (`lib/refresh-helper.js`).
A joined instance first reads the target package's `pins.json`. Without
`sharedVmProtocol: 1`, the claim or update fails with `SHARED_VM_UNSUPPORTED`
before npm runs, so the instance keeps its current helper, version and CLIs. An
older helper would resolve the first instance's paths. The first instance
accepts any target (`lib/host-install-pins.js` — `assertSharedVmTarget`).
The `--clis` child reads `dist/host-install/pins.json` from the target package.
Its `aptPackages` list contains required packages; `toolPackages` contains agent tools.
Both lists come from `DEVCHAIN_REQUIRED_PACKAGES` and `DEVCHAIN_TOOL_PACKAGES`
in `apps/host-image/versions.env` (`scripts/copy-cli.js`).
The child asks dpkg which packages are missing. It installs missing required
packages with `--no-install-recommends --no-remove`; apt can upgrade required
dependencies, and this pass excludes `qemu-guest-agent`.
A required-package failure stops the child with `{code:"PACKAGES_FAILED", message}`
before any CLI install or activation. A failed `apt-get update` is logged;
the required install determines success. Missing tools get a group attempt
of up to 3 minutes, then individual attempts of up to 2 minutes each.
Tool preparation and all attempts share a 10-minute budget.
Both tool paths use `--no-install-recommends --no-remove`, so apt cannot remove
an existing package to resolve a conflict. A failed tool is skipped.
An apt dry run precedes each attempt, and a tool whose install would change an
installed package is skipped. After a failed attempt, cleanup purges only the
unconfigured packages that the tools phase added, so later apt installs still work.
The child reports skipped names in `skippedTools` and diagnostics on stderr.
The UI does not show skipped tools. When no packages are missing, the
read-only dpkg query still runs, but no configure or apt command runs
(`lib/packages.js`, `bin/devchain-host-update.js`).
This fresh process reads the target package's CLI pins; the already-running
claim/update process continues its activation and recording work. The SHA-256
check against `pins.json` detects a damaged tgz, not a substituted tgz plus digest.
An equal-version update returns without installing anything (`lib/refresh-helper.js`,
`lib/claim.js`, `lib/update.js`, `bin/devchain-host-update.js`).

Hosts claimed with the older helper need this one-time command after their first
Update VM to a build containing helper refresh:

```bash
sudo npm install -g /opt/devchain-host/current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz
```

## Privileged VM file sync

After installing CLIs, `devchain-host-update --clis <version>` refreshes a separate
copy of `/usr/bin/syncthing` at `/opt/devchain-host/bin/syncthing`.
Joined instances use `/opt/devchain-host/instances/<user>/bin/syncthing` and
the joined user's primary group; refreshing one instance does not replace
another instance's copy (`lib/syncthing.js`, `lib/system.js`).
`libcap2-bin` is a required package in `apps/host-image/versions.env`, supplying
`setcap` and `getcap` (`bin/devchain-host-update.js`, `lib/system.js`, `lib/syncthing.js`).

The account comes from the instance's own `claim.json`. During a fresh claim the
record is not written yet, so only when it is absent does the installer use the
claimed user's `NOPASSWD:ALL` line in its own sudoers file: `devchain-host`
for the first instance or `devchain-user-<user>` for a joined one. The source
must be a regular, root-owned file with no group or other write bit. The account
must exist with a valid non-system uid; its primary group comes from `id -gn`
(`lib/syncthing.js` — `claimedAccount`; `lib/claim.js` — `performClaim`).

The installer creates an exclusive temporary sibling, sets `root:<primary group>`
with mode `0750`, applies `cap_chown,cap_fowner,cap_dac_override+ep`, verifies all
three with `getcap`, then atomically renames the staged binary into place. It
refreshes by replacement so an executing copy does not cause `ETXTBSY`.
Any failure attempts to remove both the staged and installed copies and writes
one sanitized stderr warning; the CLI update continues with ordinary Syncthing
fallback possible. A manual apt upgrade does not refresh this separate copy:
use Update VM. This step runs only on the VM (`lib/syncthing.js`;
`apps/local-app/src/modules/file-sync/syncthing-launcher.ts`).

## Root helpers (sudo, used by DevChain on a claimed VM)

Each installed helper copy serves its own instance. The package location under
`/usr/local` selects the first instance; a location under
`/opt/devchain-host/instances/<user>/helper` selects that joined user.
Environment variables never select the helper's identity. Before privileged
work, helpers require their own claim and a matching account. A `SUDO_USER`
that names a different registered instance user is refused with
`INSTANCE_MISMATCH`; an unregistered sudo admin does not redirect the helper
(`lib/system.js`, `lib/helper-instance.js`, `bin/devchain-host-update.js`,
`bin/devchain-host-project-root.js`).

The `--clis` mode also supports a claim before its record is written: a joined
instance needs its bound reservation with the claim-start marker; the first
instance uses its own root-owned sudoers file. Detached workers use their
installed path without requiring `SUDO_USER` (`lib/helper-instance.js`).

Names in the helper table are the first instance's defaults. Joined instances
use this mapping (`lib/system.js`, `lib/update.js`, `lib/docker.js`):

| Artifact | First instance | Joined instance |
| --- | --- | --- |
| Helper path | `/usr/local/bin/devchain-host-update` | `/opt/devchain-host/instances/<user>/bin/devchain-host-update` |
| Service | `devchain-host.service` | `devchain-user-<user>.service` |
| Update worker | `devchain-host-update` | `devchain-update-<user>` |
| Docker worker | `devchain-host-docker` | `devchain-docker-<user>` |
| Job status | `/etc/devchain-host/{update,docker}.json` | `/etc/devchain-host/instances/<user>/{update,docker}.json` |

The claimed user gets `NOPASSWD:ALL`, plus explicit lines for the two helpers (`lib/render.js` — `renderSudoers`).
DevChain calls them with `sudo -n` (`apps/local-app/src/modules/remotes/host`).

| Helper                                        | DevChain route                  | Does                                                                                                                                                                                                                                                                                           |
| --------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devchain-host-update <v> [--registry <url>]` | `POST /api/host/update` → 202   | starts `devchain-host-update --run <v> [--registry <url>]` as the transient unit `devchain-host-update` and returns; a registry that is not an http or https URL gives `INVALID_REGISTRY`                                                                                                                                                                                               |
| `devchain-host-update --run <v> [--registry <url>]` | —                         | install DevChain (from `--registry`, else the manifest registry) and its CLIs, activate, record, restart `devchain-host`, remove other versions                                                                                                                                                                                                |
| `devchain-host-update --clis <v>`             | —                               | installs missing required packages strictly and agent tools with skips, then its CLIs and privileged Syncthing copy; re-writes `devchain-host.service` when a claim record exists; prints `{cliVersions,skippedTools}`; diagnostics go to stderr (required-package failure: `PACKAGES_FAILED`) |
| `devchain-host-update --docker`               | `POST /api/host/docker` → 202   | starts `devchain-host-update --docker --run <jobId>` as the transient unit `devchain-host-docker` and returns `{jobId}`                                                                                                                                                                        |
| `devchain-host-update --docker --run <jobId>` | —                               | install Docker Engine and Compose, add the user to the `docker` group, restart `devchain-host`, record `docker.json`                                                                                                                                                                           |
| `devchain-host-project-root <path>`           | `POST /api/host/projects/roots` | creates the path (missing parents root `0755`), and the leaf is owned by the user                                                                                                                                                                                                              |

Already-claimed VMs retain a sudoers line for the removed ownership helper because
claim writes sudoers only once. That leftover line is harmless; updates do not
rewrite or clean it up (`lib/claim.js` — `writeSudoers`/`performClaim`).

The update runs in its own transient unit because restarting the instance service
kills everything in its cgroup, including the `sudo` DevChain started.
Progress goes to `/etc/devchain-host/update.json` (`pending`, `installing`, `installing_clis`,
`restarting`, `done`, `failed`), and `GET /api/host/update` serves it.
The unit sets `TimeoutStopSec=90` seconds, and the bootstrap allows 120 seconds
for `systemctl restart devchain-host.service` (`systemd/devchain-host.service`,
`lib/update.js`).
Joined workers restart only `devchain-user-<user>.service`. Installation,
activation, claim recording and pruning all use the own instance tree; claim
record changes hold the shared host lock (`lib/update.js`).
The CLIs install one by one into the own instance prefix before activation, so an update
that fails during `installing_clis` leaves the CLIs installed so far at the new
pins while the old DevChain version keeps running and `claim.json` still lists
the old versions. Retrying the same update finishes the install and corrects
the record. agy uses its own staged replacement described above (`lib/clis.js`,
`lib/update.js`).

Project roots refuse system directories, other users' homes, and `/home` or
`/Users` themselves. They check again after resolving symlinks.

The Docker install runs like the update: only the detached instance Docker
unit does the work, and only that unit writes its own `docker.json`
(`pending`, `installing`, `restarting`, `done`, `failed`), which
`GET /api/host/docker` serves. The install adds Docker's official apt
repository and keyring, installs `docker-ce`, `docker-ce-cli`, `containerd.io`,
`docker-buildx-plugin` and `docker-compose-plugin` through the lock-aware
wrapper. The shared host lock covers the usable-Docker check and installation,
so concurrent workers install the Engine once. The worker then runs
`usermod -aG docker <own user>` and restarts only the own instance service so
the group applies. Docker and runtime-package apt installs use `--no-remove`:
apt never removes installed packages, while required dependencies can upgrade
(`lib/docker.js`, `lib/packages.js`). A VM that already answers with a
usable Engine and Compose, from any source (for example Ubuntu's `docker.io`
with `docker-compose-v2`), gets no install: only the group change and the
restart. A VM without a usable Docker that holds distro packages (`docker.io`,
`containerd`, `runc`, `docker-compose`, …) fails with `DOCKER_PACKAGE_CONFLICT`
and no package is replaced. Ubuntu and Debian
with a release codename only, else `DOCKER_OS_UNSUPPORTED` (`lib/docker.js`).
A helper without the `--docker` mode treats it as an invalid version; DevChain
maps that answer to `HOST_HELPER_OUTDATED` and names the manual migration above.

Helper output is JSON on stdout. Errors go to stderr as `{"code","message"}`,
with these exit codes:

| Exit | Meaning                                | DevChain maps to         |
| ---- | -------------------------------------- | ------------------------ |
| 0    | done                                   | —                        |
| 2    | invalid input                          | 400                      |
| 3    | conflict (not claimed, update running) | 409                      |
| 4    | refused path                           | 403                      |
| 77   | not run as root                        | 500 `HOST_HELPER_FAILED` |
| 1    | anything else                          | 500 `HOST_HELPER_FAILED` |

## Shared VM occupancy and notices

The Local App serves these routes below `/api/host/shared-vm`. Roster, notify,
notices, dismiss, abandon and fence require the instance's own API key even
on loopback. Count and inbox accept only loopback socket peers, including
IPv6 loopback; a valid key does not admit an external peer
(`../local-app/src/modules/remotes/host/host-shared-vm.controller.ts`).

| Method and suffix | Body | Result |
| --- | --- | --- |
| GET `connected-count` | — | `{connectedCount, connectedProjectIds}` |
| POST `inbox` | `{fromUser, action, message?, at}` | 204 |
| GET `roster` | — | `{instances: [{user, port, version, connectedCount, connectedProjectIds}]}` |
| POST `notify` | `{action, message?}` | `{results: [{user, delivered}]}` |
| GET `notices` | — | `{notices: [{id, fromUser, action, message?, at}]}` |
| POST `dismiss` | `{id}` | 204; repeat dismissal is harmless |
| POST `abandon` | `{projectId}` | 204; deletes no project data |
| POST `fence` | `{mode: "set" or "clear", operationId}` | `{fence}`; null after clearing |

Actions are `reset`, `destroy` or `forced`; `at` is an ISO timestamp.
The roster reads the legacy claim and `instances/*/claim.json`, calls each
instance's loopback count route, and reports `"unknown"` for unavailable or
invalid counts or project sets. Count and IDs come from the same non-template,
non-abandoned snapshot. Older count-only peers report unknown occupancy; a
known zero count without compatible project IDs cannot authorize deletion.
The count route first waits behind admitted import transactions; a bounded
SQLite busy refusal returns 503 and appears as unknown in the roster. This
prevents a pre-fence writer's later commit from escaping the final count
(`../local-app/src/modules/remotes/host/host-shared-vm.store.ts` — `readOccupancy`).
`version` is null when the claim omits it. Notify is an
owner-only, single best-effort attempt to every other claimed instance; each
request has a two-second deadline. Notices and abandonment use dedicated
instance settings rows, outside replica/project slices. Occupancy includes
frozen imports, excludes templates and abandoned IDs, and falls when release
deletes project rows. A successful hosted import clears its abandonment
within the same transaction (`../local-app/src/modules/remotes/host/shared-vm.contract.ts`,
`host-shared-vm.service.ts`, `host-shared-vm.store.ts` in that directory;
`../local-app/src/modules/storage/local/delegates/project-replica.delegate.ts`).

Only the owner's instance can run `devchain-host-update --fence set <operationId>`
or `--fence clear <operationId>`. Set atomically writes the root-owned, mode
0644 `/etc/devchain-host/fence.json` with `{ownerUser, operationId, expiresAt}`
and a fresh 30-minute expiry. Clear refuses a different live operation's ID.
The registry lock serializes fence changes with join admission; new joins,
reserved claims and the final joined claim record refuse a live fence with
`VM_DESTROY_PENDING` and the owner's name (`lib/fence.js`, `lib/instances.js`,
`lib/claim.js`, `bin/devchain-host-update.js`).

Every Local App hosted import reads the VM-wide fence inside its synchronous
project-write transaction, regardless of its own `DEVCHAIN_HOST_ETC_DIR`.
An expired fence is absent; an unreadable or malformed fence refuses import.
The owner must set the fence before reading the roster and retain it until
the home operation confirms its outcome. Roster and notices are available
only through these protected routes
(`../local-app/src/common/config/vm-destroy-fence.ts`,
`../local-app/src/modules/storage/local/delegates/project-replica.delegate.ts`).

## Tests

```bash
npm test   # unit tests against a temp-dir fake system; no root, no network
```

### End-to-end test

`e2e/claim-vm.sh` boots an image under KVM, claims it as Alice with fixture uid
1000, then joins Bob through a separate sudo SSH account. It reads the VM
certificate through the guest agent before claim and uses pinned HTTPS with
separate fixture API keys. Alongside the first-claim checks (SSH, provider
file modes, logs, project roots and service environment), it checks the
nonce-bound join and duplicate-name refusal. Updating Alice compares Bob's
version tree, helper/CLI files, unit, claim/status files and process; updating
Bob compares Alice's artifacts, including `/usr/local` CLIs and agy. Reboot
must bring both services back on their ports with the original certificate.
Both privileged Syncthing copies are checked with `getcap`, and both sudoers
files with `visudo` (`e2e/claim-vm.sh`).

The test needs `qemu-system-x86_64`, `qemu-img`, `xorriso`, access to `/dev/kvm`,
4 GB of free RAM and a registry serving two shared-capable builds. The local
registry below serves scratch packages and proxies their pinned public
dependencies. Package versions change only in temporary staging files:

```bash
pnpm build
node apps/host-bootstrap/e2e/prepare-test-packages.js /tmp/devchain-e2e-registry \
  0.25.0-e2e.1 0.25.0-e2e.2
node apps/host-bootstrap/e2e/serve-test-registry.js /tmp/devchain-e2e-registry 4873 &
NPM_REGISTRY=http://10.0.2.2:4873/ apps/host-image/build.sh --version 1.4.0
apps/host-bootstrap/e2e/claim-vm.sh apps/host-image/out/1.4.0/devchain-host-1.4.0.qcow2 \
  --version 0.25.0-e2e.1 --update-to 0.25.0-e2e.2 \
  --bootstrap-tgz dist/host-install/devchain-host-bootstrap.tgz
```

When libguestfs cannot be installed on the build host, prepare the test image
with KVM and cloud-init instead. `e2e/build-test-image.sh` verifies the same
pinned Ubuntu checksum and runs `apps/host-image/customize.sh` with the same
pinned Node, Syncthing, package lists and bootstrap archive. It grows the disk
through cloud-init, then shuts down and flattens the qcow2 overlay. It omits the
normal builder's sparsification, compression and release artifact manifest;
its output is for local verification. Run it as a user with KVM access (use
`sg kvm -c '…'` after adding a new group membership):

```bash
NPM_REGISTRY=http://10.0.2.2:4873/ apps/host-bootstrap/e2e/build-test-image.sh /tmp/devchain-e2e.qcow2
apps/host-bootstrap/e2e/claim-vm.sh /tmp/devchain-e2e.qcow2 \
  --version 0.25.0-e2e.1 --update-to 0.25.0-e2e.2 \
  --bootstrap-tgz dist/host-install/devchain-host-bootstrap.tgz
```

`--keep` leaves the VM and its private fixture directory for inspection and
prints its SSH command. Stop that VM and the registry after inspection.

The cross-home integration lane boots two full home apps with separate SQLite
stores against real VM registry/claim/update code and HTTPS. It uses the
two-instance fixture's per-app boundary hook; package/system commands remain
fake, with separate live process markers for update isolation. The KVM lane
above supplies the systemd, root ownership, sudoers, capabilities and reboot
evidence (`apps/local-app/src/modules/remotes/operations/shared-vm.two-instance.integration.spec.ts`,
`apps/local-app/src/common/test/shared-vm.fixture.ts`,
`apps/local-app/src/common/test/two-instance.fixture.ts`).

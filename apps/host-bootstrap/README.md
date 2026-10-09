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

## DevChain installs

Each version is installed with `npm install -g --prefix=/opt/devchain-host/versions/<v>`
from the image manifest's `npmRegistry`. `/opt/devchain-host/current` points
at the active version, and `/usr/local/bin/devchain` points through it.
Switching versions renames two symlinks, so an update that fails or is
interrupted leaves the running version intact.

`dist/host-cli-pins.json` in the installed `devchain-cli` package provides the
four npm package pins and the agy installer URL (`scripts/host-cli-pins.json`,
`scripts/copy-cli.js`). The `clis` step installs mismatched npm packages as
root-owned globals under `/usr/local`, always from the public npm registry
`https://registry.npmjs.org/` — `--registry` plus the scoped
`--@anthropic-ai:registry=`, `--@openai:registry=` and `--@github:registry=`
flags pin every provider scope to it, winning over inherited `npm_config_*`
values that would redirect a scope — and never from the image manifest's
registry, so a private registry that serves only `devchain-cli` cannot fail
the CLI step. DevChain itself keeps installing from the manifest registry, so
pre-release builds on a private registry still work (`lib/clis.js`,
`lib/claim.js`, `lib/update.js`). The step also runs the agy installer to
fetch the latest version, since
agy has no version pin. The new binary is staged with a temporary home, checked
with `--version`, and atomically replaces `/usr/local/bin/agy` only when its
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

## Root helpers (sudo, used by DevChain on a claimed VM)

The claimed user gets `NOPASSWD:ALL`, plus explicit lines for the three helpers (`lib/render.js` — `renderSudoers`).
DevChain calls them with `sudo -n` (`apps/local-app/src/modules/remotes/host`, `apps/local-app/src/modules/file-sync/sync-chown.service.ts`).

| Helper                                                              | DevChain route                  | Does                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devchain-host-update <v>`                                          | `POST /api/host/update` → 202   | starts `devchain-host-update --run <v>` as the transient unit `devchain-host-update` and returns                                                                                                                                                                 |
| `devchain-host-update --run <v>`                                    | —                               | install DevChain and its CLIs, activate, record, restart `devchain-host`, remove other versions                                                                                                                                                                  |
| `devchain-host-update --clis <v>`                                   | —                               | installs missing required packages strictly and agent tools with skips, then its CLIs; re-writes `devchain-host.service` when a claim record exists; prints `{cliVersions,skippedTools}`; diagnostics go to stderr (required-package failure: `PACKAGES_FAILED`) |
| `devchain-host-update --docker`                                     | `POST /api/host/docker` → 202   | starts `devchain-host-update --docker --run <jobId>` as the transient unit `devchain-host-docker` and returns `{jobId}`                                                                                                                                          |
| `devchain-host-update --docker --run <jobId>`                       | —                               | install Docker Engine and Compose, add the user to the `docker` group, restart `devchain-host`, record `docker.json`                                                                                                                                             |
| `devchain-host-project-root <path>`                                 | `POST /api/host/projects/roots` | creates the path (missing parents root `0755`), and the leaf is owned by the user                                                                                                                                                                                |
| `devchain-host-project-chown <root> <--file\|--dir\|--tree> <path>` | `POST /api/host/sync/chown`     | changes a file, directory, or eligible tree to the claimed user's uid and gid (`bin/devchain-host-project-chown.js`, `lib/project-chown.js`)                                                                                                                     |

The ownership route validates the checkout and Git facts before calling the helper. Automatic repair uses `--file` for tracked regular code files and `--dir` for qualifying parent directories without recursion. Explicit **Give to** can use `--tree` for untracked, non-ignored output; it refuses tracked descendants. The helper skips symbolic links, different devices, `.git` and nested repositories. A missing helper is reported as unsupported with update/copy guidance (`apps/local-app/src/modules/file-sync/host-sync.controller.ts`, `sync-chown.service.ts`, `lib/project-chown.js`).

The update runs in its own unit because restarting `devchain-host.service`
kills everything in its cgroup, including the `sudo` DevChain started.
Progress goes to `/etc/devchain-host/update.json` (`pending`, `installing`, `installing_clis`,
`restarting`, `done`, `failed`), and `GET /api/host/update` serves it.
The unit sets `TimeoutStopSec=90` seconds, and the bootstrap allows 120 seconds
for `systemctl restart devchain-host.service` (`systemd/devchain-host.service`,
`lib/update.js`).
The CLIs install one by one into `/usr/local` before activation, so an update
that fails during `installing_clis` leaves the CLIs installed so far at the new
pins while the old DevChain version keeps running and `claim.json` still lists
the old versions. Retrying the same update finishes the install and corrects
the record. agy uses its own staged replacement described above (`lib/clis.js`,
`lib/update.js`).

Project roots refuse system directories, other users' homes, and `/home` or
`/Users` themselves. They check again after resolving symlinks.

The Docker install runs like the update: only the detached `devchain-host-docker`
unit does the work, and only that unit writes `/etc/devchain-host/docker.json`
(`pending`, `installing`, `restarting`, `done`, `failed`), which
`GET /api/host/docker` serves. The install adds Docker's official apt
repository and keyring, installs `docker-ce`, `docker-ce-cli`, `containerd.io`,
`docker-buildx-plugin` and `docker-compose-plugin` through the lock-aware
wrapper, then runs `usermod -aG docker <user>` and restarts
`devchain-host.service` so the group applies. A VM that already answers with a
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

## Tests

```bash
npm test   # unit tests against a temp-dir fake system; no root, no network
```

### End-to-end test

`e2e/claim-vm.sh` boots an image under KVM and claims it. The claim names
fixture uid 1000 and ships `.ssh/authorized_keys` as a claim file —
the image has no account before the claim, and the e2e logs in as the claimed
user. It reads the VM certificate through the guest agent before the claim, as
Proxmox create does, and sends every request over HTTPS with `curl --cacert`.
It checks the runtime answers, that plaintext HTTP gets no answer, the uid and
group the claim created, a second claim, file modes (the TLS copy included),
logs and the DevChain environment, then project roots, an update (the
re-written unit still passes the TLS paths) and a reboot (the certificate does
not change). It needs `qemu-system-x86_64`, `qemu-img`,
`xorriso`, `/dev/kvm` and 4 GB of free RAM.

The image's `npmRegistry` must serve both versions. With a local
[verdaccio](https://verdaccio.org) on port 4873, the guest reaches it as
`10.0.2.2` (QEMU user networking):

```bash
npx verdaccio@6 --listen 0.0.0.0:4873 &            # config: publish devchain-cli, proxy the rest
# publish two devchain-cli builds (pnpm build, npm pack, set the version, npm publish)
NPM_REGISTRY=http://10.0.2.2:4873/ apps/host-image/build.sh --version 0.0.0-e2e
apps/host-bootstrap/e2e/claim-vm.sh apps/host-image/out/0.0.0-e2e/devchain-host-0.0.0-e2e.qcow2 \
  --version <v1> --update-to <v2> [--keep]
```

`--keep` leaves the VM running and prints its SSH command.

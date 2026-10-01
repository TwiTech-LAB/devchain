# Docker import across two real engines

`src/modules/remotes/docker/docker-import.external.spec.ts` runs Connect's Docker
steps (`DockerHandoff`: preflight, stop home, push, create on remote, rollback)
from this machine's engine (home) to a second machine's engine (VM). It is in the
`external-integration` Jest project only, and it skips unless both variables below
are set.

| Variable | Meaning |
| --- | --- |
| `DOCKER_IMPORT_TARGET_URL` | Base URL of the target harness, e.g. `http://192.168.1.100:3100` |
| `DOCKER_IMPORT_TARGET_SSH` | `user@host` for the agent's commands on the VM (`docker compose up`, `docker start`, `psql`) |
| `DOCKER_IMPORT_THROTTLE_SECONDS` | Duration of the throttled image load and archive PUT; default 310 (above the 300 s header/body timeouts) |

Scenario: a Compose Postgres (named, anonymous and bind data) and a `docker run`
Postgres (anonymous, named, shared bind) seeded with rows and owner/mode/symlink
markers, plus a `--rm` container with a named volume; a Connect with one throttled
image load and one throttled archive PUT; the agent's `compose up` and
`docker start` with row checks; a reconnect cancelled during the volume copy; a
reconnect that replaces the VM copies (VM-only files gone, Compose holder
removed); and a cleanup that returns both engines to their recorded inventory.
All resources carry a unique `dc-import-<id>` prefix and `dev.devchain.test`
label and are removed by exact identity.

## Setup

Both machines: the same account (uid) and home path, and access to the project
fixture path under that home. The test process and the harness reach their
engines as that account, so for the run only:

```sh
sudo chgrp "$(id -gn)" /var/run/docker.sock   # revert with: sudo chgrp docker /var/run/docker.sock
```

A Docker restart also resets the group. No account is added to the `docker` group.

The target harness (`docker-import-target.ts`) serves only the product
`api/host/docker` routes and the runtime Docker report, with its own `DB_PATH`,
so it never shares the installed DevChain service's database or Syncthing. Build
it on home and run it from the installed DevChain package's dependencies on the
VM:

```sh
# home, in apps/local-app: a tsconfig extending tsconfig.json with
#   files: [scripts/remote-proofs/docker-import-target.ts], outDir: <build>
npx tsc -p <that tsconfig>
rsync -a --delete <build>/ user@vm:/tmp/dc-import-target/app/
# VM
cd /tmp/dc-import-target && mkdir -p data
NODE_PATH=/opt/devchain-host/current/lib/node_modules/devchain-cli/node_modules \
  DB_PATH=/tmp/dc-import-target/data PORT=3100 NODE_ENV=production \
  setsid -f node app/scripts/remote-proofs/docker-import-target.js > target.log 2>&1 < /dev/null
```

Home needs the `postgres:17-alpine` image cached; the VM needs no images.

## Run

```sh
cd apps/local-app
DOCKER_IMPORT_TARGET_URL=http://<vm>:3100 DOCKER_IMPORT_TARGET_SSH=<user>@<vm> \
  pnpm test:external -- --testPathPatterns docker-import.external --forceExit
```

The run prints one `docker-import evidence {...}` line: engine and Compose
versions, throttled durations, cancel and cleanup details. It never prints Env.

## Cleanup

The spec's last test asserts that both engines match their inventory from before
the run. Afterwards:

```sh
# VM: stop the harness and remove it
kill "$(ss -ltnpH 'sport = :3100' | grep -o 'pid=[0-9]*' | cut -d= -f2)"
rm -rf /tmp/dc-import-target
# both machines
sudo chgrp docker /var/run/docker.sock
```

A VM that had Docker installed only for this run is purged as in
`docker-target-cleanup.sh` (without its tmpfs step): purge the five packages,
remove `/var/lib/docker`, `/var/lib/containerd`, the Docker apt source and
keyring, and compare `dpkg-query` against the list taken before the install.

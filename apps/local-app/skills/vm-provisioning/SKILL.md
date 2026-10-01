---
name: vm-provisioning
displayName: VM Provisioning
description: "Prepare a DevChain remote VM for development of a project. Find the tools the project needs from its CI, version files, manifests and docs, install the missing ones, and mark the project as provisioned on this VM. Runs only on a claimed DevChain VM. Use at agent start when `devchain status` prints `remote VM`, when a command on the VM fails because a tool is missing, or when the user asks to provision or prepare the VM. Triggers: provision the VM, prepare the VM, install the dev stack, VM is missing tools, remote VM setup."
version: 0.1.0
license: "MIT"
compatibility: "DevChain remote VMs (Ubuntu or Debian) claimed by a home DevChain"
resources:
  - provision.sh
---

# VM Provisioning

A DevChain remote VM starts as a generic machine. Only the project folder comes from home. This skill installs the development stack that the project needs on the VM. Then it marks the project as provisioned on this VM.

## Step 0 — Find the script

1. Call `devchain_get_skill` with slug `vm-provisioning`. Note the returned `contentPath`.
2. The script is `<contentPath>/provision.sh`. Run it with `bash`.

Below, `$P` means `bash <contentPath>/provision.sh`.

## Step 1 — Check

Run `$P check`.

| Output | Action |
|---|---|
| `home` | Stop. Home needs no provisioning. |
| `provisioned` | Stop. Continue your task. |
| `not provisioned` | Go to Step 2. |

If a command later fails because a tool is missing, do Steps 2 to 6 for that tool, even when the check prints `provisioned`.

## Step 2 — Find the requirements

Read these sources in this order. When two sources conflict, the earlier source wins.

1. CI workflows (`.github/workflows/*.yml`, `.gitlab-ci.yml`). They show the exact tools and versions that build the project.
2. Version files: `.nvmrc`, `.node-version`, `.tool-versions`, `.python-version`, `.ruby-version`.
3. Manifests: `package.json` (`engines`, `packageManager`), `composer.json` (`require.php`, `ext-*`), `pyproject.toml`, `requirements*.txt`, `go.mod`, `Gemfile`, `Cargo.toml`, `pom.xml`, `build.gradle`.
4. `Dockerfile` and Compose files. Base images show the runtimes. Services show the databases, caches and queues.
5. Setup docs: `README`, `CONTRIBUTING`, `docs/AGENTS.md`, and the setup or development pages in `docs/`.

Write a list. For each tool, give the tool, the required version and the source (`file:line`).

## Step 3 — Install what is missing

Check each tool first (for example `php -v`). Install only the tools that are missing or have the wrong version.

Run `devchain status` once. Its second line says whether `sudo` works without a password. If the line does not start with `sudo: yes`, ask the user before you run any `sudo` command.

| Need | Method |
|---|---|
| OS packages (PHP, web server, build tools, database clients) | Run `sudo apt-get update` once. Then run `sudo apt-get install -y <packages>`. |
| A version that the distribution does not have | Ask the user before you add a third-party package repository (for example the `ondrej/php` PPA). |
| Node.js | Use DevChain's Node (`/usr/local/bin/node`) when it meets the requirement. If not, install nvm in the user's home, run `nvm install <version>`, then run `nvm alias default system`. Run project commands with `nvm exec <version> <command>`. |
| pnpm or Yarn | Use `corepack` with the version in `packageManager`, or `npm install -g <tool>@<version>`. |
| Python | Use the system `python3` and a project `.venv`. For another version, use `uv` or `pyenv` in the user's home. |
| Databases, caches, queues | If the project has a Compose file, use it (`docker compose up -d <service>`). If not, install the OS package and bind the service to `127.0.0.1`. |
| Docker | DevChain installs Docker when it sets up the VM. If `docker version` or `docker compose version` fails without `sudo`, install Docker as Step 6. Never install it with `apt` or a script. |

Do not install project dependencies (`npm ci`, `pnpm install`, `pip install`) as part of provisioning. File sync does not copy `node_modules`, `.venv`, `dist`, `build` or `target` between home and the VM. The agent whose task needs them installs them. `vendor/` (Composer) syncs with home, so home's copy arrives on the VM.

## Never do these

DevChain runs on this VM. Each action below can break DevChain, its agents or the file sync.

- Do not replace, upgrade or remove `/usr/local/bin/node`, `npm`, or anything under `/opt/devchain-host`. DevChain and the Codex and Copilot CLIs run on this Node.
- Do not set a global default Node (for example `nvm alias default 18`). New agent shells then start the provider CLIs on the wrong Node.
- Do not install, upgrade or remove the provider CLIs: `claude`, `codex`, `copilot`, `opencode`, `agy`. DevChain pins their versions.
- Do not install Docker yourself. Do not change users or groups (`usermod`, `groupadd`). Use Step 6: DevChain installs Docker, adds the user to the `docker` group and restarts itself safely.
- Do not stop, restart or change `devchain-host`, `devchain-bootstrap` or Syncthing. Do not use port 3000 or 22000. Run `ss -ltn` before you pick a port for a service.
- Do not turn on or change a firewall (`ufw`, `iptables`). Do not change the SSH settings.
- Do not run `apt upgrade`, `apt full-upgrade` or `do-release-upgrade`. Do not reboot.
- Do not replace `/usr/bin/python3`. The OS tools use it.
- Do not change project files for provisioning. The project folder syncs with home.
- Do not create, copy or print secrets. If the project needs credentials, tell the user.

## Step 4 — Mark

Run `$P set`.

The marker is the file `~/.devchain/provisioning/<DEVCHAIN_PROJECT_ID>` on the VM. It is outside the project folder, because the project folder syncs with home. It holds the `claimedAt` value of `/etc/devchain-host/claim.json`. A reset or a reinstall claims the VM again and writes a new value, so `$P check` then prints `not provisioned`. An update keeps the value.

## Step 5 — Report

Tell the user in short lines:
- what you installed, with versions;
- what was already present;
- what the user must do (for example a third-party repository or credentials).

If Docker is missing, also tell the user: "DevChain now installs Docker and restarts. All agent sessions on this VM stop. Start them again when the install is done."

## Step 6 — Install Docker (only when it is missing)

Warning: DevChain restarts at the end of the install. Your session and every other agent session on this VM stop. Do this step last.

1. Complete Steps 4 and 5 first.
2. Start the install:

   ```bash
   curl -sS -X POST "$DEVCHAIN_API_URL/api/host/docker" -H 'Content-Type: application/json' -d '{}'
   ```

3. A `202` reply with `"state":"pending"` means that the install started. Do nothing more. DevChain restarts when the install is done.
4. A `404` reply or the code `HOST_HELPER_OUTDATED` means that this VM runs an older DevChain. Tell the user to run Update VM in Cloud, then press Install Docker there.

To read the progress, run `curl -sS "$DEVCHAIN_API_URL/api/host/docker"`.

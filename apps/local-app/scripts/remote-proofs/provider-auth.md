# Provider auth isolation proof

Input for the Phase 6 provider auth vault. Each section says how to produce a
login on the PC without touching the PC's own login, what to capture, how to
place it on a VM, how to verify it, and whether the entry is `static`
(reusable by many VMs at once) or `family` (one VM at a time).

Run 2026-09-22. No token value or file content appears here: files are
described by path, mode and field names; "changed" means a SHA-256 fingerprint
comparison done inside the shell, never printed.

## Setup

| | |
|---|---|
| PC | Linux, desktop session (D-Bus + Secret Service available) |
| Second host | Docker container `devchain-proof-host2` from `node:22-bookworm`, user `dev`, no D-Bus session. Separate filesystem; same LAN egress as the PC. |
| Isolated logins | `provider-auth-login.sh <provider>` in this directory, under `~/devchain-auth-proof/<provider>` (non-hidden so the snap-confined `gh` can write it), `umask 077` |
| Transfer | `docker cp` of the captured file, then `chown dev` + `chmod 600` |
| Refresh | forced on the second host by invalidating the access token or its expiry field (never by copying the PC's own files) |

CLI versions (PC / second host):

| CLI | PC | Second host |
|---|---|---|
| claude | 2.1.278 | 2.1.278 |
| codex | 0.155.1 | 0.155.1 |
| agy | 1.2.7 | 1.2.7 (binary copied from the PC) |
| opencode | 1.18.31 | 1.18.31 |
| copilot | 1.0.80 | 1.0.87 |
| gh | 2.74.0 (snap) | not installed |

## Summary

| Provider | Isolation | Captured | Placed on VM as | Refresh on VM | Kind |
|---|---|---|---|---|---|
| Claude | none needed (`claude setup-token`) | token string | `CLAUDE_CODE_OAUTH_TOKEN` env | n/a (no file) | `static` |
| Codex | `CODEX_HOME` | `auth.json` | `~/.codex/auth.json` 0600 | rewritten; refresh token rotates | `family` |
| Antigravity | `HOME` + no D-Bus (see below) | `antigravity-oauth-token` | `~/.gemini/antigravity-cli/antigravity-oauth-token` 0600 | rewritten; refresh token did not rotate | `family` |
| OpenCode `api` | n/a | one entry of the PC's `auth.json` | entry in composed `~/.local/share/opencode/auth.json` 0600 | n/a | `static` |
| OpenCode `oauth` | `XDG_DATA_HOME` | one entry of the isolated `auth.json` | entry in composed `auth.json` | rewritten; `refresh` rotates | `family` |
| Copilot | `GH_CONFIG_DIR` + `--insecure-storage` | `gh auth token` output (`gho_…`) | `COPILOT_GITHUB_TOKEN` env | n/a (no file) | `static` |

## Claude

- Isolation: none. The token comes from `claude setup-token` (the user's
  existing one). It is a long-lived, inference-only token.
- Files produced: none by the login. On the VM, with only the env var set,
  Claude writes no `.credentials.json`; `~/.claude/` holds only `backups/`,
  `policy-limits.json`, `projects/`, `remote-settings.json`, `sessions/`.
- Verification (second host, `CLAUDE_CODE_OAUTH_TOKEN` exported):
  - `claude auth status` → JSON `{loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", …}`
  - `claude -p "Reply with exactly: OK"` → `OK`
- Unavailable with this token:
  - Remote Control: `claude remote-control` → "Remote Control requires a
    full-scope login token. Long-lived tokens (from `claude setup-token` or
    CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only…"
  - claude.ai connectors: `claude mcp list` on the VM shows no servers; the PC
    (full login) lists 4 `claude.ai` connectors.
- Precedence trap: stored credentials (`~/.claude/.credentials.json`) win over
  `CLAUDE_CODE_OAUTH_TOKEN`. A VM must have no `.credentials.json`, or the
  launcher must map the token to `ANTHROPIC_AUTH_TOKEN`, which wins over stored
  credentials (the PC uses a wrapper at `/usr/local/bin/claude` for this).
- DevChain pass-through: `providers.env` / `profile_provider_configs.env` keys
  are only syntax-checked (`sessions/utils/env-builder.ts`); the Claude adapter
  unsets only `TMUX`, `TMUX_PANE`. `CLAUDE_CODE_OAUTH_TOKEN` reaches the child.
  Not exercised end to end: the second host ran the CLI directly, not a
  DevChain instance.
- Kind: `static`.

## Codex

- Isolation: `CODEX_HOME=<dir> codex login` (browser flow on the PC).
  `codex login status` → `Logged in using ChatGPT`.
- Files produced by the isolated login: `auth.json` (0600) and an empty
  `tmp/arg0/codex-arg0*/.lock`. `auth.json` fields: `auth_mode`,
  `tokens.{id_token, access_token, refresh_token, account_id}`, `last_refresh`.
  No keyring use (a file store is the default with an empty `config.toml`).
- Placed on VM: `~/.codex/auth.json`, mode 0600 in a 0700 directory.
- Verification: `codex login status` → `Logged in using ChatGPT`;
  `codex exec --skip-git-repo-check "Reply with exactly: OK" </dev/null` → `OK`.
  Without `</dev/null` a non-TTY `codex exec` waits on stdin.
- Refresh on the VM:
  - Setting `last_refresh` 3 weeks back did NOT trigger a refresh in 0.155.1.
  - Replacing `tokens.access_token` with an invalid value → the next request
    got 401, Codex refreshed and rewrote `auth.json`: `access_token`,
    `id_token` and `refresh_token` all changed, `last_refresh` set to now,
    mode stayed 0600.
- Kind: `family`. The refresh token rotates on use, so the entry is valid on
  one host at a time; the vault must take the rewritten file back on check-in.

## Antigravity (agy)

- Isolation variable: `HOME`. `GEMINI_CLI_HOME` is NOT honored (agy 1.2.7
  still wrote to `~/.gemini` with it set).
- Storage: agy uses a composite token store. With a D-Bus session it stores the
  login in the Secret Service keyring; without one it logs
  `composite_token_storage.go: Using file-based token storage because no D-Bus
  session bus detected` and writes
  `~/.gemini/antigravity-cli/antigravity-oauth-token`.
- Detecting "no D-Bus" needs BOTH `DBUS_SESSION_BUS_ADDRESS` unset AND no
  `$XDG_RUNTIME_DIR/bus` socket. With only the variable unset, agy found the
  default socket, read the PC's keyring and ran as the PC's own account (no
  write, no refresh; the PC login still works). Isolated PC login:
  `env -u DBUS_SESSION_BUS_ADDRESS HOME=<dir>/home XDG_RUNTIME_DIR=<empty 0700 dir> agy`.
- Login file: `antigravity-oauth-token`, 0600, JSON fields
  `token.{access_token, token_type, refresh_token, expiry}`, `auth_method`,
  `id_token`. Other files written at login (not credentials):
  `antigravity-cli/settings.json`, `antigravity-cli/cache/onboarding.json`,
  `antigravity-cli/implicit/<uuid>.pb`.
- Login on the headless VM (URL-paste flow, user at the browser): file store
  used automatically.
- Verification: `agy -p "Reply with exactly: OK" </dev/null` → `OK`; after a
  restart the login persists and the file is unchanged.
- Refresh on the VM: `token.expiry` set in the past → next `agy -p` rewrote the
  file: `access_token` changed, `expiry` moved to now + 1 h, `refresh_token`
  unchanged, mode stayed 0600.
- PC-side generation: YES. The isolated PC login with the corrected
  environment logged `Using file-based token storage because no D-Bus session
  bus detected` and wrote `<dir>/home/.gemini/antigravity-cli/antigravity-oauth-token`
  (0600) plus the non-credential files above under `<dir>/home/.gemini/`.
  Only `antigravity-oauth-token` was copied to the VM (replacing the VM's own
  login); `agy -p` → `OK`; forced refresh rewrote it on the VM (`access_token`
  changed, `expiry` now + 1 h, `refresh_token` unchanged, 0600). The PC's own
  agy login still answered `OK` afterwards.
- Kind: `family` (recommended). The refresh token did not rotate in this run,
  so two hosts might coexist, but that was not proven and Google may rotate or
  revoke on reuse; treat it as one host at a time.

## OpenCode

- `auth.json` shape confirmed as a map of provider id → entry. Seen:
  `{type: "api", key}` (PC: `zai-coding-plan`, `anthropic`) and
  `{type: "oauth", access, refresh, expires, accountId}` (isolated `openai`).
  `wellknown` was not seen (no such provider configured).
- Isolation: `XDG_DATA_HOME=<dir>` works; `opencode debug paths` shows
  `data <dir>/opencode`; `opencode auth list` shows `Credentials <dir>/opencode/auth.json`.
  Only `data` moves (config, cache, state stay under `$HOME`). `HOME` fallback
  was not needed.
- Files produced by the isolated login (`opencode auth login` → OpenAI →
  ChatGPT Plus/Pro): `<dir>/opencode/auth.json` (0600) only.
- Composed file: `jq` built `{ "zai-coding-plan": <PC entry>, "openai": <isolated entry> }`,
  placed at `~/.local/share/opencode/auth.json` 0600.
  `opencode auth list` → `Z.AI Coding Plan api`, `OpenAI oauth`, `2 credentials`.
- `api` entry on both hosts at once: `opencode run -m zai-coding-plan/glm-4.7
  "Reply with exactly: OK" </dev/null` ran concurrently on the PC and the VM →
  `OK` on both.
- `oauth` entry: `opencode run -m openai/gpt-5.5 …` → `OK`. Refresh forced by
  setting `openai.expires` to 0 → the next run rewrote the file on the VM:
  `access` and `refresh` changed, `expires` set to a new future value; the
  `zai-coding-plan` entry was preserved; mode stayed 0600. (Some models, e.g.
  `openai/gpt-5.3-codex-spark`, are rejected for ChatGPT accounts; the refresh
  still happens before that error.)
- Kind: `api` entries `static`; `oauth` entries `family` (refresh rotates).
  Write-back must split the rewritten file per entry.

## Copilot

- Isolation: `GH_CONFIG_DIR=<dir> gh auth login -h github.com -p https -w --insecure-storage`.
  `--insecure-storage` is required; without it gh stores the token in the
  keyring under the same account key the PC may use.
- Files produced: `<dir>/config.yml`, `<dir>/hosts.yml` (both 0600).
  Scopes: `gist`, `read:org`, `repo`, `workflow`.
- Captured: `gh auth token` output, a `gho_` OAuth token (40 chars).
- Verification (VM, `COPILOT_GITHUB_TOKEN` exported, no `copilot login`):
  `copilot -p "Reply with exactly: OK" --allow-all-tools` → `OK` plus a usage
  footer (Changes / AI Credits / Tokens / Resume).
- The token is not persisted: `~/.copilot/config.json` holds only
  `firstLaunchAt`; no copy of the token in `~/.copilot`.
- Kind: `static` (no refresh; revocable from GitHub settings).

## PC logins after the proof

Each CLI was run on the PC after all VM refreshes:

| CLI | Result | Credential file |
|---|---|---|
| claude | `OK` | `.credentials.json` rewritten by the PC's own running sessions (normal) |
| codex | `Logged in using ChatGPT`, `OK` | `auth.json` rewritten by its own refresh during this check (normal) |
| opencode | `OK` (zai) | unchanged |
| copilot | `OK` | unchanged |
| agy | `OK` | keyring |

`gh` on the PC was already failing (`Failed to log in to github.com account`)
before the proof and was not touched.

## Recommendations for Phase 6

- Vault entries: `static` = Claude setup-token, Copilot `gho_` token, OpenCode
  `api` entries; `family` = Codex `auth.json`, agy `antigravity-oauth-token`,
  OpenCode `oauth` entries.
- Place static tokens through the provider env (`providers.env` /
  config env), never as files.
- Watch these files on the VM for write-back: `~/.codex/auth.json`,
  `~/.gemini/antigravity-cli/antigravity-oauth-token`,
  `~/.local/share/opencode/auth.json` (split per entry id).
- The DevChain VM image must stay headless (no D-Bus session) so agy uses the
  file store. If a VM ever has D-Bus, launch agy with
  `DBUS_SESSION_BUS_ADDRESS` unset and an `XDG_RUNTIME_DIR` without `bus`.
- Claude on a VM: ensure no `~/.claude/.credentials.json`, or map the token
  to `ANTHROPIC_AUTH_TOKEN`. Remote Control and claude.ai connectors are not
  available with the setup-token.

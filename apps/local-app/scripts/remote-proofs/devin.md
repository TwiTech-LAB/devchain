# Devin CLI provider proof

Evidence for the Devin provider (`devin`): the probes that answered the
design questions (P1–P13), and the live acceptance of the finished provider
in an isolated DevChain (checks 1–8). The resulting rules and limits are in
`docs/provider-standards.md` ("Devin specifics", private repository).

No key or file content appears here. Account names are omitted.

## Setup

| | |
|---|---|
| Devin | 3000.11.234 from npm (`devin`), the pin in `scripts/host-cli-pins.json` |
| Account | Non-Pro account. Claude models answer "Upgrade to Pro to access this model"; the checks use SWE-2 Flash Medium |
| Isolation | Separate `HOME` for every Devin and DevChain process, `credentials.toml` copied in with mode 0600 and deleted at the end |
| Project | Scratch git project that no real `~/.claude.json` names |
| DevChain (checks 1–8) | Dev instance from branch `feat/devin-provider` on a free port, own DB, own tmux server (`TMUX_TMPDIR`), no Syncthing |
| Platform | Linux |

## Probes (P1–P13)

| # | Question | Command or method | Result |
|---|---|---|---|
| P1 | Install and login from a copied file | `npm install devin@3000.11.234`; copy `credentials.toml` into a fresh `HOME` | Install works. The copied file logs in. A real `credentials.toml` has exactly the 4 keys that DevChain renders, with the same 3 URL values for a standard account. `WINDSURF_API_KEY` alone does not log in |
| P2 | Which hook files run | Hooks in `~/.config/devin/config.json`, `.devin/config.json`, `.devin/config.local.json`, `.devin/hooks.v1.json` | Devin combines all four; all fire, also in `-p` mode. A `//` comment in `.devin/config.local.json` is accepted |
| P3 | Per-session `--config <file>` | `devin --config <file>` with user hooks present | The file replaces the user config: user hooks stop. Devin also writes its own keys into the file. Not usable per session |
| P4 | Can a reader see a half-written export | `strace` of an `--export` write | Devin writes `<path>.partial`, then renames it |
| P5 | Order of Stop hook and export | Stop hook and export timestamps | Stop hooks fire before the export file exists |
| P6 | Export format and tokens | Read the export | ATIF-v1.7. Agent steps carry `prompt_tokens`, `completion_tokens`, `cached_tokens`; SWE steps have no `extra.cache_creation_input_tokens`. Each step's `prompt_tokens` holds the full context. `final_metrics` sums the steps |
| P7 | Terminal input | Interactive session in tmux | No alternate screen. The input line starts with `❭ `. One Ctrl+C clears a draft. Ctrl+C on an empty input only shows "Press Ctrl+C again to exit." |
| P8 | Restore of a session with no message | `devin -r <id>` after a launch with no prompt | "No session found". `SessionStart` already reported that id; no export exists before the first turn |
| P9 | MCP file of `devin mcp add` | `devin mcp add`, then read the files | Strict JSON `{url, transport:"http"}` in `.devin/mcp_config.local.json`, added to `.git/info/exclude`. Devin excludes no other `.devin` file. `devin mcp list` shows the URL |
| P10 | Restore to a new export path | `devin -r <id> --export <new path>` | Full conversation (both user turns) with the same session id. `SessionStart` has `source: resume` |
| P11 | Does the npm install update itself | 5 runs, network watched | No download. The npm install does not update itself |
| P12 | Model list | `devin models list --format json` | Families with `variants[].model_uid`. On this account Claude models fail with "Upgrade to Pro to access this model". The default is SWE-2 Flash Medium |
| P13 | First-run side effects | Fresh `HOME`, first run | Adds a PATH block to `~/.bashrc` and writes setup keys to `~/.config/devin/config.json` |

## Live acceptance (checks 1–8)

| # | Check | Result | Evidence |
|---|---|---|---|
| pre | Managed install at the pin | PASS | `PUT /api/provider-clis/devin {"version":"3000.11.234","homeManaged":true}` → `installedVersion 3000.11.234`; `devin --version` → `devin 3000.11.234`; binary at `<db>/provider-clis/bin/devin` |
| pre | `/mcp` shows only the dev endpoint before any session | PASS | `devin mcp list` → only `devchain` at the dev port, source `.devin/mcp_config.local.json` |
| 1 | First prompt and a real MCP call | PASS* | The seeded argv prompt called `devchain_get_agent_by_name` and `devchain_list_assigned_epics_tasks`. *The first interactive run in a fresh `HOME` inside a git repo first showed "Connect your Git provider"; after "Skip for now" the prompt ran |
| 2 | All three hooks reach DevChain | PASS | `SessionStart`, `UserPromptSubmit`, `Stop` once each; provider session id and transcript path bound. The exclude file has the 3 `.devin` files once each; `git status` shows no `.devin` file |
| 3 | First turn longer than 31 s; transcript still found | PASS | First turn 86.7 s; DevChain read the export in the first poll after Devin wrote it |
| 4 | Stop and restore; the conversation continues | PASS | Restore runs `devin --resume <id> --export …`; the session recalled a code word from before the stop |
| 5 | Claude agent in the same project; no event twice; an old relay is updated | PASS | An old Claude relay without the `DEVCHAIN_HOOK_PROVIDER` guard was replaced at the next Devin launch. Devin loaded both Claude and Devin hooks; each Devin event arrived once. A Claude session's hooks arrived once each; a later Devin turn was still counted once |
| 6 | Login with the credentials file in a fresh `HOME`, interactive and `-p` | PASS | `credentials.toml` rendered by `PROVIDER_AUTH_ADAPTERS.devin.claimFile.render` (4 keys, same content as the real file, 0600). `devin -p 'Reply with exactly: OK'` → "Logged in as …", `OK`, exit 0. Interactive launch logs in |
| 7 | Terminal input, also `/compact` while busy and idle | PASS | Delivery while idle answered. With a user draft, one Ctrl+C cleared it and the message arrived unmerged. While busy, Devin took the message as steering and finished the turn. `/compact` while idle → "Context compacted"; while busy → queued, run after the turn, no harm |
| 8 | Duplicate MCP servers | PASS | `/mcp` in the session → one `devchain — Connected`; the export lists one `devchain` server, although the isolated `~/.claude.json` also names `devchain` for the project |

## Findings from the live checks

- After `/compact` or Devin's auto-compaction the export holds only the summary
  and the new turns, so the Chat tab loses the earlier turns
  (`compactionCount: 1`).
- The "Connect your Git provider" screen appears once per `HOME`, only when no
  earlier Devin run finished setup (`shell.setup_complete` in
  `~/.config/devin/config.json`). A VM claim is not affected: its login check
  runs `devin -p` first.
- Template models: of the SWE candidates, only `swe-2-flash-medium` answered a
  one-word `-p` call on this account; the others need Pro. The `teams-dev`
  template seeds only that model (`apps/local-app/templates-src/teams-dev/template.json`).
- For `swe-*` models the Chat tab shows the pricing catalog's default context
  window, not Devin's own `max_context_tokens`. Context use itself matches
  Devin's own figure.

## Phase 2 probes

Setup: isolated `HOME`s, `credentials.toml` copied in with mode 0600 and
deleted at the end, Devin 3000.11.234 (the pin) and 3000.12.17 from npm,
`-p` mode.

| # | Question | Command or method | Result |
|---|---|---|---|
| Q1 | Can a session move between two stores | `DEVIN_SESSION_STORE=files`, `DEVIN_SESSIONS_DIR=<dir>`; copy one session folder into a fresh `HOME`; round trip A → B → A | No `sessions.db`. Layout: `<dir>/cli/sessions/<two-word id>/log.jsonl` and `meta.json`; store-wide `<dir>/cli/prompt_history.jsonl` and `<dir>/cli/session_locks/*.lock` (a pid, rewritten at the same size). Hooks and `--export` work unchanged. A copy of only `cli/sessions/<id>/` into an empty store resumes with `devin -r <id>` and the full conversation. Round trip: after a new turn on B, a copy back over A's old folder resumes on A with all turns |
| Q1 | How the session files change | Compare files across turns and `/compact` | `log.jsonl` is append-only, also through `/compact`. `meta.json` is rewritten in place: `/compact` changed `main_chain_id` and `last_activity_at` at the same size. A stale same-size `meta.json` with a new `log.jsonl` still resumes, but on the chain from before the compaction |
| Q1 | Version mix and paths | Resume across 3000.11.234 and 3000.12.17; read `meta.json` | A session from either version resumes on the other. `meta.json` stores the absolute `working_directory`. The folder name is the two-word session id, unique only inside one store, so a shared store can overwrite another session of the same name |
| Q2 (side result) | Does an isolated sign-in stay isolated | `devin auth login --force-manual-token-flow` with `HOME` and `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` set to an isolated folder | Config, cache, logs and `installation_id` went only into the isolated folder. Pre-set canary XDG folders stayed empty. The real login file was unchanged (same SHA-256) |
| Q3 | Does `"attribution": false` survive and work | `{ // comment, "attribution": false }` in `~/.config/devin/config.json` before the first run; two runs and `devin mcp add`; Devin writes a commit | The key and the `//` comment survive all three; Devin adds its own keys (`devin`, `shell`, `theme_mode`, `version`). A commit message that Devin writes has no trailers. Control (default config): the commit has "Generated with [Devin](https://devin.ai)" and a "Co-Authored-By: Devin" trailer. With an exact `git commit -m '…'` in the prompt, neither run adds trailers |
| Q4 | Is a long multi-line tool result readable | Pinned 3000.11.234, stub MCP server, isolated `HOME`; a tool returns 60,000 characters as real lines | The result is cut at about 10,000 characters; the overflow file `/tmp/devin-overflows-<uid>/<id>/content.txt` is complete and the model reads it to the end |
| Q5 | Is DevChain-shaped JSON readable | Same setup; the tool returns pretty JSON with the text as one escaped string | The result is cut, and a `grep` over the overflow file is cut again at 2,000 characters per line. Only byte-range reads recover the text |
| Q6 | Does JSON plus the text as real lines work | Same setup; the tool returns the JSON, then the text as real lines | The model reads the overflow file with line tools and reaches the end of the text |
| Q7 | Can several sessions of one project share one store | One `HOME` and one `DEVIN_SESSIONS_DIR`, as for the agents of one project; 3 first turns started at the same moment on 3000.11.234 and 2 on 3000.12.17, then the same number of resumes at the same moment | Each run answers. Each session gets its own folder and its own `session_locks/<id>.lock`; the store has one `__import__.lock`. `prompt_history.jsonl` has one valid JSON line per prompt. Each resume answers with its own code word. No `sessions.db` is created |

## Phase 2 live VM acceptance

2026-11-09, run by the user (sub-epic 3b50fecc). The user tested Devin in a
claimed VM and on the PC without a VM, and reported that it works. No failure
was reported. The user gave no result per check, so the 9 checks of that
sub-epic are not recorded one by one. Checks 8 (a long SOP over MCP) and 9
(agent-written long text) have no recorded evidence.

## Not covered

- Per-check evidence of the Phase 2 live VM acceptance (see above).
- Accounts with other server URLs than the standard three.
- Lane work in a worktree, and the Vault canary.

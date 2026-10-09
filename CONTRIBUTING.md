# Contributing to DevChain

This guide shows how to set up a development checkout, run DevChain from source, and check a change before you share it.

Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Requirements

- Node.js and pnpm in the versions that `package.json` sets (`engines` and `packageManager`).
- tmux for agent terminal sessions.
- OpenSSL (the `openssl` command): tests generate throwaway TLS certificates with it.

## Run from source

Run these commands from the repository root:

```bash
pnpm install
pnpm dev
```

`pnpm dev` builds the shared package and starts the launcher with API and UI hot reload. [Local App Development](apps/local-app/DEV.md) describes the runtime modes, ports, commands, and diagnostics.

## Project structure

| Path                                     | Contents                                                            |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `apps/local-app`                         | The DevChain app: NestJS API, React UI, MCP server, and their tests |
| `packages/shared`                        | Code and schemas that more than one package uses                    |
| `packages/proxmox-client`                | Client for Proxmox VM providers                                     |
| `apps/host-bootstrap`, `apps/host-image` | Installer and image inputs for remote VM hosts                      |
| `scripts`                                | The `devchain` CLI, build helpers, and template tooling             |

## Common commands

| Purpose                      | Command                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| Full build                   | `pnpm build`                                                      |
| Local App build (API and UI) | `pnpm --filter local-app build`                                   |
| Lint                         | `pnpm lint`                                                       |
| Format                       | `pnpm format`                                                     |
| Tests                        | `pnpm test`                                                       |
| One test file                | `pnpm --filter local-app test -- --runTestsByPath <path-to-spec>` |

## Before you share a change

1. Build the Local App.
2. Run lint.
3. Run the tests that cover your change.
4. Add or update tests at the layer where the change lives.

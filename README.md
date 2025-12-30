# Devchain

AI driven development platform

**[Homepage](https://devchain.twitechlab.com/)** · **[GitHub](https://github.com/twitech-lab/devchain)**

Devchain coordinates AI coding agents (Claude, Codex) through a visual workflow interface with tmux-backed terminal sessions.

## Features

- **Visual Workflow Board** — Kanban-style epic management with drag-and-drop
- **Terminal Sessions** — Real terminal streaming via tmux and WebSocket
- **Multi-Agent Support** — Works with Claude and Codex CLI providers
- **MCP Integration** — Model Context Protocol for agent tool access
- **Local-First** — All data stored locally, no cloud dependency

## Requirements

- **Node.js** >= 20
- **tmux** — Required for terminal sessions
  - macOS: `brew install tmux`
  - Ubuntu/Debian: `sudo apt install tmux`
- **AI Provider** — At least one of:
  - `claude` CLI
  - `codex` CLI

## Installation

```bash
npm install -g devchain-cli
```

Or with pnpm:

```bash
pnpm add -g devchain-cli
```

## Usage

```bash
# Start Devchain (opens browser automatically)
devchain start

# Start in foreground with logs
devchain start --foreground

# Start on a specific port
devchain start --port 5000

# Start with a specific project
devchain start --project /path/to/your/project

# Stop the server
devchain stop
```

## CLI Options

| Option | Description |
|--------|-------------|
| `-p, --port <number>` | Port to run on (default: 3000 or next available) |
| `-f, --foreground` | Run in foreground with visible logs |
| `--no-open` | Don't open browser automatically |
| `--db <path>` | Custom database directory path |
| `--project <path>` | Open with a specific project path |

## Help

```bash
devchain --help
```

## License

[Elastic License 2.0](LICENSE) — Free to use. You may not provide this software as a managed service or competing commercial offering.

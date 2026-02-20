# Devchain

> AI agent orchestration platform for software development teams

[![npm version](https://img.shields.io/npm/v/devchain-cli)](https://www.npmjs.com/package/devchain-cli)
[![License: Elastic-2.0](https://img.shields.io/badge/license-Elastic--2.0-blue)](LICENSE)

**[Homepage](https://devchain.twitechlab.com/)** · **[What's New in v0.10.0](https://devchain.twitechlab.com/releases/0.10.0/)**

Devchain runs your AI coding agents as a coordinated team — each with their own terminal session, task queue, and chat. Assign epics, track progress on a visual board, and let agents collaborate through a structured workflow. Supports Claude Code, Codex, and Gemini CLI out of the box.

---

## Features

### Worktrees
Spin up isolated agent environments on dedicated git branches. Each worktree gets its own agent team, terminals, and chat — run multiple features in parallel and merge when ready. Worktrees run as Docker containers or local processes with full branch isolation.

### Container Isolation
Worktree containers are provisioned automatically from the official Devchain image on [GHCR](https://github.com/orgs/TwiTech-LAB/packages/container/package/devchain). Each container has Claude Code, Codex, and Gemini CLI pre-installed, runs as a non-root user, and shares your git identity for correct commit attribution.

### Skills
Browse and sync AI agent skills from community sources (Anthropic, OpenAI, Vercel, and more). Enable or disable skills per project and expose them to agents via MCP tools.

### Visual Workflow Board
Kanban-style epic management with drag-and-drop, list view, board context menu, and URL-based filtering. Agents pick up tasks from the board and update status in real time.

### Terminal Sessions
Real terminal streaming via tmux and WebSocket. Each agent gets its own session with scrollback, resize support, and inline access from the chat panel.

### Code Review
Live pre-commit diff viewer with agent integration, inline comments, `@mentions`, comment threading, and VS Code-style file navigation.

### Multi-Provider
Works with Claude Code, OpenAI Codex, Google Gemini CLI, and GLM models. Switch providers per agent or switch the whole team preset with a single click.

### MCP Integration
Full Model Context Protocol support. Agents get access to epics, chat, skills, reviews, and more through MCP tools — auto-configured before each session.

### Local-First
All data stored in a local SQLite database. No cloud account required, no data leaving your machine.

---

## Requirements

- **Node.js** >= 20
- **tmux** — required for terminal sessions
  - macOS: `brew install tmux`
  - Ubuntu/Debian: `sudo apt install tmux`
- **Docker** — optional, required for container-isolated worktrees
- **AI Provider** — at least one of:
  - [`claude`](https://claude.ai/claude-code) CLI
  - [`codex`](https://github.com/openai/codex) CLI
  - [`gemini`](https://github.com/google-gemini/gemini-cli) CLI

---

## Installation

```bash
npm install -g devchain-cli
```

```bash
pnpm add -g devchain-cli
```

---

## Quick Start

```bash
# Start Devchain — opens browser automatically
devchain start

# Start with a specific project
devchain start --project /path/to/your/project

# Run in foreground with logs
devchain start --foreground

# Stop the server
devchain stop
```

On first run, import a template from the project page to provision your agent team. Two templates are included:

| Template | Agents | Best for |
|----------|--------|----------|
| `5-agents-dev` | Brainstormer, Epic Manager, SubBSM, Coder, Code Reviewer | Complex projects with full planning |
| `3-agents-dev` | Brainstormer, SubBSM, Coder | Faster iteration with lower token overhead |

---

## CLI Options

| Option | Description |
|--------|-------------|
| `-p, --port <number>` | Port to run on (default: 3000 or next available) |
| `-f, --foreground` | Run in foreground with visible logs |
| `--no-open` | Don't open browser automatically |
| `--db <path>` | Custom database directory path |
| `--project <path>` | Open with a specific project path |

---

## License

[Elastic License 2.0](LICENSE) — Free to use. You may not provide this software as a managed service or competing commercial offering.

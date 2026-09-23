# Contributing to Devchain

Welcome to the Devchain project! This guide will help you set up your development environment and understand the project structure.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 24.0.0 (Node 24 LTS is the production floor)
- **pnpm** >= 8.0.0
- **tmux** (required for terminal session management on Linux/macOS)
- At least one AI provider CLI:
  - `claude` - Claude Code CLI
  - `codex` - Codex CLI
  - `opencode` - OpenCode CLI
  - `agy` - Google Antigravity CLI
  - `copilot` - GitHub Copilot CLI

## Getting Started

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd devchain
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Start development**
   ```bash
   pnpm dev
   ```

## Development Scripts

Use [Common Commands](docs/operations.md#common-commands) for development, build, lint, format, and database tasks, and [Test commands](docs/operations.md#test-commands) for test entry points.

## Project Structure

Use the [Code Map](docs/code-map.md) to find packages, entry points, and generated outputs.

## Architecture

Use [Architecture](docs/architecture.md) for subsystem boundaries and [Local App Development](apps/local-app/DEV.md#runtime-modes) for API/UI ports and runtime modes.

## Development Mode (`pnpm dev`)

The launcher validates prerequisites and starts hot reload. See [CLI startup checks](docs/cli.md) and [Local App Development](apps/local-app/DEV.md) for the exact flow.

## Skipping Validations

Use the bypass options in [Common Commands](docs/operations.md#common-commands) and [Environment variables](docs/operations.md#environment-variables-local-app) when the environment is already configured.

## Environment Variables

Names, defaults, and per-session precedence live in [Operations](docs/operations.md#environment-variables-local-app).

## Building

Use [Common Commands](docs/operations.md#common-commands): the Local App fast build includes both API and UI; `build:ui` is the UI-only target.

## Troubleshooting

Use [Setup](docs/setup.md) for missing prerequisites and [Local App diagnostics](apps/local-app/DEV.md#diagnostics) for ports, blank UI, proxy failures, or missing build output.

Before review, follow [Development Standards](docs/development-standards.md#build-test-and-validation-before-review). Agents start with [AGENTS](docs/AGENTS.md).

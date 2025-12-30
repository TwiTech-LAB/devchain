# Contributing to Devchain

Welcome to the Devchain project! This guide will help you set up your development environment and understand the project structure.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** >= 20.0.0
- **pnpm** >= 8.0.0
- **tmux** (required for terminal session management on Linux/macOS)
- At least one AI provider CLI:
  - `claude` - Claude CLI
  - `codex` - Codex CLI

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

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start with CLI validations + hot reload (recommended) |
| `pnpm dev:pure` | Skip CLI validations, instant startup (escape hatch) |
| `pnpm build` | Production build |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run tests |
| `pnpm start` | Start production server |

## Project Structure

```
devchain/
├── scripts/
│   └── cli.js          # CLI entry point
├── apps/
│   └── local-app/      # NestJS API + Vite UI
│       ├── src/
│       │   ├── modules/    # API modules
│       │   └── ui/         # React UI
│       └── vite.config.ts
├── docs/               # Documentation
└── package.json
```

## Architecture

- **API**: NestJS running on port 3000 (or next available)
- **UI**: Vite dev server on port 5175 (proxies API requests)
- **Database**: SQLite via better-sqlite3

## Development Mode (`pnpm dev`)

When you run `pnpm dev`, the CLI performs these validations:

1. **tmux check** - Ensures tmux is installed
2. **Provider detection** - Checks for `claude` or `codex` on PATH
3. **MCP configuration** - Validates MCP server registration
4. **Claude bypass permissions** - Prompts to enable auto-approval (if Claude detected)

Then it starts:
- NestJS API with `nest start --watch` (hot reload)
- Vite UI with HMR on port 5175

## Skipping Validations

For quick restarts when you know everything is configured:

```bash
# Skip all CLI validations
pnpm dev:pure

# Skip individual checks via environment variables
DEVCHAIN_SKIP_TMUX_CHECK=1 pnpm dev
DEVCHAIN_SKIP_PROVIDER_CHECK=1 pnpm dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | 3000 |
| `HOST` | API server host | 127.0.0.1 |
| `LOG_LEVEL` | Pino log level | error (interactive), info (foreground) |
| `DB_PATH` | Database directory | ~/.devchain |
| `DEVCHAIN_SKIP_TMUX_CHECK` | Skip tmux validation | - |
| `DEVCHAIN_SKIP_PROVIDER_CHECK` | Skip provider detection | - |

## Building

```bash
# Full build (API + UI + CLI packaging)
pnpm build

# Quick UI-only build
pnpm build:fast
```

## Troubleshooting

### API not starting
- Check if port 3000 is available, or specify a different port with `--port`
- Ensure dependencies are installed: `pnpm install`

### UI not loading
- The UI runs on port 5175 in dev mode
- Check that the API is healthy: `curl http://localhost:3000/health`

### Provider not detected
- Ensure `claude` or `codex` is installed and on your PATH
- Test with: `which claude` or `which codex`

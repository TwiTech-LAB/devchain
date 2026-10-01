# Local App Development Guide

This runbook covers Local App development modes and app-specific diagnostics. Repository-wide commands and architectural contracts live in root `docs/`.

## Runtime modes

### Development

`pnpm --filter local-app dev` runs two loopback-bound processes:

| Process | Default | Role |
|---|---|---|
| NestJS API | `http://127.0.0.1:3000` | REST, MCP, WebSocket, health, Swagger |
| Vite | `http://127.0.0.1:5175` | React UI, HMR, and proxying to the API |

Use `dev:api` or `dev:ui` when only one side is needed. `vite.config.ts` is canonical for the UI port, proxy routes, and build directory.

### Built runtime

```bash
pnpm --filter local-app build
pnpm --filter local-app start
```

Nest compiles the backend into `dist/`; Vite writes the SPA to `dist/ui`; templates are copied into `dist/templates`. The production process serves API and built UI from the Nest app.

## Loopback security

The default `HOST` is `127.0.0.1`. Keep it for single-machine use. Binding to `0.0.0.0`, `::`, or a LAN address exposes the API, MCP, WebSocket, and terminal surfaces; follow [root Setup](../../docs/setup.md#remote-access) and [Risks](../../docs/risks.md) before doing so.

## Commands

| Task | Command |
|---|---|
| API + UI development | `pnpm --filter local-app dev` |
| API only | `pnpm --filter local-app dev:api` |
| UI only | `pnpm --filter local-app dev:ui` |
| Build | `pnpm --filter local-app build` |
| Unit/integration/UI aggregate | `pnpm --filter local-app test` |
| Browser UI | `pnpm --filter local-app test:ui` |
| Low-memory tests | `pnpm --filter local-app test:lowmem` |
| Lint | `pnpm --filter local-app lint` |
| Dependency cycles | `pnpm --filter local-app madge:check` |
| Migration journal | `pnpm --filter local-app check:journal` |

The manifest is canonical for the complete command set. Use [root Testing](../../docs/testing.md) for suite selection and traps.

## Configuration

`src/common/config/env.config.ts` defines runtime config and defaults. Important local values include `HOST`, `PORT`, `LOG_LEVEL`, and `DATABASE_PATH`. Storage is SQLite-only through `LocalStorageService`; no Remote API storage adapter is registered.

## Diagnostics

- Port conflict: inspect with `lsof -nP -iTCP:3000 -sTCP:LISTEN` and `lsof -nP -iTCP:5175 -sTCP:LISTEN`; stop the identified process normally.
- Blank UI: verify both processes, inspect the browser console, and confirm Vite is serving `127.0.0.1:5175`.
- Proxy/CORS failure: check `vite.config.ts` proxy routes and the API log; browser API traffic in dev should pass through Vite.
- Built UI missing: verify `dist/ui/index.html`; `dist/client` is not the current output.

## Read next

- [Local App README](README.md)
- [Root Operations](../../docs/operations.md)
- [Root Architecture](../../docs/architecture.md)
- [Migration scripts](scripts/README.md)

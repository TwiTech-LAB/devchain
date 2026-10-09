# Local App

The Local App is DevChain's local-first NestJS and React/Vite application. It manages the SQLite-backed workspace, tmux/PTY sessions, MCP tools, and the browser UI.

Storage is local-only: `StorageModule` binds `STORAGE_SERVICE` to the singleton `LocalStorageService` (`src/modules/storage/storage.module.ts`; locked by `src/modules/storage/storage.binding.spec.ts`). No Remote API storage adapter is registered.

## Read next

- [Local development](DEV.md) — app-scoped development workflow, ports, and build output.
- [Contributing](../../CONTRIBUTING.md) — first checkout, repository commands, and checks before review.
- [Test helpers](test/helpers/README.md) — integration fixture contracts.

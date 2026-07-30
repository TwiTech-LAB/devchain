# CLI Helper Tests

These tests are wired into `pnpm --filter local-app test` via a third Jest project
(`cli-helpers`) declared in `apps/local-app/package.json`. The project uses
`rootDir: ../../scripts` to point at this directory. No separate invocation needed.

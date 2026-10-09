# Local App Scripts

This index explains maintained migration and diagnostic scripts. Script source and `package.json` are canonical; historical scripts are not templates for new migrations.

## Migration commands

| Task | Command |
|---|---|
| Validate journal | `pnpm --filter local-app check:journal` |
| Generate migration | `pnpm --filter local-app db:generate` |
| Apply migrations | `pnpm --filter local-app db:migrate` |
| Inspect with Drizzle Studio | `pnpm --filter local-app db:studio` |
| Verify current schema | `pnpm --filter local-app exec ts-node scripts/verify-schema.ts` |
| Inspect applied migrations | `pnpm --filter local-app exec ts-node scripts/check-migrations.ts` |

The schema source is `src/modules/storage/db/schema.ts`; committed migrations and journal metadata live in `drizzle/`. Use `scripts/migrate.ts` only when its explicit SQLite path/control is required. Do not use one-time repair scripts as the normal migration path.

## Pre-change checks

1. Stop Local App processes and active sessions that can write the database.
2. Back up the actual database path reported by current config.
3. Run `check:journal` before generating or applying a migration.
4. Review generated SQL and journal changes.
5. Apply against a disposable copy before the operator database.
6. Run schema verification and the relevant storage integration tests.

## Diagnostic and maintenance scripts

| Script | Role |
|---|---|
| `check-cycles.ts` | Dependency-cycle validation used by `madge:check` |
| `fetch-pricing-data.ts` | Manual provider pricing refresh via `pnpm --filter local-app pricing:update` |
| `test-health-report.ts` | Render test-health evidence from generated Jest output |
| `terminal-window-heap-evidence.mjs` | Focused terminal heap evidence |
| `xterm6-browser-smoke.mjs` | Browser smoke contract for xterm compatibility |
| `memory-soak/` | Opt-in memory-soak harness and its runbook |

## Historical repair scripts

`manual-migration.ts`, `cleanup-and-fix.ts`, `fix-migrations.ts`, `apply-migration-0001.ts`, and the `fix-agent-profiles-schema*.ts` files record earlier recovery work. Do not run them against a current database without a code-backed incident procedure.

## Memory soak

The opt-in harness is documented in `memory-soak/README.md`. Its artifact hashes, fixtures, evidence language, and comparison authority are correctness-bearing; do not simplify that runbook as ordinary conceptual documentation.

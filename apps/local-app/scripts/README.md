# Migration Helper Scripts

This directory contains helper scripts for database migrations and verification.

The opt-in memory integration harness is documented in [`memory-soak/README.md`](memory-soak/README.md). Run a named scenario with `pnpm --filter local-app memory-soak -- --scenario host-burst-plateau`; it is intentionally outside the default test gate.

## 🎯 Quick Reference

### Run Migrations
```bash
npx tsx scripts/migrate.ts
```

### Verify Database State
```bash
npx tsx scripts/verify-schema.ts
npx tsx scripts/check-migrations.ts
```

## 📋 Available Scripts

### Core Migration Scripts

- **`migrate.ts`**
  Runs Drizzle migrations from `/drizzle` folder
  ```bash
  npx tsx scripts/migrate.ts
  ```

- **`manual-migration.ts`**
  Example of manual migration for complex schema changes
  Used for migration 0001 to create providers table

- **`cleanup-and-fix.ts`**
  Fixed agent_profiles schema (removed old provider column)
  **Note:** This was a one-time fix, kept as reference

### Verification Scripts

- **`verify-schema.ts`**
  Comprehensive schema verification:
  - Checks for old/new columns
  - Verifies constraints (NOT NULL, FK, etc.)
  - Lists applied migrations
  ```bash
  npx tsx scripts/verify-schema.ts
  ```

- **`check-migrations.ts`**
  Shows database tables and applied migrations
  ```bash
  npx tsx scripts/check-migrations.ts
  ```

- **`check-providers-table.ts`**
  Provider-specific verification:
  - Table schema
  - Row count
  - Provider list
  ```bash
  npx tsx scripts/check-providers-table.ts
  ```

### One-Time Fix Scripts (Historical)

These were used to fix the initial migration issues:

- `fix-migrations.ts` - Fixed migration tracking
- `apply-migration-0001.ts` - Attempted automatic migration
- `fix-agent-profiles-schema.ts` - First attempt at schema fix
- `fix-agent-profiles-schema-safe.ts` - Second attempt with FK handling

**You don't need to run these again** - they're kept for reference.

## ✅ Current Database State

**Schema Status:** ✅ Correct
- `providers` table exists with proper schema
- `agent_profiles.provider_id` is NOT NULL and references providers
- Old `provider` column removed
- All foreign keys working

**Migration Status:** ✅ Tracked
- Migration 0000: ✅ Applied & tracked
- Migration 0001: ✅ Applied & tracked

**API Status:** ✅ Working
- `/api/providers` - Returns providers with providerId
- `/api/profiles` - Returns profiles with providerId

## 🚀 Future Migrations

For future schema changes:

1. Modify `/src/modules/storage/db/schema.ts`
2. Generate migration: `pnpm db:generate`
3. Apply migration: `npx tsx scripts/migrate.ts`
4. Verify: `npx tsx scripts/verify-schema.ts`

See `/apps/local-app/MIGRATIONS.md` for detailed guide.

## 🐛 Troubleshooting

If migrations fail:
1. Run `npx tsx scripts/check-migrations.ts` to see current state
2. Run `npx tsx scripts/verify-schema.ts` to check schema
3. Check `/apps/local-app/MIGRATIONS.md` for common issues
4. For complex fixes, use the one-time scripts as templates

## 📚 Learn More

- Full migration guide: `/apps/local-app/MIGRATIONS.md`
- Schema definition: `/src/modules/storage/db/schema.ts`
- Migration folder: `/drizzle`

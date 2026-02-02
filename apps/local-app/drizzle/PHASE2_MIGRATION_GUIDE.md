# Phase 2 Migration Guide: Profile Provider Configs

## Overview

Phase 2 migrations populate the `profile_provider_configs` table and merge duplicate profiles.

**Migrations:**
- `0028_populate_provider_configs.sql` - Create configs from existing profiles
- `0029_merge_profiles_by_family_slug.sql` - Merge profiles with same familySlug
- `0030_set_agents_provider_config_id.sql` - Set agent config references

## Pre-Migration Checklist

### 1. Stop All Sessions

Before running migrations, ensure no active sessions exist:

```bash
sqlite3 ~/.devchain/devchain.db < apps/local-app/drizzle/migration-guard.sql
```

If any output is shown, stop the sessions first:
```bash
# List running sessions
sqlite3 ~/.devchain/devchain.db "SELECT id, agent_id FROM sessions WHERE status='running';"

# Stop sessions via UI or terminate tmux sessions
```

### 2. Create Backup

**CRITICAL:** Always backup before migrating:

```bash
cp ~/.devchain/devchain.db ~/.devchain/devchain.db.backup-$(date +%Y%m%d-%H%M%S)
```

### 3. Verify Backup

```bash
sqlite3 ~/.devchain/devchain.db.backup-* "SELECT COUNT(*) FROM agent_profiles;"
```

## Running Migrations

```bash
pnpm --filter local-app db:migrate
```

Or manually:
```bash
sqlite3 ~/.devchain/devchain.db < apps/local-app/drizzle/0028_populate_provider_configs.sql
sqlite3 ~/.devchain/devchain.db < apps/local-app/drizzle/0029_merge_profiles_by_family_slug.sql
sqlite3 ~/.devchain/devchain.db < apps/local-app/drizzle/0030_set_agents_provider_config_id.sql
```

## Post-Migration Verification

```bash
# Verify configs created
sqlite3 ~/.devchain/devchain.db "SELECT COUNT(*) FROM profile_provider_configs;"

# Verify no duplicate familySlug groups
sqlite3 ~/.devchain/devchain.db "SELECT project_id, family_slug, COUNT(*) FROM agent_profiles WHERE family_slug IS NOT NULL GROUP BY project_id, family_slug HAVING COUNT(*) > 1;"

# Verify all agents have config
sqlite3 ~/.devchain/devchain.db "SELECT COUNT(*) FROM agents WHERE provider_config_id IS NULL;"
```

## Rollback Procedure

### Recommended: Restore from Backup

```bash
# Stop the application
# Restore backup
cp ~/.devchain/devchain.db.backup-YYYYMMDD-HHMMSS ~/.devchain/devchain.db

# Restart the application
```

### Alternative: Partial Rollback Script

**WARNING:** The partial rollback script cannot restore deleted profiles from the merge step.

```bash
sqlite3 ~/.devchain/devchain.db < apps/local-app/drizzle/phase2-rollback.sql
```

This will:
1. Clear `agents.provider_config_id` (set to NULL)
2. Delete all `profile_provider_configs` records
3. Remove migration tracking entries

**NOT restored:** Profiles deleted during merge (0029) cannot be restored without backup.

## Troubleshooting

### Migration fails with "database is locked"
- Stop all sessions and the application
- Ensure no other process is accessing the database

### Agents have NULL providerConfigId after migration
- Verify profile has a config: `SELECT * FROM profile_provider_configs WHERE profile_id = '<profile_id>';`
- Re-run migration 0030

### Profile configs missing
- Check if profile has providerId: `SELECT provider_id FROM agent_profiles WHERE id = '<profile_id>';`
- Profiles with NULL providerId don't get configs created

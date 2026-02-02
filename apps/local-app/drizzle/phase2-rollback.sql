-- Phase 2 Rollback Script
-- WARNING: This rollback is DESTRUCTIVE and will lose data created after migration
--
-- RECOMMENDED APPROACH: Restore from backup instead of using this script
--
-- Before running Phase 2 migrations, create a backup:
--   cp ~/.devchain/devchain.db ~/.devchain/devchain.db.backup-$(date +%Y%m%d-%H%M%S)
--
-- To rollback, restore from backup:
--   cp ~/.devchain/devchain.db.backup-YYYYMMDD-HHMMSS ~/.devchain/devchain.db

-- ============================================
-- ROLLBACK STEP 1: Clear agents.providerConfigId
-- Reverses: 0030_set_agents_provider_config_id.sql
-- ============================================
UPDATE agents SET provider_config_id = NULL;

--> statement-breakpoint

-- ============================================
-- ROLLBACK STEP 2: Delete all provider configs
-- Reverses: 0028_populate_provider_configs.sql and configs moved by merge
-- NOTE: This loses any configs created/modified after migration
-- ============================================
DELETE FROM profile_provider_configs;

--> statement-breakpoint

-- ============================================
-- ROLLBACK STEP 3: Cannot easily reverse profile merge (0029)
-- The merged profiles were DELETED - they cannot be restored without backup
--
-- Options:
-- 1. Restore from backup (RECOMMENDED)
-- 2. Recreate profiles manually from application state
-- 3. Accept merged state (profiles remain merged)
-- ============================================

-- Remove migration records from tracking table
DELETE FROM __drizzle_migrations WHERE hash IN (
    '0028_populate_provider_configs',
    '0029_merge_profiles_by_family_slug',
    '0030_set_agents_provider_config_id'
);

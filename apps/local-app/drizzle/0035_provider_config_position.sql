-- Migration: Add position column to profile_provider_configs
-- This enables drag-and-drop ordering of provider configs within a profile

-- Step 1: Add position column with default 0
ALTER TABLE profile_provider_configs ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Step 2: Backfill positions based on createdAt order per profile
-- Uses CTE with ROW_NUMBER() to assign sequential positions (0, 1, 2, ...)
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at ASC, id ASC) - 1 AS pos
  FROM profile_provider_configs
)
UPDATE profile_provider_configs
SET position = (
  SELECT pos
  FROM ranked
  WHERE ranked.id = profile_provider_configs.id
);
--> statement-breakpoint

-- Step 3: Create unique index on (profile_id, position)
CREATE UNIQUE INDEX profile_provider_configs_profile_position_idx
ON profile_provider_configs(profile_id, position);

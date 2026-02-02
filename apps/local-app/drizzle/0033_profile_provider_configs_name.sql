-- Migration: Add name column to profile_provider_configs
-- This enables multiple configs per provider per profile (GLM use case)

-- Step 1: Add name column with default empty string
ALTER TABLE profile_provider_configs ADD COLUMN name TEXT NOT NULL DEFAULT '';
--> statement-breakpoint

-- Step 2: Backfill existing rows with deterministic names (provider_name + order suffix if needed)
-- Uses a CTE to assign row numbers per profile, then updates with provider-based names
WITH ranked_configs AS (
  SELECT
    ppc.id,
    p.name AS provider_name,
    ROW_NUMBER() OVER (
      PARTITION BY ppc.profile_id, ppc.provider_id
      ORDER BY ppc.created_at ASC, ppc.id ASC
    ) AS rn,
    COUNT(*) OVER (
      PARTITION BY ppc.profile_id, ppc.provider_id
    ) AS total_for_provider
  FROM profile_provider_configs ppc
  JOIN providers p ON p.id = ppc.provider_id
)
UPDATE profile_provider_configs
SET name = (
  SELECT
    CASE
      WHEN rc.total_for_provider = 1 THEN rc.provider_name
      ELSE rc.provider_name || '-' || rc.rn
    END
  FROM ranked_configs rc
  WHERE rc.id = profile_provider_configs.id
)
WHERE name = '';
--> statement-breakpoint

-- Step 3: Create unique index on (profile_id, name)
CREATE UNIQUE INDEX profile_provider_configs_profile_name_idx ON profile_provider_configs(profile_id, name);

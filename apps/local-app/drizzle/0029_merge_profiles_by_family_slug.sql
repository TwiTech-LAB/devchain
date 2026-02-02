-- Phase 2 Migration: Auto-merge profiles by familySlug
-- For each (projectId, familySlug) group with multiple profiles:
-- 1. Keep oldest as canonical
-- 2. Capture agent→providerId mapping (BEFORE profile deletion)
-- 3. Move provider configs to canonical
-- 4. Set agents.provider_config_id based on original providerId
-- 5. Update agents to point to canonical profile
-- 6. Delete merged profiles

-- Step 1: Create temp table identifying canonical profiles (oldest per group)
CREATE TEMP TABLE canonical_profiles AS
WITH ranked AS (
    SELECT
        id,
        project_id,
        family_slug,
        created_at,
        ROW_NUMBER() OVER (PARTITION BY project_id, family_slug ORDER BY created_at ASC) as rn
    FROM agent_profiles
    WHERE family_slug IS NOT NULL
)
SELECT id as canonical_id, project_id, family_slug
FROM ranked
WHERE rn = 1
AND EXISTS (
    SELECT 1 FROM ranked r2
    WHERE r2.project_id = ranked.project_id
    AND r2.family_slug = ranked.family_slug
    AND r2.rn > 1
);

--> statement-breakpoint

-- Step 2: Create temp table with profiles to merge (non-canonical in groups)
CREATE TEMP TABLE profiles_to_merge AS
WITH ranked AS (
    SELECT
        id,
        project_id,
        family_slug,
        ROW_NUMBER() OVER (PARTITION BY project_id, family_slug ORDER BY created_at ASC) as rn
    FROM agent_profiles
    WHERE family_slug IS NOT NULL
)
SELECT ranked.id as merge_id, cp.canonical_id
FROM ranked
JOIN canonical_profiles cp
    ON ranked.project_id = cp.project_id
    AND ranked.family_slug = cp.family_slug
WHERE ranked.rn > 1;

--> statement-breakpoint

-- Step 3: Capture agent→providerId mapping BEFORE profiles are merged/deleted
-- This preserves which provider each agent was originally using
CREATE TEMP TABLE agent_original_provider AS
SELECT a.id as agent_id, ap.provider_id
FROM agents a
JOIN agent_profiles ap ON a.profile_id = ap.id
WHERE a.profile_id IN (SELECT merge_id FROM profiles_to_merge);

--> statement-breakpoint

-- Step 4: Update provider configs - move from merged profiles to canonical
UPDATE profile_provider_configs
SET profile_id = (
    SELECT canonical_id FROM profiles_to_merge ptm
    WHERE ptm.merge_id = profile_provider_configs.profile_id
)
WHERE profile_id IN (SELECT merge_id FROM profiles_to_merge);

--> statement-breakpoint

-- Step 5: Set agents.provider_config_id based on original providerId
-- Match each agent to the config in their new canonical profile that has the same providerId
UPDATE agents
SET provider_config_id = (
    SELECT ppc.id
    FROM agent_original_provider aop
    JOIN profiles_to_merge ptm ON agents.profile_id = ptm.merge_id
    JOIN profile_provider_configs ppc ON ppc.profile_id = ptm.canonical_id
    WHERE aop.agent_id = agents.id
    AND ppc.provider_id = aop.provider_id
    LIMIT 1
)
WHERE profile_id IN (SELECT merge_id FROM profiles_to_merge)
AND provider_config_id IS NULL;

--> statement-breakpoint

-- Step 6: Update agents - point to canonical profile
UPDATE agents
SET profile_id = (
    SELECT canonical_id FROM profiles_to_merge ptm
    WHERE ptm.merge_id = agents.profile_id
)
WHERE profile_id IN (SELECT merge_id FROM profiles_to_merge);

--> statement-breakpoint

-- Step 7: Delete merged profiles
DELETE FROM agent_profiles
WHERE id IN (SELECT merge_id FROM profiles_to_merge);

--> statement-breakpoint

-- Step 8: Cleanup temp tables
DROP TABLE agent_original_provider;

--> statement-breakpoint

DROP TABLE profiles_to_merge;

--> statement-breakpoint

DROP TABLE canonical_profiles;

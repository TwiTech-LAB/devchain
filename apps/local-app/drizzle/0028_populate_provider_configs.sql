-- Phase 2 Migration: Populate profile_provider_configs from existing profiles
-- For each profile with a providerId, create a corresponding provider config record

INSERT INTO profile_provider_configs (id, profile_id, provider_id, options, env, created_at, updated_at)
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))) as id,
    id as profile_id,
    provider_id,
    options,
    NULL as env,
    datetime('now') as created_at,
    datetime('now') as updated_at
FROM agent_profiles
WHERE provider_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM profile_provider_configs ppc
    WHERE ppc.profile_id = agent_profiles.id
      AND ppc.provider_id = agent_profiles.provider_id
  );

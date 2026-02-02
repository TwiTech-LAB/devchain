-- Phase 2 Migration: Set agents.providerConfigId
-- For agents not handled by 0029 (non-merged profiles), set providerConfigId
-- Match config by profile's provider_id (not by creation order)

UPDATE agents
SET provider_config_id = (
    SELECT ppc.id
    FROM profile_provider_configs ppc
    JOIN agent_profiles ap ON ap.id = agents.profile_id
    WHERE ppc.profile_id = agents.profile_id
    AND ppc.provider_id = ap.provider_id
    LIMIT 1
)
WHERE provider_config_id IS NULL;

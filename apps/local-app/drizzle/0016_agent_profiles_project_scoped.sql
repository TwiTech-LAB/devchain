-- This migration is now a no-op because agent_profiles.project_id column and unique index were backported to migration 0000
-- Originally made agent_profiles project-scoped by adding project_id column and unique index,
-- but this is now included in the initial schema to support fresh database creation without errors.
SELECT 1 WHERE 1=0;

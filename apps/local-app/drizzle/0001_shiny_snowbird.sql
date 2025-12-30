-- This migration is now a no-op because all changes were backported to migration 0000
-- Originally:
-- - Created providers table
-- - Migrated agent_profiles from provider/model to provider_id
-- - Migrated records table from key/value to type/data
-- All these changes are now included in the initial schema to support fresh database creation without errors.
SELECT 1 WHERE 1=0;

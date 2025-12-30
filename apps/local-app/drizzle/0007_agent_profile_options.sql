-- This migration is now a no-op because options column was backported to migration 0000
-- Originally:
-- - Added options column to agent_profiles
-- - Migrated model column data into options column
-- - Updated foreign key constraints for sessions table
-- All relevant schema changes are now included in the initial schema to support fresh database creation without errors.
SELECT 1 WHERE 1=0;

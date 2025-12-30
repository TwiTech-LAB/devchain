-- This migration is now a no-op because is_template column was backported to migration 0000
-- Originally added is_template column to projects table, but this is now included in the initial schema
-- to support fresh database creation without errors.
SELECT 1 WHERE 1=0;

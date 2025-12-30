-- This migration is now a no-op for fresh databases (0013 was fixed to create the correct schema)
-- For existing databases that already ran the old 0013, manual migration may be needed
-- No-op statement required for Drizzle migrator
SELECT 1 WHERE 1=0;


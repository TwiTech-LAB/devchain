-- Add activity tracking columns to sessions table
-- Note: These columns exist in 0000 for the schema, but due to migration ordering/snapshot issues,
-- they may not exist in actual databases. Using ALTER TABLE ensures they're added if missing.
ALTER TABLE sessions ADD COLUMN last_activity_at text;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN activity_state text;
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN busy_since text;
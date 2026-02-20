-- Migration: Add auto_compact_threshold column to providers table
-- Stores the CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value at the provider level.
-- Nullable: non-Claude providers have NULL (meaning: don't inject env var).
-- Value 10 means compaction triggers at 10% context capacity.

-- Step 1: Add nullable column
ALTER TABLE providers ADD COLUMN auto_compact_threshold INTEGER DEFAULT NULL;
--> statement-breakpoint

-- Step 2: Set existing Claude providers to 10 (aggressive, early compaction)
UPDATE providers SET auto_compact_threshold = 10 WHERE LOWER(name) = 'claude';

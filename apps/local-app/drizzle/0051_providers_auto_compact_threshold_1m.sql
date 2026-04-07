-- Add 1M-specific auto-compact threshold column
ALTER TABLE providers ADD COLUMN auto_compact_threshold_1m INTEGER DEFAULT NULL;
--> statement-breakpoint
-- For 1M-enabled providers: move current threshold to 1m field, set standard to 95
-- This preserves user-customized 1M thresholds (e.g., if someone set 40 instead of 50)
UPDATE providers SET auto_compact_threshold_1m = auto_compact_threshold, auto_compact_threshold = 95 WHERE one_million_context_enabled = 1;

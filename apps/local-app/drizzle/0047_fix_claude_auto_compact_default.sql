-- Migration: Fix Claude provider auto_compact_threshold default from 10 to 85
-- The original migration (0045) incorrectly set existing Claude providers to 10 (aggressive).
-- The intended default is 85% context usage before triggering auto-compact.

UPDATE providers SET auto_compact_threshold = 85
WHERE LOWER(name) = 'claude' AND auto_compact_threshold = 10;

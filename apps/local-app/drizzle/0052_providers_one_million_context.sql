-- Add one_million_context_enabled column to providers table
-- Defaults to false (disabled) for all existing and new providers
ALTER TABLE providers ADD COLUMN one_million_context_enabled INTEGER NOT NULL DEFAULT 0;

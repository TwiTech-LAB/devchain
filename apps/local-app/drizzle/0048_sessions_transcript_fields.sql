-- Migration: Add transcript_path and claude_session_id to sessions table
-- These nullable TEXT columns support session-reader transcript matching
-- and Claude subagent resolution. No backfill needed for existing rows.

ALTER TABLE sessions ADD COLUMN transcript_path TEXT;--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN claude_session_id TEXT;

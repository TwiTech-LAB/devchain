-- Migration 0034: Clean up duplicate sessions and add unique index
-- This migration ensures only one running session per agent exists before adding the constraint

-- Step 1: Clean up any existing duplicate running sessions
-- For each agent with multiple running sessions, keep exactly one and mark the rest as 'stopped'
-- Uses window function for deterministic ordering even when started_at timestamps are identical
UPDATE sessions
SET status = 'stopped',
    ended_at = datetime('now'),
    updated_at = datetime('now')
WHERE id IN (
    -- Find all duplicate sessions (rn > 1 means not the first for that agent)
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY agent_id
                   ORDER BY started_at DESC, created_at DESC, id DESC
               ) as rn
        FROM sessions
        WHERE status = 'running'
          AND agent_id IS NOT NULL
    ) ranked
    WHERE rn > 1
);
--> statement-breakpoint

-- Step 2: Add partial unique index to prevent future duplicates
-- This is a safety net for the application-level lock (withAgentLock in SessionsService)
-- to catch any edge cases where concurrent requests might create duplicate sessions
CREATE UNIQUE INDEX `idx_sessions_agent_running` ON `sessions` (`agent_id`) WHERE status = 'running' AND agent_id IS NOT NULL;

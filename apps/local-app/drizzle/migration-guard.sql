-- Migration Session Guard
-- Run this BEFORE applying Phase 2 migrations to ensure no active sessions
-- Usage: sqlite3 ~/.devchain/devchain.db < migration-guard.sql
-- If any output is shown, DO NOT proceed with migration

SELECT
    'ERROR: Active sessions detected. Stop all sessions before migrating.' as message,
    id as session_id,
    agent_id,
    status,
    started_at
FROM sessions
WHERE status = 'running'
AND ended_at IS NULL;

-- This query returns nothing if safe to proceed
-- If rows are returned, migration should NOT proceed

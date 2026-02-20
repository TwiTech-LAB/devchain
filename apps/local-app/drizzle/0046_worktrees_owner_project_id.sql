-- Migration: scope worktrees to an owning project
-- NOTE: this is a development-only migration path; existing local DBs should be recreated.
ALTER TABLE worktrees ADD COLUMN owner_project_id TEXT NOT NULL;

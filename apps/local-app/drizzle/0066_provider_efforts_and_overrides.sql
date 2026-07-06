-- Migration: Add provider_efforts table, profile_provider_configs model/effort columns, agents effort_override
-- provider_efforts mirrors provider_models for per-provider reasoning effort levels.
-- profile_provider_configs.model/effort store structured defaults selected from catalogs.
-- agents.effort_override stores the selected effort override per agent.

ALTER TABLE profile_provider_configs ADD COLUMN model TEXT;
--> statement-breakpoint
ALTER TABLE profile_provider_configs ADD COLUMN effort TEXT;
--> statement-breakpoint
ALTER TABLE agents ADD COLUMN effort_override TEXT;
--> statement-breakpoint

CREATE TABLE provider_efforts (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX provider_efforts_provider_name_ci_idx
ON provider_efforts(provider_id, lower(name));
--> statement-breakpoint

CREATE INDEX provider_efforts_provider_position_idx
ON provider_efforts(provider_id, position);

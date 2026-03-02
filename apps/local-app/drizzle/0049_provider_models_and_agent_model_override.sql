-- Migration: Add provider_models table and agents.model_override column
-- provider_models stores provider-specific model variants and ordering metadata.
-- agents.model_override stores the selected model override per agent.

ALTER TABLE agents ADD COLUMN model_override TEXT;
--> statement-breakpoint

CREATE TABLE provider_models (
  id TEXT PRIMARY KEY NOT NULL,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE cascade
);
--> statement-breakpoint

CREATE UNIQUE INDEX provider_models_provider_name_ci_idx
ON provider_models(provider_id, lower(name));
--> statement-breakpoint

CREATE INDEX provider_models_provider_position_idx
ON provider_models(provider_id, position);

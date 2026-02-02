-- Phase 4: Make agents.providerConfigId NOT NULL
-- Prerequisites:
--   - Migration 0030 must have run to set all providerConfigId values
--   - No agents should have NULL providerConfigId
-- This migration will FAIL if any agent has NULL providerConfigId
-- (the INSERT into the NOT NULL column will fail naturally)

-- Rebuild agents table with NOT NULL constraint
-- Note: foreign_keys are disabled in db.provider.ts before running migrations
-- (PRAGMA foreign_keys=OFF has no effect inside a transaction)

CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`provider_config_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`provider_config_id`) REFERENCES `profile_provider_configs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint

INSERT INTO `__new_agents` (
	`id`,
	`project_id`,
	`profile_id`,
	`provider_config_id`,
	`name`,
	`description`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`project_id`,
	`profile_id`,
	`provider_config_id`,
	`name`,
	`description`,
	`created_at`,
	`updated_at`
FROM `agents`;
--> statement-breakpoint

DROP TABLE `agents`;
--> statement-breakpoint

ALTER TABLE `__new_agents` RENAME TO `agents`;

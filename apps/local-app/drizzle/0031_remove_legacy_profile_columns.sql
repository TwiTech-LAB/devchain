-- Phase 4: Remove legacy providerId and options columns from agent_profiles
-- Provider configuration now lives in profile_provider_configs table
-- This migration:
--   1. Rebuilds agent_profiles without providerId and options columns
--   2. Replaces family_provider_unique index with family_unique index

-- Note: foreign_keys are disabled in db.provider.ts before running migrations
-- (PRAGMA foreign_keys=OFF has no effect inside a transaction)

-- Step 1: Create new table without providerId and options columns
CREATE TABLE `__new_agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`family_slug` text,
	`system_prompt` text,
	`instructions` text,
	`temperature` integer,
	`max_tokens` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

-- Step 2: Copy data (excluding providerId and options)
INSERT INTO `__new_agent_profiles` (
	`id`,
	`project_id`,
	`name`,
	`family_slug`,
	`system_prompt`,
	`instructions`,
	`temperature`,
	`max_tokens`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`project_id`,
	`name`,
	`family_slug`,
	`system_prompt`,
	`instructions`,
	`temperature`,
	`max_tokens`,
	`created_at`,
	`updated_at`
FROM `agent_profiles`;
--> statement-breakpoint

-- Step 3: Drop old table
DROP TABLE `agent_profiles`;
--> statement-breakpoint

-- Step 4: Rename new table
ALTER TABLE `__new_agent_profiles` RENAME TO `agent_profiles`;
--> statement-breakpoint

-- Step 5: Recreate indexes
-- Keep: unique constraint on (project_id, name)
CREATE UNIQUE INDEX `agent_profiles_project_name_unique` ON `agent_profiles` (`project_id`, `name`);
--> statement-breakpoint

-- New: unique constraint on (project_id, family_slug) - profiles are now provider-independent
-- Note: Replaces old agent_profiles_family_provider_unique which included provider_id
CREATE UNIQUE INDEX `agent_profiles_family_unique` ON `agent_profiles` (`project_id`, `family_slug`) WHERE `family_slug` IS NOT NULL;

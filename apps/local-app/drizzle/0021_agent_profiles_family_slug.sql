ALTER TABLE `agent_profiles` ADD `family_slug` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profiles_family_provider_unique` ON `agent_profiles`(`project_id`, `family_slug`, `provider_id`) WHERE `family_slug` IS NOT NULL;

CREATE TABLE `community_skill_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_owner` text NOT NULL,
	`repo_name` text NOT NULL,
	`branch` text DEFAULT 'main' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `community_skill_sources_name_unique` ON `community_skill_sources` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `community_skill_sources_repo_owner_repo_name_unique` ON `community_skill_sources` (`repo_owner`,`repo_name`);
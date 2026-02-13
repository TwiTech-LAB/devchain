CREATE TABLE `local_skill_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`folder_path` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_skill_sources_name_unique` ON `local_skill_sources` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `local_skill_sources_folder_path_unique` ON `local_skill_sources` (`folder_path`);
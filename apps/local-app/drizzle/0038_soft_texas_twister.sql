CREATE TABLE `skill_project_blacklist` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_project_blacklist_project_skill_unique` ON `skill_project_blacklist` (`project_id`,`skill_id`);--> statement-breakpoint
CREATE TABLE `skill_usage_log` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`skill_slug` text NOT NULL,
	`project_id` text,
	`agent_id` text,
	`agent_name_snapshot` text,
	`accessed_at` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_usage_log_skill_id_idx` ON `skill_usage_log` (`skill_id`);--> statement-breakpoint
CREATE INDEX `skill_usage_log_project_id_idx` ON `skill_usage_log` (`project_id`);--> statement-breakpoint
CREATE INDEX `skill_usage_log_accessed_at_idx` ON `skill_usage_log` (`accessed_at`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text,
	`short_description` text,
	`source` text NOT NULL,
	`source_url` text,
	`source_commit` text,
	`category` text,
	`license` text,
	`compatibility` text,
	`frontmatter` text,
	`instruction_content` text,
	`content_path` text,
	`resources` text,
	`status` text DEFAULT 'available' NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_slug_unique` ON `skills` (`slug`);--> statement-breakpoint
CREATE INDEX `skills_source_idx` ON `skills` (`source`);--> statement-breakpoint
CREATE INDEX `skills_category_idx` ON `skills` (`category`);--> statement-breakpoint
CREATE INDEX `skills_status_idx` ON `skills` (`status`);
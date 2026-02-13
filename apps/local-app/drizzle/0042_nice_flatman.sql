CREATE TABLE `source_project_enabled` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_name` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_project_enabled_project_source_unique` ON `source_project_enabled` (`project_id`,`source_name`);
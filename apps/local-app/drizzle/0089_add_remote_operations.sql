CREATE TABLE `remote_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`remote_id` text NOT NULL,
	`project_id` text,
	`state` text NOT NULL,
	`steps` text NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`remote_id`) REFERENCES `remotes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `remote_operations_remote_id_idx` ON `remote_operations` (`remote_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `remote_operations_open_project_idx` ON `remote_operations` (`project_id`) WHERE "remote_operations"."state" IN ('running', 'failed');
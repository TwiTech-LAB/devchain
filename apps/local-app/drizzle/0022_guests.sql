CREATE TABLE `guests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`tmux_session_id` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guests_project_name_unique` ON `guests` (`project_id`, `name` COLLATE NOCASE);
--> statement-breakpoint
CREATE UNIQUE INDEX `guests_tmux_session_id_unique` ON `guests` (`tmux_session_id`);
--> statement-breakpoint
CREATE INDEX `guests_project_id_idx` ON `guests` (`project_id`);

CREATE TABLE `automation_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`event_name` text NOT NULL,
	`event_filter` text,
	`action_type` text NOT NULL,
	`action_inputs` text NOT NULL,
	`delay_ms` integer DEFAULT 0 NOT NULL,
	`cooldown_ms` integer DEFAULT 5000 NOT NULL,
	`retry_on_error` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_subscribers_project_id_idx` ON `automation_subscribers` (`project_id`);--> statement-breakpoint
CREATE INDEX `automation_subscribers_event_name_idx` ON `automation_subscribers` (`event_name`);--> statement-breakpoint
CREATE INDEX `automation_subscribers_enabled_idx` ON `automation_subscribers` (`enabled`);--> statement-breakpoint
CREATE TABLE `terminal_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`enabled` integer DEFAULT true NOT NULL,
	`scope` text DEFAULT 'all' NOT NULL,
	`scope_filter_id` text,
	`poll_interval_ms` integer DEFAULT 5000 NOT NULL,
	`viewport_lines` integer DEFAULT 50 NOT NULL,
	`condition` text NOT NULL,
	`cooldown_ms` integer DEFAULT 60000 NOT NULL,
	`cooldown_mode` text DEFAULT 'time' NOT NULL,
	`event_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `terminal_watchers_project_id_idx` ON `terminal_watchers` (`project_id`);--> statement-breakpoint
CREATE INDEX `terminal_watchers_enabled_idx` ON `terminal_watchers` (`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `terminal_watchers_event_name_unique` ON `terminal_watchers` (`project_id`,`event_name`);

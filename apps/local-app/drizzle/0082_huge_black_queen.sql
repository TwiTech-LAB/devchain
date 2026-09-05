CREATE TABLE `external_estimate_log_days` (
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`activity_date` text NOT NULL,
	`logged_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`provider`, `remote_scope_key`, `remote_task_id`, `activity_date`),
	CONSTRAINT "external_estimate_log_days_logged_minutes_check" CHECK("external_estimate_log_days"."logged_minutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE `external_estimate_log_states` ADD `aggregation_time_zone` text;--> statement-breakpoint
ALTER TABLE `external_estimate_log_states` ADD `pending_activity_date` text;
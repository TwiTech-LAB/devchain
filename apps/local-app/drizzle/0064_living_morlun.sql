-- Scheduled run rows are owned by their schedule and cascade on schedule deletion.
-- created_epic_id is nullable and uses ON DELETE SET NULL so run history survives
-- removal of a generated epic while preserving the audit trail.
CREATE TABLE `scheduled_epic_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`planned_for` text NOT NULL,
	`source` text DEFAULT 'scheduler' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_epic_id` text,
	`started_at` text,
	`finished_at` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `scheduled_epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_epic_runs_schedule_planned_for_idx` ON `scheduled_epic_runs` (`schedule_id`,`planned_for`);--> statement-breakpoint
CREATE INDEX `scheduled_epic_runs_schedule_status_planned_for_idx` ON `scheduled_epic_runs` (`schedule_id`,`status`,`planned_for`);--> statement-breakpoint
CREATE INDEX `scheduled_epic_runs_created_epic_id_idx` ON `scheduled_epic_runs` (`created_epic_id`);--> statement-breakpoint
-- Scheduled epic templates belong to projects and are removed with the project.
-- Nullable template defaults use ON DELETE SET NULL because schedules can remain valid
-- after optional status/parent/agent defaults are deleted. This differs from epics.status_id:
-- concrete epics still require a non-null status chosen by service validation at creation time.
CREATE TABLE `scheduled_epics` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`cron_expression` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`title_template` text NOT NULL,
	`description_template` text,
	`template_status_id` text,
	`template_parent_epic_id` text,
	`template_agent_id` text,
	`template_tags` text DEFAULT '[]',
	`allow_overlap` integer DEFAULT false NOT NULL,
	`missed_run_policy` text DEFAULT 'skip' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_run_status` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_parent_epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`template_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scheduled_epics_project_id_idx` ON `scheduled_epics` (`project_id`);--> statement-breakpoint
CREATE INDEX `scheduled_epics_project_enabled_next_run_idx` ON `scheduled_epics` (`project_id`,`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `scheduled_epics_template_status_id_idx` ON `scheduled_epics` (`template_status_id`);--> statement-breakpoint
CREATE INDEX `scheduled_epics_template_parent_epic_id_idx` ON `scheduled_epics` (`template_parent_epic_id`);--> statement-breakpoint
CREATE INDEX `scheduled_epics_template_agent_id_idx` ON `scheduled_epics` (`template_agent_id`);

CREATE TABLE `scheduled_epics` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `enabled` integer DEFAULT 1 NOT NULL,
  `cron_expression` text NOT NULL,
  `timezone` text DEFAULT 'UTC' NOT NULL,
  `last_run_at` text,
  `next_run_at` text,
  `template_title` text NOT NULL,
  `template_description` text,
  `template_status_id` text,
  `template_agent_id` text,
  `template_parent_id` text,
  `template_tags` text,
  `template_skills_required` text,
  `template_data` text,
  `max_occurrences` integer,
  `occurrence_count` integer DEFAULT 0 NOT NULL,
  `cooldown_ms` integer DEFAULT 0 NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_epics_project_id_idx` ON `scheduled_epics` (`project_id`);
--> statement-breakpoint
CREATE INDEX `scheduled_epics_enabled_idx` ON `scheduled_epics` (`enabled`);
--> statement-breakpoint
CREATE INDEX `scheduled_epics_next_run_at_idx` ON `scheduled_epics` (`next_run_at`);
--> statement-breakpoint
CREATE TABLE `scheduled_epic_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `scheduled_epic_id` text NOT NULL,
  `epic_id` text,
  `status` text NOT NULL,
  `error` text,
  `scheduled_at` text NOT NULL,
  `executed_at` text NOT NULL,
  FOREIGN KEY (`scheduled_epic_id`) REFERENCES `scheduled_epics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_epic_runs_scheduled_epic_id_idx` ON `scheduled_epic_runs` (`scheduled_epic_id`);

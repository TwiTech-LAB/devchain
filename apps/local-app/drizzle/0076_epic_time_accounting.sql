CREATE TABLE `epic_time_buffer_claims` (
	`claim_sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`committed_event_id` text NOT NULL,
	`event_name` text NOT NULL,
	`project_id` text NOT NULL,
	`agent_id_snapshot` text NOT NULL,
	`agent_name_snapshot` text NOT NULL,
	`target_epic_id_snapshot` text NOT NULL,
	`target_epic_title_snapshot` text NOT NULL,
	`published_at` text NOT NULL,
	`source_event_row_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_time_buffer_claims_committed_event_id_unique` ON `epic_time_buffer_claims` (`committed_event_id`);--> statement-breakpoint
CREATE INDEX `epic_time_claims_project_agent_published_idx` ON `epic_time_buffer_claims` (`project_id`,`agent_id_snapshot`,`published_at`,`claim_sequence`);--> statement-breakpoint
CREATE TABLE `epic_time_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`session_id_snapshot` text NOT NULL,
	`agent_id_snapshot` text NOT NULL,
	`agent_name_snapshot` text NOT NULL,
	`started_at` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`closed_at` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_time_segments_open_session_unique` ON `epic_time_segments` (`session_id_snapshot`) WHERE "epic_time_segments"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `epic_time_segments_project_epic_closed_idx` ON `epic_time_segments` (`project_id`,`epic_id`,`closed_at`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `epic_time_segments_project_agent_idx` ON `epic_time_segments` (`project_id`,`agent_id_snapshot`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `epic_time_session_watermarks` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`last_activity_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `epic_time_watermarks_project_activity_idx` ON `epic_time_session_watermarks` (`project_id`,`last_activity_at`);
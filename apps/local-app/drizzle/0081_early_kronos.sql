CREATE TABLE `epic_time_team_batch_event_barriers` (
	`team_batch_id` text NOT NULL,
	`committed_event_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`team_batch_id`, `committed_event_id`),
	FOREIGN KEY (`team_batch_id`) REFERENCES `epic_time_team_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`committed_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `epic_time_team_barriers_event_idx` ON `epic_time_team_batch_event_barriers` (`committed_event_id`);--> statement-breakpoint
CREATE TABLE `epic_time_team_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`team_id_snapshot` text NOT NULL,
	`team_name_snapshot` text NOT NULL,
	`lead_agent_id_snapshot` text NOT NULL,
	`lead_agent_name_snapshot` text NOT NULL,
	`started_at` text NOT NULL,
	`sealed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_time_team_batches_open_unique` ON `epic_time_team_batches` (`project_id`,`team_id_snapshot`) WHERE "epic_time_team_batches"."sealed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `epic_time_team_batches_project_sealed_idx` ON `epic_time_team_batches` (`project_id`,`sealed_at`,`started_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_epic_time_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`team_batch_id` text,
	`attribution_source` text DEFAULT 'direct' NOT NULL,
	`team_id_snapshot` text,
	`team_name_snapshot` text,
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
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_batch_id`) REFERENCES `epic_time_team_batches`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "epic_time_segments_attribution_source_check" CHECK("__new_epic_time_segments"."attribution_source" IN ('direct', 'team'))
);
--> statement-breakpoint
INSERT INTO `__new_epic_time_segments`("id", "project_id", "epic_id", "team_batch_id", "attribution_source", "team_id_snapshot", "team_name_snapshot", "session_id_snapshot", "agent_id_snapshot", "agent_name_snapshot", "started_at", "last_activity_at", "closed_at", "duration_ms", "created_at", "updated_at") SELECT "id", "project_id", "epic_id", NULL, 'direct', NULL, NULL, "session_id_snapshot", "agent_id_snapshot", "agent_name_snapshot", "started_at", "last_activity_at", "closed_at", "duration_ms", "created_at", "updated_at" FROM `epic_time_segments`;--> statement-breakpoint
DROP TABLE `epic_time_segments`;--> statement-breakpoint
ALTER TABLE `__new_epic_time_segments` RENAME TO `epic_time_segments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `epic_time_segments_open_session_unique` ON `epic_time_segments` (`session_id_snapshot`) WHERE "epic_time_segments"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX `epic_time_segments_project_epic_closed_idx` ON `epic_time_segments` (`project_id`,`epic_id`,`closed_at`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `epic_time_segments_project_agent_idx` ON `epic_time_segments` (`project_id`,`agent_id_snapshot`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `epic_time_segments_team_batch_idx` ON `epic_time_segments` (`team_batch_id`);

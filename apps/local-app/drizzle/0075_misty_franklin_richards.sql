CREATE TABLE `external_managed_subtask_links` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text,
	`epic_id_snapshot` text NOT NULL,
	`parent_epic_id_snapshot` text NOT NULL,
	`parent_source_link_id_snapshot` text NOT NULL,
	`connection_id_snapshot` text NOT NULL,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`work_area_remote_id` text NOT NULL,
	`parent_remote_task_id` text NOT NULL,
	`connection_generation` integer NOT NULL,
	`sync_setting_revision` integer NOT NULL,
	`ownership_token` text NOT NULL,
	`remote_task_id` text,
	`remote_key` text,
	`desired_version` integer NOT NULL,
	`confirmed_version` integer,
	`desired_fingerprint` text NOT NULL,
	`confirmed_fingerprint` text,
	`operation_phase` text DEFAULT 'pre_dispatch' NOT NULL,
	`safe_error_code` text,
	`retry_at` text,
	`tombstone_state` text DEFAULT 'active' NOT NULL,
	`tombstoned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `external_managed_subtask_epic_id_idx` ON `external_managed_subtask_links` (`epic_id`);--> statement-breakpoint
CREATE INDEX `external_managed_subtask_provider_phase_idx` ON `external_managed_subtask_links` (`provider`,`operation_phase`);--> statement-breakpoint
CREATE INDEX `external_managed_subtask_remote_identity_idx` ON `external_managed_subtask_links` (`provider`,`remote_scope_key`,`remote_task_id`);--> statement-breakpoint
CREATE INDEX `external_managed_subtask_retry_at_idx` ON `external_managed_subtask_links` (`retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_managed_subtask_projection_unique` ON `external_managed_subtask_links` (`epic_id_snapshot`,`parent_source_link_id_snapshot`);--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `subtask_sync_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `sync_setting_revision` integer DEFAULT 1 NOT NULL;
CREATE TABLE `external_task_links` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`connection_id` text,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`source_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `external_task_links_epic_id_idx` ON `external_task_links` (`epic_id`);--> statement-breakpoint
CREATE INDEX `external_task_links_connection_id_idx` ON `external_task_links` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_links_remote_identity_unique` ON `external_task_links` (`provider`,`remote_scope_key`,`remote_task_id`);--> statement-breakpoint
CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`credential_ciphertext` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_provider_unique` ON `integration_connections` (`provider`);
CREATE TABLE `vault_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`value_ciphertext` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_injected_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_entries_kind_check" CHECK("vault_entries"."kind" IN ('secret', 'file'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_entries_global_name_idx` ON `vault_entries` (`name`) WHERE "vault_entries"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_entries_project_name_idx` ON `vault_entries` (`project_id`,`name`) WHERE "vault_entries"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `vault_entry_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`project_id` text NOT NULL,
	`family_slug` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `vault_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_entry_grants_all_idx` ON `vault_entry_grants` (`entry_id`,`project_id`) WHERE "vault_entry_grants"."family_slug" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_entry_grants_family_idx` ON `vault_entry_grants` (`entry_id`,`project_id`,`family_slug`) WHERE "vault_entry_grants"."family_slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `vault_entry_grants_project_idx` ON `vault_entry_grants` (`project_id`);
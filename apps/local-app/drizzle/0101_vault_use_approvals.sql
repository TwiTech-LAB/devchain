CREATE TABLE `vault_use_family_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`project_id` text NOT NULL,
	`family_slug` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `vault_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_use_family_approvals_family_idx` ON `vault_use_family_approvals` (`entry_id`,`project_id`,`family_slug`);--> statement-breakpoint
CREATE INDEX `vault_use_family_approvals_project_idx` ON `vault_use_family_approvals` (`project_id`);--> statement-breakpoint
ALTER TABLE `vault_entries` ADD `approval_required` integer DEFAULT false NOT NULL;
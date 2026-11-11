CREATE TABLE `vault_family_access` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`family_slug` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_family_access_all_idx` ON `vault_family_access` (`project_id`) WHERE "vault_family_access"."family_slug" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `vault_family_access_family_idx` ON `vault_family_access` (`project_id`,`family_slug`) WHERE "vault_family_access"."family_slug" IS NOT NULL;
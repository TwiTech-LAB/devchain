CREATE TABLE `session_vault_grants` (
	`session_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `entry_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `vault_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_vault_grants_status_check" CHECK("session_vault_grants"."status" IN ('loaded', 'shadowed', 'restart_needed'))
);
--> statement-breakpoint
CREATE INDEX `session_vault_grants_entry_idx` ON `session_vault_grants` (`entry_id`);
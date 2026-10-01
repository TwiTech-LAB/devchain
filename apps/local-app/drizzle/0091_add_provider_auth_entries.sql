CREATE TABLE `provider_auth_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`payload_ciphertext` text NOT NULL,
	`payload_kind` text NOT NULL,
	`checked_out_remote_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_verified_at` text,
	`last_writeback_at` text,
	FOREIGN KEY (`checked_out_remote_id`) REFERENCES `remotes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `provider_auth_entries_remote_id_idx` ON `provider_auth_entries` (`checked_out_remote_id`);--> statement-breakpoint
CREATE INDEX `provider_auth_entries_provider_idx` ON `provider_auth_entries` (`provider`);
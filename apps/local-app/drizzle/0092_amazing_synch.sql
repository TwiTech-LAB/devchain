CREATE TABLE `vm_provider_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`api_url` text NOT NULL,
	`node` text NOT NULL,
	`pool` text NOT NULL,
	`storage` text NOT NULL,
	`image_storage` text NOT NULL,
	`bridge` text NOT NULL,
	`vmid_min` integer NOT NULL,
	`vmid_max` integer NOT NULL,
	`name_prefix` text NOT NULL,
	`tag` text NOT NULL,
	`ssl_fingerprint` text NOT NULL,
	`ca_pem` text,
	`token_id` text NOT NULL,
	`token_secret_ciphertext` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`kind` text NOT NULL,
	`vm_provider_connection_id` text,
	`vm_identity` text,
	`vm_spec_json` text,
	`credential_ciphertext` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vm_provider_connection_id`) REFERENCES `vm_provider_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remotes_address_requires_base_url" CHECK("__new_remotes"."kind" = 'proxmox' OR "__new_remotes"."base_url" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO `__new_remotes`("id", "name", "base_url", "kind", "vm_provider_connection_id", "vm_identity", "vm_spec_json", "credential_ciphertext", "created_at", "updated_at") SELECT "id", "name", "base_url", "kind", NULL, NULL, NULL, "credential_ciphertext", "created_at", "updated_at" FROM `remotes`;--> statement-breakpoint
DROP TABLE `remotes`;--> statement-breakpoint
ALTER TABLE `__new_remotes` RENAME TO `remotes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `remotes_name_ci_idx` ON `remotes` (lower("name"));

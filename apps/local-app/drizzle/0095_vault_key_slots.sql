CREATE TABLE `vault_key_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`kind` text NOT NULL,
	`dek_version` integer NOT NULL,
	`wrapped_dek` text NOT NULL,
	`keystore_account` text,
	`kdf_params` text,
	`pending_recovery_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "vault_key_slots_kind_check" CHECK("vault_key_slots"."kind" IN ('keystore', 'recovery', 'file'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_key_slots_kind_version_idx` ON `vault_key_slots` (`kind`,`dek_version`);
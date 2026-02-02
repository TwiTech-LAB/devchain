CREATE TABLE `profile_provider_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`options` text,
	`env` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `profile_provider_configs_profile_id_idx` ON `profile_provider_configs` (`profile_id`);
--> statement-breakpoint
CREATE INDEX `profile_provider_configs_provider_id_idx` ON `profile_provider_configs` (`provider_id`);
--> statement-breakpoint
ALTER TABLE `agents` ADD `provider_config_id` text REFERENCES profile_provider_configs(id);

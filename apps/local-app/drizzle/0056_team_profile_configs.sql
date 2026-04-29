CREATE TABLE `team_profile_configs` (
	`team_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`provider_config_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`team_id`, `profile_id`, `provider_config_id`),
	FOREIGN KEY (`provider_config_id`) REFERENCES `profile_provider_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`,`profile_id`) REFERENCES `team_profiles`(`team_id`,`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_profile_configs_provider_config_id_idx` ON `team_profile_configs` (`provider_config_id`);
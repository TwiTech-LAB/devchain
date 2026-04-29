CREATE TABLE `team_profiles` (
	`team_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`team_id`, `profile_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `agent_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_profiles_profile_id_idx` ON `team_profiles` (`profile_id`);
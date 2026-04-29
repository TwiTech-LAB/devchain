CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`team_lead_agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_lead_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_project_name_unique` ON `teams` (`project_id`,"name" COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX `teams_project_id_idx` ON `teams` (`project_id`);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`team_id`, `agent_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_members_agent_id_idx` ON `team_members` (`agent_id`);

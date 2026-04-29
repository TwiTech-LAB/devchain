CREATE TABLE `teams_new` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`team_lead_agent_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_lead_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `teams_new`("id", "project_id", "name", "description", "team_lead_agent_id", "created_at", "updated_at") SELECT "id", "project_id", "name", "description", "team_lead_agent_id", "created_at", "updated_at" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `teams_new` RENAME TO `teams`;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_project_name_unique` ON `teams` (`project_id`,"name" COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `teams_project_id_idx` ON `teams` (`project_id`);

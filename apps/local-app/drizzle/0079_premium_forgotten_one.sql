CREATE TABLE `epic_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`left_epic_id` text NOT NULL,
	`right_epic_id` text NOT NULL,
	`type` text NOT NULL,
	`direction` text NOT NULL,
	`created_by` text,
	`created_by_agent_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`left_epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`right_epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `epic_relations_pair_idx` ON `epic_relations` (`left_epic_id`,`right_epic_id`);--> statement-breakpoint
CREATE INDEX `epic_relations_right_epic_id_idx` ON `epic_relations` (`right_epic_id`);--> statement-breakpoint
CREATE INDEX `epics_project_id_idx` ON `epics` (`project_id`);
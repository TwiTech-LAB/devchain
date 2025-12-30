CREATE TABLE `epic_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`author_name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `epic_comments_epic_id_created_at_idx` ON `epic_comments` (`epic_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `epics` ADD `parent_id` text REFERENCES epics(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `epics` ADD `agent_id` text REFERENCES agents(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `epics_parent_id_idx` ON `epics` (`parent_id`);--> statement-breakpoint
CREATE INDEX `epics_agent_id_idx` ON `epics` (`agent_id`);

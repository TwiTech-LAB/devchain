ALTER TABLE `teams` ADD `max_members` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `teams` ADD `max_concurrent_tasks` integer DEFAULT 5 NOT NULL;
ALTER TABLE `automation_subscribers` ADD `group_name` text;--> statement-breakpoint
ALTER TABLE `automation_subscribers` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_subscribers` ADD `priority` integer DEFAULT 0 NOT NULL;
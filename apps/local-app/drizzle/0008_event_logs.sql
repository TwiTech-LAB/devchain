PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`payload_json` text NOT NULL,
	`request_id` text,
	`published_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_name_idx` ON `events` (`name`);
--> statement-breakpoint
CREATE INDEX `events_published_at_idx` ON `events` (`published_at`);
--> statement-breakpoint
CREATE TABLE `event_handlers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`handler` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_handlers_event_id_idx` ON `event_handlers` (`event_id`);
--> statement-breakpoint
CREATE INDEX `event_handlers_handler_idx` ON `event_handlers` (`handler`);
--> statement-breakpoint
CREATE INDEX `event_handlers_status_idx` ON `event_handlers` (`status`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;

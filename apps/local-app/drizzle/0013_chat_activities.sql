CREATE TABLE `chat_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`start_message_id` text,
	`finish_message_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`start_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`finish_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `chat_activities_thread_agent_idx` ON `chat_activities` (`thread_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `chat_activities_started_at_idx` ON `chat_activities` (`started_at`);
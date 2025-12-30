CREATE TABLE `chat_thread_session_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_id` text NOT NULL,
	`invite_message_id` text NOT NULL,
	`sent_at` text NOT NULL,
	`acknowledged_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invite_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_thread_session_invites_unique` ON `chat_thread_session_invites` (`thread_id`,`agent_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `chat_thread_session_invites_thread_agent_idx` ON `chat_thread_session_invites` (`thread_id`,`agent_id`);--> statement-breakpoint
ALTER TABLE `chat_threads` ADD `last_user_cleared_at` text;
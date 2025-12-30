CREATE TABLE `chat_message_reads` (
	`message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`read_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_message_reads_pk` ON `chat_message_reads` (`message_id`,`agent_id`);--> statement-breakpoint
CREATE INDEX `chat_message_reads_message_id_idx` ON `chat_message_reads` (`message_id`);--> statement-breakpoint
CREATE INDEX `chat_message_reads_agent_id_idx` ON `chat_message_reads` (`agent_id`);
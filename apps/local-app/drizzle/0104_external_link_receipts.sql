CREATE TABLE `external_link_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text NOT NULL,
	`link_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "external_link_receipts_kind_check" CHECK("external_link_receipts"."kind" IN ('set', 'release'))
);
--> statement-breakpoint
CREATE INDEX `external_link_receipts_project_seq_idx` ON `external_link_receipts` (`project_id`,`seq`);
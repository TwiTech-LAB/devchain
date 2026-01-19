-- Code Review Tables Migration
-- Adds reviews, review_comments, and review_comment_targets tables

CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`base_ref` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`created_by` text NOT NULL,
	`created_by_agent_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reviews_project_id_idx` ON `reviews` (`project_id`);
--> statement-breakpoint
CREATE INDEX `reviews_epic_id_idx` ON `reviews` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`);
--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`file_path` text,
	`parent_id` text,
	`line_start` integer,
	`line_end` integer,
	`side` text,
	`content` text NOT NULL,
	`comment_type` text NOT NULL,
	`status` text NOT NULL,
	`author_type` text NOT NULL,
	`author_agent_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `review_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `review_comments_review_id_idx` ON `review_comments` (`review_id`);
--> statement-breakpoint
CREATE INDEX `review_comments_parent_id_idx` ON `review_comments` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `review_comments_file_path_idx` ON `review_comments` (`file_path`);
--> statement-breakpoint
CREATE INDEX `review_comments_status_idx` ON `review_comments` (`status`);
--> statement-breakpoint
CREATE TABLE `review_comment_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `review_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_comment_targets_comment_id_idx` ON `review_comment_targets` (`comment_id`);
--> statement-breakpoint
CREATE INDEX `review_comment_targets_agent_id_idx` ON `review_comment_targets` (`agent_id`);

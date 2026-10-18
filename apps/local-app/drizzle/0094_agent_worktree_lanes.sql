CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`base_sha` text NOT NULL,
	`epic_id` text,
	`created_by_type` text NOT NULL,
	`created_by_agent_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "worktrees_created_by_type_check" CHECK("worktrees"."created_by_type" IN ('agent', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_project_name_unique` ON `worktrees` (`project_id`,"name" COLLATE NOCASE);
CREATE TABLE `merged_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`devchain_agent_id` text NOT NULL,
	`name` text,
	`profile_name` text,
	`epics_completed` integer DEFAULT 0,
	`merged_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merged_agents_worktree_id_idx` ON `merged_agents` (`worktree_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `merged_agents_worktree_agent_unique` ON `merged_agents` (`worktree_id`,`devchain_agent_id`);--> statement-breakpoint
CREATE TABLE `merged_epics` (
	`id` text PRIMARY KEY NOT NULL,
	`worktree_id` text NOT NULL,
	`devchain_epic_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status_name` text,
	`status_color` text,
	`agent_name` text,
	`parent_epic_id` text,
	`tags` text DEFAULT '[]',
	`created_at_source` text,
	`merged_at` text NOT NULL,
	FOREIGN KEY (`worktree_id`) REFERENCES `worktrees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `merged_epics_worktree_id_idx` ON `merged_epics` (`worktree_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `merged_epics_worktree_epic_unique` ON `merged_epics` (`worktree_id`,`devchain_epic_id`);--> statement-breakpoint
CREATE TABLE `worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`branch_name` text NOT NULL,
	`base_branch` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text,
	`container_id` text,
	`container_port` integer,
	`template_slug` text NOT NULL,
	`status` text DEFAULT 'creating' NOT NULL,
	`description` text,
	`devchain_project_id` text,
	`merge_commit` text,
	`merge_conflicts` text,
	`error_message` text,
	`runtime_type` text DEFAULT 'container' NOT NULL,
	`process_id` integer,
	`runtime_token` text,
	`started_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `worktrees_name_unique` ON `worktrees` (`name`);--> statement-breakpoint
CREATE INDEX `worktrees_status_idx` ON `worktrees` (`status`);
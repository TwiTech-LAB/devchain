CREATE TABLE `remote_project_bindings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`remote_id` text NOT NULL,
	`state` text NOT NULL,
	`host_cursor` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`remote_id`) REFERENCES `remotes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `remote_project_bindings_remote_id_idx` ON `remote_project_bindings` (`remote_id`);--> statement-breakpoint
CREATE TABLE `remotes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`kind` text NOT NULL,
	`credential_ciphertext` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remotes_name_ci_idx` ON `remotes` (lower("name"));
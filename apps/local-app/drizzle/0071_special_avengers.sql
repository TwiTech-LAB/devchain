CREATE TABLE `project_provider_plugin_overrides` (
	`project_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_provider_plugin_overrides_project_provider_plugin_unique` ON `project_provider_plugin_overrides` (`project_id`,`provider_id`,`plugin_id`);--> statement-breakpoint
CREATE TABLE `provider_plugin_defaults` (
	`provider_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_plugin_defaults_provider_plugin_unique` ON `provider_plugin_defaults` (`provider_id`,`plugin_id`);
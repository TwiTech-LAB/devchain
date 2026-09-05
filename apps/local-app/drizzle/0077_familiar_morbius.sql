DROP INDEX `integration_connections_provider_unique`;--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `project_id` text REFERENCES projects(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `integration_connections` ADD `legacy_source_connection_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_legacy_provider_unique` ON `integration_connections` (`provider`) WHERE "integration_connections"."project_id" IS NULL;--> statement-breakpoint
CREATE INDEX `integration_connections_project_id_idx` ON `integration_connections` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_project_provider_unique` ON `integration_connections` (`project_id`,`provider`);

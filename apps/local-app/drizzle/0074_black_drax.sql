ALTER TABLE `event_handlers` ADD `delivery_key` text;--> statement-breakpoint
ALTER TABLE `event_handlers` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `event_handlers` ADD `retry_at` text;--> statement-breakpoint
ALTER TABLE `event_handlers` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `event_handlers` ADD `lease_expires_at` text;--> statement-breakpoint
CREATE INDEX `event_handlers_retry_at_idx` ON `event_handlers` (`retry_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_handlers_event_delivery_unique` ON `event_handlers` (`event_id`,`delivery_key`) WHERE "event_handlers"."delivery_key" IS NOT NULL;
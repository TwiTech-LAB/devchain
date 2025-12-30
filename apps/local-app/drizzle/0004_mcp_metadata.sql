ALTER TABLE `providers` ADD COLUMN `mcp_configured` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `providers` ADD COLUMN `mcp_endpoint` text;
--> statement-breakpoint
ALTER TABLE `providers` ADD COLUMN `mcp_registered_at` text;

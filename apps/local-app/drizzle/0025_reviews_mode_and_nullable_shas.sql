-- Reviews schema update for live pre-commit review
-- 1) Add `mode` column to `reviews`
-- 2) Make `base_sha` / `head_sha` nullable for working_tree mode
-- 3) Enforce single active review per project (status != 'closed')

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`title` text NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`mode` text DEFAULT 'commit' NOT NULL,
	`base_ref` text NOT NULL,
	`head_ref` text NOT NULL,
	`base_sha` text,
	`head_sha` text,
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
INSERT INTO `__new_reviews` (
	`id`,
	`project_id`,
	`epic_id`,
	`title`,
	`description`,
	`status`,
	`mode`,
	`base_ref`,
	`head_ref`,
	`base_sha`,
	`head_sha`,
	`created_by`,
	`created_by_agent_id`,
	`version`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`project_id`,
	`epic_id`,
	`title`,
	`description`,
	`status`,
	'commit' as `mode`,
	`base_ref`,
	`head_ref`,
	`base_sha`,
	`head_sha`,
	`created_by`,
	`created_by_agent_id`,
	`version`,
	`created_at`,
	`updated_at`
FROM `reviews`;
--> statement-breakpoint
DROP TABLE `reviews`;
--> statement-breakpoint
ALTER TABLE `__new_reviews` RENAME TO `reviews`;

--> statement-breakpoint
CREATE INDEX `reviews_project_id_idx` ON `reviews` (`project_id`);
--> statement-breakpoint
CREATE INDEX `reviews_epic_id_idx` ON `reviews` (`epic_id`);
--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_project_active_unique` ON `reviews` (`project_id`) WHERE `status` != 'closed';
--> statement-breakpoint
PRAGMA foreign_keys=ON;

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_external_task_links` (
	`id` text PRIMARY KEY NOT NULL,
	`epic_id` text NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`source_snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_external_task_links`(`id`, `epic_id`, `project_id`, `connection_id`, `provider`, `remote_scope_key`, `remote_task_id`, `source_snapshot`, `created_at`, `updated_at`)
SELECT
  `external_task_links`.`id`,
  `external_task_links`.`epic_id`,
  -- Every live link owns an Epic row; the sentinel only guards a
  -- hypothetically orphaned link against silent loss.
  COALESCE(`epics`.`project_id`, '00000000-0000-0000-0000-000000000000'),
  `external_task_links`.`connection_id`,
  `external_task_links`.`provider`,
  `external_task_links`.`remote_scope_key`,
  `external_task_links`.`remote_task_id`,
  `external_task_links`.`source_snapshot`,
  `external_task_links`.`created_at`,
  `external_task_links`.`updated_at`
FROM `external_task_links`
LEFT JOIN `epics` ON `epics`.`id` = `external_task_links`.`epic_id`;--> statement-breakpoint
DROP TABLE `external_task_links`;--> statement-breakpoint
ALTER TABLE `__new_external_task_links` RENAME TO `external_task_links`;--> statement-breakpoint
CREATE INDEX `external_task_links_epic_id_idx` ON `external_task_links` (`epic_id`);--> statement-breakpoint
CREATE INDEX `external_task_links_connection_id_idx` ON `external_task_links` (`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_task_links_project_remote_identity_unique` ON `external_task_links` (`project_id`,`provider`,`remote_scope_key`,`remote_task_id`);--> statement-breakpoint
CREATE TABLE `__new_external_estimate_log_states` (
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`logged_minutes` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`pending_operation_id` text,
	`pending_delta_minutes` integer,
	`pending_estimate_total_minutes` integer,
	`pending_started_at` text,
	`pending_connection_id` text,
	`pending_connection_generation` integer,
	`pending_phase` text,
	`pending_resolution` text,
	`aggregation_time_zone` text,
	`pending_activity_date` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "external_estimate_log_states_logged_minutes_check" CHECK("__new_external_estimate_log_states"."logged_minutes" >= 0),
	CONSTRAINT "external_estimate_log_states_revision_check" CHECK("__new_external_estimate_log_states"."revision" >= 1),
	CONSTRAINT "external_estimate_log_states_pending_complete_check" CHECK((
        "__new_external_estimate_log_states"."pending_operation_id" IS NULL
        AND "__new_external_estimate_log_states"."pending_delta_minutes" IS NULL
        AND "__new_external_estimate_log_states"."pending_estimate_total_minutes" IS NULL
        AND "__new_external_estimate_log_states"."pending_started_at" IS NULL
        AND "__new_external_estimate_log_states"."pending_connection_id" IS NULL
        AND "__new_external_estimate_log_states"."pending_connection_generation" IS NULL
        AND "__new_external_estimate_log_states"."pending_phase" IS NULL
        AND "__new_external_estimate_log_states"."pending_resolution" IS NULL
      ) OR (
        "__new_external_estimate_log_states"."pending_operation_id" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_delta_minutes" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_delta_minutes" > 0
        AND "__new_external_estimate_log_states"."pending_delta_minutes" * 60000 <= 604800000
        AND "__new_external_estimate_log_states"."pending_estimate_total_minutes" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_estimate_total_minutes" >= 0
        AND "__new_external_estimate_log_states"."pending_started_at" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_connection_id" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_connection_generation" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_connection_generation" >= 1
        AND "__new_external_estimate_log_states"."pending_phase" IS NOT NULL
        AND "__new_external_estimate_log_states"."pending_phase" IN ('prepared', 'outcome_unknown')
        AND (
          "__new_external_estimate_log_states"."pending_resolution" IS NULL
          OR "__new_external_estimate_log_states"."pending_resolution" IN ('logged', 'not_logged')
        )
      ))
);--> statement-breakpoint
INSERT INTO `__new_external_estimate_log_states`(`project_id`, `provider`, `remote_scope_key`, `remote_task_id`, `logged_minutes`, `revision`, `pending_operation_id`, `pending_delta_minutes`, `pending_estimate_total_minutes`, `pending_started_at`, `pending_connection_id`, `pending_connection_generation`, `pending_phase`, `pending_resolution`, `aggregation_time_zone`, `pending_activity_date`, `created_at`, `updated_at`)
SELECT
  -- Historical owner attribution. A settled checkpoint with a live link
  -- has an identifiable owner. A pending checkpoint is attributable only
  -- when its extant pending connection proves the same project as the
  -- link — or, linkless, names the project itself. A deleted or
  -- projectless pending connection leaves the pending operation's owner
  -- unproven even beside a live link, so those rows keep the reserved
  -- legacy sentinel for explicit ownership recovery.
  CASE
    WHEN `state`.`pending_operation_id` IS NULL AND `link`.`project_id` IS NOT NULL
      THEN `link`.`project_id`
    WHEN `state`.`pending_operation_id` IS NOT NULL
     AND `pending_connection`.`project_id` IS NOT NULL
     AND `pending_connection`.`project_id` = `link`.`project_id`
      THEN `link`.`project_id`
    WHEN `link`.`project_id` IS NULL AND `pending_connection`.`project_id` IS NOT NULL
      THEN `pending_connection`.`project_id`
    ELSE '00000000-0000-0000-0000-000000000000'
  END,
  `state`.`provider`,
  `state`.`remote_scope_key`,
  `state`.`remote_task_id`,
  `state`.`logged_minutes`,
  `state`.`revision`,
  `state`.`pending_operation_id`,
  `state`.`pending_delta_minutes`,
  `state`.`pending_estimate_total_minutes`,
  `state`.`pending_started_at`,
  `state`.`pending_connection_id`,
  `state`.`pending_connection_generation`,
  `state`.`pending_phase`,
  `state`.`pending_resolution`,
  `state`.`aggregation_time_zone`,
  `state`.`pending_activity_date`,
  `state`.`created_at`,
  `state`.`updated_at`
FROM `external_estimate_log_states` `state`
LEFT JOIN `external_task_links` `link`
  ON `link`.`provider` = `state`.`provider`
 AND `link`.`remote_scope_key` = `state`.`remote_scope_key`
 AND `link`.`remote_task_id` = `state`.`remote_task_id`
LEFT JOIN `integration_connections` `pending_connection`
  ON `state`.`pending_operation_id` IS NOT NULL
 AND `pending_connection`.`id` = `state`.`pending_connection_id`;--> statement-breakpoint
DROP TABLE `external_estimate_log_states`;--> statement-breakpoint
ALTER TABLE `__new_external_estimate_log_states` RENAME TO `external_estimate_log_states`;--> statement-breakpoint
CREATE UNIQUE INDEX `external_estimate_log_states_project_remote_identity_idx` ON `external_estimate_log_states` (`project_id`,`provider`,`remote_scope_key`,`remote_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_estimate_log_states_pending_operation_idx` ON `external_estimate_log_states` (`pending_operation_id`) WHERE "external_estimate_log_states"."pending_operation_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_external_estimate_log_days` (
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_scope_key` text NOT NULL,
	`remote_task_id` text NOT NULL,
	`activity_date` text NOT NULL,
	`logged_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `provider`, `remote_scope_key`, `remote_task_id`, `activity_date`),
	CONSTRAINT "external_estimate_log_days_logged_minutes_check" CHECK("__new_external_estimate_log_days"."logged_minutes" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_external_estimate_log_days`(`project_id`, `provider`, `remote_scope_key`, `remote_task_id`, `activity_date`, `logged_minutes`, `created_at`, `updated_at`)
SELECT
  -- Day rows follow their scalar checkpoint's migrated owner; the sentinel
  -- fallback preserves any hypothetically orphaned ledger row.
  COALESCE(`state`.`project_id`, '00000000-0000-0000-0000-000000000000'),
  `day`.`provider`,
  `day`.`remote_scope_key`,
  `day`.`remote_task_id`,
  `day`.`activity_date`,
  `day`.`logged_minutes`,
  `day`.`created_at`,
  `day`.`updated_at`
FROM `external_estimate_log_days` `day`
LEFT JOIN `external_estimate_log_states` `state`
  ON `state`.`provider` = `day`.`provider`
 AND `state`.`remote_scope_key` = `day`.`remote_scope_key`
 AND `state`.`remote_task_id` = `day`.`remote_task_id`;--> statement-breakpoint
DROP TABLE `external_estimate_log_days`;--> statement-breakpoint
ALTER TABLE `__new_external_estimate_log_days` RENAME TO `external_estimate_log_days`;--> statement-breakpoint
PRAGMA foreign_keys=ON;

CREATE TABLE `external_estimate_log_states` (
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
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "external_estimate_log_states_logged_minutes_check" CHECK("external_estimate_log_states"."logged_minutes" >= 0),
	CONSTRAINT "external_estimate_log_states_revision_check" CHECK("external_estimate_log_states"."revision" >= 1),
	CONSTRAINT "external_estimate_log_states_pending_complete_check" CHECK((
        "external_estimate_log_states"."pending_operation_id" IS NULL
        AND "external_estimate_log_states"."pending_delta_minutes" IS NULL
        AND "external_estimate_log_states"."pending_estimate_total_minutes" IS NULL
        AND "external_estimate_log_states"."pending_started_at" IS NULL
        AND "external_estimate_log_states"."pending_connection_id" IS NULL
        AND "external_estimate_log_states"."pending_connection_generation" IS NULL
        AND "external_estimate_log_states"."pending_phase" IS NULL
        AND "external_estimate_log_states"."pending_resolution" IS NULL
      ) OR (
        "external_estimate_log_states"."pending_operation_id" IS NOT NULL
        AND "external_estimate_log_states"."pending_delta_minutes" IS NOT NULL
        AND "external_estimate_log_states"."pending_delta_minutes" > 0
        AND "external_estimate_log_states"."pending_delta_minutes" * 60000 <= 604800000
        AND "external_estimate_log_states"."pending_estimate_total_minutes" IS NOT NULL
        AND "external_estimate_log_states"."pending_estimate_total_minutes" >= 0
        AND "external_estimate_log_states"."pending_started_at" IS NOT NULL
        AND "external_estimate_log_states"."pending_connection_id" IS NOT NULL
        AND "external_estimate_log_states"."pending_connection_generation" IS NOT NULL
        AND "external_estimate_log_states"."pending_connection_generation" >= 1
        AND "external_estimate_log_states"."pending_phase" IS NOT NULL
        AND "external_estimate_log_states"."pending_phase" IN ('prepared', 'outcome_unknown')
        AND (
          "external_estimate_log_states"."pending_resolution" IS NULL
          OR "external_estimate_log_states"."pending_resolution" IN ('logged', 'not_logged')
        )
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_estimate_log_states_remote_identity_idx` ON `external_estimate_log_states` (`provider`,`remote_scope_key`,`remote_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `external_estimate_log_states_pending_operation_idx` ON `external_estimate_log_states` (`pending_operation_id`) WHERE "external_estimate_log_states"."pending_operation_id" IS NOT NULL;

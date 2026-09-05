CREATE TABLE `__integration_connection_project_evidence` (
	`source_connection_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY (`source_connection_id`, `project_id`)
);--> statement-breakpoint
INSERT OR IGNORE INTO `__integration_connection_project_evidence`
  (`source_connection_id`, `project_id`)
SELECT connection.`id`, epic.`project_id`
FROM `integration_connections` connection
INNER JOIN `external_task_links` task_link
  ON task_link.`connection_id` = connection.`id`
 AND task_link.`provider` = connection.`provider`
INNER JOIN `epics` epic ON epic.`id` = task_link.`epic_id`
WHERE connection.`project_id` IS NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `__integration_connection_project_evidence`
  (`source_connection_id`, `project_id`)
SELECT connection.`id`, child_epic.`project_id`
FROM `integration_connections` connection
INNER JOIN `external_managed_subtask_links` managed_link
  ON managed_link.`connection_id_snapshot` = connection.`id`
 AND managed_link.`provider` = connection.`provider`
INNER JOIN `epics` child_epic ON child_epic.`id` = managed_link.`epic_id`
WHERE connection.`project_id` IS NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `__integration_connection_project_evidence`
  (`source_connection_id`, `project_id`)
SELECT connection.`id`, parent_epic.`project_id`
FROM `integration_connections` connection
INNER JOIN `external_managed_subtask_links` managed_link
  ON managed_link.`connection_id_snapshot` = connection.`id`
 AND managed_link.`provider` = connection.`provider`
INNER JOIN `external_task_links` parent_source
  ON parent_source.`id` = managed_link.`parent_source_link_id_snapshot`
 AND parent_source.`provider` = managed_link.`provider`
INNER JOIN `epics` parent_epic ON parent_epic.`id` = parent_source.`epic_id`
WHERE connection.`project_id` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `epics` child_epic WHERE child_epic.`id` = managed_link.`epic_id`
  );--> statement-breakpoint
INSERT OR IGNORE INTO `__integration_connection_project_evidence`
  (`source_connection_id`, `project_id`)
SELECT connection.`id`, project.`id`
FROM `integration_connections` connection
INNER JOIN `projects` project ON project.`is_template` = 0
WHERE connection.`project_id` IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM `__integration_connection_project_evidence` evidence
    WHERE evidence.`source_connection_id` = connection.`id`
  )
  AND (SELECT COUNT(*) FROM `projects` WHERE `is_template` = 0) = 1;--> statement-breakpoint
CREATE TABLE `__integration_connection_project_map` (
	`source_connection_id` text NOT NULL,
	`project_id` text NOT NULL,
	`target_connection_id` text PRIMARY KEY NOT NULL,
	UNIQUE (`source_connection_id`, `project_id`)
);--> statement-breakpoint
INSERT INTO `__integration_connection_project_map`
  (`source_connection_id`, `project_id`, `target_connection_id`)
WITH RECURSIVE
ordered_evidence AS (
  SELECT evidence.`source_connection_id`, evidence.`project_id`,
    row_number() OVER (
      ORDER BY evidence.`source_connection_id`, evidence.`project_id`
    ) AS `ordinal`
  FROM `__integration_connection_project_evidence` evidence
),
candidate_numbers(`value`) AS (
  SELECT 1
  UNION ALL
  SELECT `value` + 1
  FROM candidate_numbers
  WHERE `value` <
    (SELECT COUNT(*) FROM `__integration_connection_project_evidence`) +
    (SELECT COUNT(*) FROM `integration_connections`)
),
available_ids AS (
  SELECT
    'dc000000-0000-4000-8000-' || printf('%012x', candidate_numbers.`value`) AS `id`,
    row_number() OVER (ORDER BY candidate_numbers.`value`) AS `ordinal`
  FROM candidate_numbers
  WHERE NOT EXISTS (
    SELECT 1
    FROM `integration_connections` existing
    WHERE existing.`id` =
      'dc000000-0000-4000-8000-' || printf('%012x', candidate_numbers.`value`)
  )
)
SELECT ordered_evidence.`source_connection_id`, ordered_evidence.`project_id`, available_ids.`id`
FROM ordered_evidence
INNER JOIN available_ids ON available_ids.`ordinal` = ordered_evidence.`ordinal`
ORDER BY ordered_evidence.`ordinal`;--> statement-breakpoint
INSERT INTO `integration_connections` (
  `id`, `project_id`, `provider`, `legacy_source_connection_id`,
  `credential_ciphertext`, `generation`, `subtask_sync_enabled`,
  `sync_setting_revision`, `created_at`, `updated_at`
)
SELECT project_map.`target_connection_id`, project_map.`project_id`, source.`provider`, source.`id`,
  source.`credential_ciphertext`, source.`generation`, source.`subtask_sync_enabled`,
  source.`sync_setting_revision`, source.`created_at`, source.`updated_at`
FROM `__integration_connection_project_map` project_map
INNER JOIN `integration_connections` source
  ON source.`id` = project_map.`source_connection_id`
ORDER BY project_map.`source_connection_id`, project_map.`project_id`;--> statement-breakpoint
UPDATE `external_task_links`
SET `connection_id` = (
  SELECT project_map.`target_connection_id`
  FROM `__integration_connection_project_map` project_map
  INNER JOIN `epics` epic ON epic.`id` = `external_task_links`.`epic_id`
  INNER JOIN `integration_connections` target
    ON target.`id` = project_map.`target_connection_id`
   AND target.`provider` = `external_task_links`.`provider`
  WHERE project_map.`source_connection_id` = `external_task_links`.`connection_id`
    AND project_map.`project_id` = epic.`project_id`
)
WHERE EXISTS (
  SELECT 1
  FROM `__integration_connection_project_map` project_map
  INNER JOIN `epics` epic ON epic.`id` = `external_task_links`.`epic_id`
  INNER JOIN `integration_connections` target
    ON target.`id` = project_map.`target_connection_id`
   AND target.`provider` = `external_task_links`.`provider`
  WHERE project_map.`source_connection_id` = `external_task_links`.`connection_id`
    AND project_map.`project_id` = epic.`project_id`
);--> statement-breakpoint
UPDATE `external_managed_subtask_links`
SET `connection_id_snapshot` = (
  SELECT project_map.`target_connection_id`
  FROM `__integration_connection_project_map` project_map
  INNER JOIN `integration_connections` target
    ON target.`id` = project_map.`target_connection_id`
   AND target.`provider` = `external_managed_subtask_links`.`provider`
  WHERE project_map.`source_connection_id` = `external_managed_subtask_links`.`connection_id_snapshot`
    AND project_map.`project_id` = COALESCE(
      (SELECT child_epic.`project_id`
       FROM `epics` child_epic
       WHERE child_epic.`id` = `external_managed_subtask_links`.`epic_id`),
      (SELECT parent_epic.`project_id`
       FROM `external_task_links` parent_source
       INNER JOIN `epics` parent_epic ON parent_epic.`id` = parent_source.`epic_id`
       WHERE parent_source.`id` = `external_managed_subtask_links`.`parent_source_link_id_snapshot`
         AND parent_source.`provider` = `external_managed_subtask_links`.`provider`)
    )
)
WHERE EXISTS (
  SELECT 1
  FROM `__integration_connection_project_map` project_map
  INNER JOIN `integration_connections` target
    ON target.`id` = project_map.`target_connection_id`
   AND target.`provider` = `external_managed_subtask_links`.`provider`
  WHERE project_map.`source_connection_id` = `external_managed_subtask_links`.`connection_id_snapshot`
    AND project_map.`project_id` = COALESCE(
      (SELECT child_epic.`project_id`
       FROM `epics` child_epic
       WHERE child_epic.`id` = `external_managed_subtask_links`.`epic_id`),
      (SELECT parent_epic.`project_id`
       FROM `external_task_links` parent_source
       INNER JOIN `epics` parent_epic ON parent_epic.`id` = parent_source.`epic_id`
       WHERE parent_source.`id` = `external_managed_subtask_links`.`parent_source_link_id_snapshot`
         AND parent_source.`provider` = `external_managed_subtask_links`.`provider`)
    )
);--> statement-breakpoint
DELETE FROM `integration_connections`
WHERE `project_id` IS NULL
  AND EXISTS (
    SELECT 1
    FROM `__integration_connection_project_map` project_map
    WHERE project_map.`source_connection_id` = `integration_connections`.`id`
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `external_task_links` task_link
    WHERE task_link.`connection_id` = `integration_connections`.`id`
  )
  AND NOT EXISTS (
    SELECT 1
    FROM `external_managed_subtask_links` managed_link
    WHERE managed_link.`connection_id_snapshot` = `integration_connections`.`id`
  );--> statement-breakpoint
DROP TABLE `__integration_connection_project_map`;--> statement-breakpoint
DROP TABLE `__integration_connection_project_evidence`;

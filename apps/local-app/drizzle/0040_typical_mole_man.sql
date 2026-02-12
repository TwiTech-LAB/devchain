ALTER TABLE `skill_project_blacklist` RENAME TO `skill_project_disabled`;--> statement-breakpoint
DROP INDEX IF EXISTS `skill_project_blacklist_project_skill_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `skill_project_disabled_project_skill_unique` ON `skill_project_disabled` (`project_id`,`skill_id`);

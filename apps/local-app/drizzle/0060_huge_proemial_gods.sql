ALTER TABLE `sessions` ADD `provider_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `provider_name_at_launch` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `size_bytes` integer;--> statement-breakpoint
CREATE INDEX `idx_sessions_agent_history` ON `sessions` (`agent_id`,`status`,`last_activity_at`);--> statement-breakpoint
UPDATE `sessions` SET `provider_session_id` = `claude_session_id` WHERE `claude_session_id` IS NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `provider_name_at_launch` = (
  SELECT LOWER(p.name)
  FROM agents a
  JOIN profile_provider_configs ppc ON a.provider_config_id = ppc.id
  JOIN providers p ON ppc.provider_id = p.id
  WHERE a.id = sessions.agent_id
) WHERE `agent_id` IS NOT NULL;

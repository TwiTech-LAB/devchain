ALTER TABLE `sessions` ADD `inherited_session_ids` text;--> statement-breakpoint
UPDATE sessions SET inherited_session_ids = json_array(parent_session_id) WHERE kind = 'save_point' AND parent_session_id IS NOT NULL;

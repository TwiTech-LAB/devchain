ALTER TABLE `sessions` ADD `parent_session_id` text REFERENCES sessions(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `kind` text DEFAULT 'session' NOT NULL;

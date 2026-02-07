ALTER TABLE `terminal_watchers`
ADD COLUMN `idle_after_seconds` INTEGER NOT NULL DEFAULT 0;

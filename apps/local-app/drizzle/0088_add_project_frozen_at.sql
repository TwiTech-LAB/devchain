-- Remote handoff write freeze. NULL = not frozen; otherwise the ISO time the freeze began.
-- Local to this instance: the project replica never carries it (projects rows are
-- read without it and the applier never writes it).
ALTER TABLE `projects` ADD `frozen_at` text;

-- Let admins keep a write-capable account (for example root) while the app still
-- enforces read-only SQL. Existing rows default to the strict behaviour.
ALTER TABLE `datasources` ADD `allow_write_account` integer DEFAULT 0 NOT NULL;

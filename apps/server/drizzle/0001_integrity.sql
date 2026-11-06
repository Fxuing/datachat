ALTER TABLE `datasources` ADD `options_json` text;--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `conversations_user_last_message_idx` ON `conversations` (`user_id`,`last_message_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `datasource_grants_datasource_user_unique` ON `datasource_grants` (`datasource_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `query_audit_datasource_created_idx` ON `query_audit` (`datasource_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_unique` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `runs_conversation_idx` ON `runs` (`conversation_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	CONSTRAINT "users_role_check" CHECK("__new_users"."role" in ('admin', 'user'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "password_hash", "display_name", "role", "status", "created_at", "last_login_at") SELECT "id", "username", "password_hash", "display_name", "role", "status", "created_at", "last_login_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_nocase_unique` ON `users` (`username` COLLATE NOCASE);--> statement-breakpoint
CREATE TABLE `__new_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`conversation_id` text,
	`report_id` text,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "shares_target_check" CHECK(("__new_shares"."conversation_id" is null) + ("__new_shares"."report_id" is null) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_shares`("id", "token_hash", "conversation_id", "report_id", "created_by", "expires_at", "revoked_at", "created_at") SELECT "id", "token_hash", "conversation_id", "report_id", "created_by", "expires_at", "revoked_at", "created_at" FROM `shares`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
ALTER TABLE `__new_shares` RENAME TO `shares`;--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_hash_unique` ON `shares` (`token_hash`);--> statement-breakpoint
CREATE TABLE `__new_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`datasource_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "skills_scope_check" CHECK(("__new_skills"."scope" = 'global' and "__new_skills"."datasource_id" is null) or ("__new_skills"."scope" = 'datasource' and "__new_skills"."datasource_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_skills`("id", "scope", "datasource_id", "name", "description", "content", "enabled", "updated_by", "created_at", "updated_at") SELECT "id", "scope", "datasource_id", "name", "description", "content", "enabled", "updated_by", "created_at", "updated_at" FROM `skills`;--> statement-breakpoint
DROP TABLE `skills`;--> statement-breakpoint
ALTER TABLE `__new_skills` RENAME TO `skills`;
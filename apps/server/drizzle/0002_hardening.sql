-- Hardening pass: audit metadata, artifact ownership, and lookup indexes.

CREATE TABLE `query_audit_new` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`conversation_id` text,
	`user_id` text,
	`datasource_id` text,
	`action` text DEFAULT 'query' NOT NULL,
	`sql_text` text NOT NULL,
	`sql_hash` text NOT NULL,
	`status` text NOT NULL,
	`row_count` integer,
	`duration_ms` integer,
	`error_message` text,
	`detail_json` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `query_audit_action_check` CHECK (`action` in (
		'query','explain','export','login','login_failed',
		'user_create','user_update','datasource_create','datasource_update',
		'datasource_delete','grant_update'
	))
);
--> statement-breakpoint
INSERT INTO `query_audit_new` (
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,`created_at`
)
SELECT
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,`created_at`
FROM `query_audit`;
--> statement-breakpoint
DROP TABLE `query_audit`;
--> statement-breakpoint
ALTER TABLE `query_audit_new` RENAME TO `query_audit`;
--> statement-breakpoint
CREATE INDEX `query_audit_datasource_created_idx` ON `query_audit` (`datasource_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `query_audit_created_idx` ON `query_audit` (`created_at`);
--> statement-breakpoint
CREATE TABLE `artifacts_new` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`user_id` text,
	`run_id` text,
	`kind` text NOT NULL,
	`storage_path` text,
	`columns_json` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`spec_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `artifacts_new` (
	`id`,`conversation_id`,`run_id`,`kind`,`storage_path`,`columns_json`,
	`row_count`,`truncated`,`spec_json`,`created_at`
)
SELECT
	`id`,`conversation_id`,`run_id`,`kind`,`storage_path`,`columns_json`,
	`row_count`,`truncated`,`spec_json`,`created_at`
FROM `artifacts`;
--> statement-breakpoint
DROP TABLE `artifacts`;
--> statement-breakpoint
ALTER TABLE `artifacts_new` RENAME TO `artifacts`;
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);
--> statement-breakpoint
CREATE INDEX `artifacts_user_idx` ON `artifacts` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasources_name_nocase_unique` ON `datasources` (`name` COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX `datasource_grants_user_idx` ON `datasource_grants` (`user_id`);
--> statement-breakpoint
CREATE INDEX `run_events_conversation_seq_idx` ON `run_events` (`conversation_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `runs_conversation_created_idx` ON `runs` (`conversation_id`,`created_at`);

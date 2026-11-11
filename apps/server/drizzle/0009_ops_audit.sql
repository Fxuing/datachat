-- Allow operations audit events (retention runs, backup/restore).
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
		'datasource_delete','grant_update','skill_change','mcp_change','ops'
	))
);
--> statement-breakpoint
INSERT INTO `query_audit_new` (
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,`created_at`
)
SELECT
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,`created_at`
FROM `query_audit`;
--> statement-breakpoint
DROP TABLE `query_audit`;
--> statement-breakpoint
ALTER TABLE `query_audit_new` RENAME TO `query_audit`;
--> statement-breakpoint
CREATE INDEX `query_audit_datasource_created_idx` ON `query_audit` (`datasource_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `query_audit_created_idx` ON `query_audit` (`created_at`);

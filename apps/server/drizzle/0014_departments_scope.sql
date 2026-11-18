ALTER TABLE `datasources` ADD COLUMN `data_scope_mode` text NOT NULL DEFAULT 'off' CHECK (`data_scope_mode` in ('off', 'configuring', 'enabled'));
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `scope_snapshot` text;
--> statement-breakpoint
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
	`scope_reason` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `query_audit_action_check` CHECK (`action` in (
		'query','explain','export','login','login_failed',
		'user_create','user_update','datasource_create','datasource_update',
		'datasource_delete','grant_update','department_change','data_scope_change',
		'data_scope_enable','skill_change','mcp_change','role_change','ops'
	))
);
--> statement-breakpoint
INSERT INTO `query_audit_new` (
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,`scope_reason`,`created_at`
)
SELECT
	`id`,`run_id`,`conversation_id`,`user_id`,`datasource_id`,`action`,
	`sql_text`,`sql_hash`,`status`,`row_count`,`duration_ms`,`error_message`,
	`detail_json`,NULL,`created_at`
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
CREATE TABLE `departments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`parent_id` text REFERENCES `departments`(`id`) ON DELETE RESTRICT,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `departments_status_check` CHECK (`status` in ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `departments_code_unique` ON `departments` (`code`);
--> statement-breakpoint
CREATE INDEX `departments_parent_idx` ON `departments` (`parent_id`);
--> statement-breakpoint
CREATE TABLE `department_closure` (
	`ancestor_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
	`descendant_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
	`depth` integer NOT NULL,
	PRIMARY KEY (`ancestor_id`, `descendant_id`),
	CONSTRAINT `department_closure_depth_check` CHECK (`depth` >= 0)
);
--> statement-breakpoint
CREATE INDEX `department_closure_descendant_idx` ON `department_closure` (`descendant_id`, `depth`);
--> statement-breakpoint
CREATE TABLE `user_departments` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
	`is_primary` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`user_id`, `department_id`),
	CONSTRAINT `user_departments_primary_check` CHECK (`is_primary` in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `user_departments_department_idx` ON `user_departments` (`department_id`);
--> statement-breakpoint
CREATE TABLE `department_datasource_grants` (
	`department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
	`datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
	`created_at` integer NOT NULL,
	PRIMARY KEY (`department_id`, `datasource_id`)
);
--> statement-breakpoint
CREATE INDEX `department_datasource_grants_datasource_idx` ON `department_datasource_grants` (`datasource_id`);
--> statement-breakpoint
CREATE TABLE `department_org_map` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
	`department_id` text NOT NULL REFERENCES `departments`(`id`) ON DELETE CASCADE,
	`external_id` text,
	`external_code` text,
	`external_org_code` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `department_org_map_source_check` CHECK (`source` in ('manual', 'import')),
	CONSTRAINT `department_org_map_external_check` CHECK ((coalesce(`external_id`, '') <> '') or (coalesce(`external_code`, '') <> '') or (coalesce(`external_org_code`, '') <> ''))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `department_org_map_datasource_department_unique` ON `department_org_map` (`datasource_id`, `department_id`);
--> statement-breakpoint
CREATE INDEX `department_org_map_datasource_idx` ON `department_org_map` (`datasource_id`);
--> statement-breakpoint
CREATE TABLE `data_scope_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
	`table_name` text NOT NULL,
	`mode` text NOT NULL,
	`column_name` text,
	`value_mode` text,
	`null_visible` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `data_scope_policies_mode_check` CHECK (`mode` in ('scoped', 'public', 'denied')),
	CONSTRAINT `data_scope_policies_value_mode_check` CHECK (`value_mode` is null or `value_mode` in ('app_id', 'app_code', 'external_id', 'external_code', 'external_org_code')),
	CONSTRAINT `data_scope_policies_null_visible_check` CHECK (`null_visible` in (0, 1)),
	CONSTRAINT `data_scope_policies_enabled_check` CHECK (`enabled` in (0, 1)),
	CONSTRAINT `data_scope_policies_scoped_check` CHECK (`mode` <> 'scoped' or (`column_name` is not null and `value_mode` is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_scope_policies_table_unique` ON `data_scope_policies` (`datasource_id`, `table_name`);
--> statement-breakpoint
CREATE INDEX `data_scope_policies_datasource_idx` ON `data_scope_policies` (`datasource_id`);

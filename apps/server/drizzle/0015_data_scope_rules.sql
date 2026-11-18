-- Conditions move out of data_scope_policies into data_scope_rules so a table
-- can combine a hard constraint (is_deleted = 0) with an identity filter.
-- The old table shape is rebuilt because its CHECK required a single column.
CREATE TABLE `__data_scope_legacy_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL,
	`column_name` text NOT NULL,
	`value_mode` text NOT NULL,
	`null_visible` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__data_scope_legacy_rules` (`id`,`policy_id`,`column_name`,`value_mode`,`null_visible`,`created_at`)
SELECT 'legacy_' || `id`, `id`, `column_name`, `value_mode`, `null_visible`, `created_at`
FROM `data_scope_policies`
WHERE `mode` = 'scoped' AND `column_name` IS NOT NULL AND `value_mode` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `data_scope_policies_new` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL,
	`table_name` text NOT NULL,
	`mode` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `data_scope_policies_mode_check` CHECK (`mode` in ('scoped', 'public', 'denied')),
	CONSTRAINT `data_scope_policies_enabled_check` CHECK (`enabled` in (0, 1))
);
--> statement-breakpoint
INSERT INTO `data_scope_policies_new` (`id`,`datasource_id`,`table_name`,`mode`,`enabled`,`created_at`,`updated_at`)
SELECT `id`,`datasource_id`,`table_name`,`mode`,`enabled`,`created_at`,`updated_at` FROM `data_scope_policies`;
--> statement-breakpoint
DROP TABLE `data_scope_policies`;
--> statement-breakpoint
ALTER TABLE `data_scope_policies_new` RENAME TO `data_scope_policies`;
--> statement-breakpoint
CREATE UNIQUE INDEX `data_scope_policies_table_unique` ON `data_scope_policies` (`datasource_id`,`table_name`);
--> statement-breakpoint
CREATE INDEX `data_scope_policies_datasource_idx` ON `data_scope_policies` (`datasource_id`);
--> statement-breakpoint
CREATE TABLE `data_scope_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_id` text NOT NULL REFERENCES `data_scope_policies`(`id`) ON DELETE CASCADE,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`column_name` text NOT NULL,
	`operator` text NOT NULL,
	`value_mode` text NOT NULL,
	`literal_values_json` text,
	`null_visible` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `data_scope_rules_operator_check` CHECK (`operator` in ('eq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte')),
	CONSTRAINT `data_scope_rules_value_mode_check` CHECK (`value_mode` in ('literal', 'department_id', 'department_code', 'external_id', 'external_code', 'external_org_code', 'user_id', 'username', 'role')),
	CONSTRAINT `data_scope_rules_null_visible_check` CHECK (`null_visible` in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `data_scope_rules_policy_idx` ON `data_scope_rules` (`policy_id`,`sort_order`);
--> statement-breakpoint
INSERT INTO `data_scope_rules` (`id`,`policy_id`,`sort_order`,`column_name`,`operator`,`value_mode`,`literal_values_json`,`null_visible`,`created_at`)
SELECT
	`id`,
	`policy_id`,
	0,
	`column_name`,
	'in',
	CASE `value_mode`
		WHEN 'app_id' THEN 'department_id'
		WHEN 'app_code' THEN 'department_code'
		ELSE `value_mode`
	END,
	NULL,
	`null_visible`,
	`created_at`
FROM `__data_scope_legacy_rules`;
--> statement-breakpoint
DROP TABLE `__data_scope_legacy_rules`;

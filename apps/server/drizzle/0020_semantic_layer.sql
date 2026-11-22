CREATE TABLE `semantic_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL,
	`name` text NOT NULL,
	`synonyms_json` text DEFAULT '[]' NOT NULL,
	`description` text,
	`sql_expression` text NOT NULL,
	`table_name` text,
	`default_filters_json` text DEFAULT '[]' NOT NULL,
	`time_column` text,
	`unit` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`datasource_id`) REFERENCES `datasources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "semantic_metrics_enabled_check" CHECK("semantic_metrics"."enabled" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `semantic_metrics_ds_name_unique` ON `semantic_metrics` (`datasource_id`,`name`);--> statement-breakpoint
CREATE INDEX `semantic_metrics_ds_enabled_idx` ON `semantic_metrics` (`datasource_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `semantic_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL,
	`left_table` text NOT NULL,
	`left_column` text NOT NULL,
	`right_table` text NOT NULL,
	`right_column` text NOT NULL,
	`join_type` text DEFAULT 'left' NOT NULL,
	`description` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`datasource_id`) REFERENCES `datasources`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "semantic_relations_join_type_check" CHECK("semantic_relations"."join_type" in ('inner', 'left', 'right')),
	CONSTRAINT "semantic_relations_enabled_check" CHECK("semantic_relations"."enabled" in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `semantic_relations_ds_edge_unique` ON `semantic_relations` (`datasource_id`,`left_table`,`left_column`,`right_table`,`right_column`);--> statement-breakpoint
CREATE INDEX `semantic_relations_ds_enabled_idx` ON `semantic_relations` (`datasource_id`,`enabled`);
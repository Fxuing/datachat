-- Reusable per-user Excel / CSV lightweight datasets.

CREATE TABLE `file_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`file_type` text DEFAULT 'xlsx' NOT NULL,
	`file_count` integer DEFAULT 1 NOT NULL,
	`table_count` integer DEFAULT 0 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `file_datasets_type_check` CHECK (`file_type` in ('xlsx', 'csv'))
);
--> statement-breakpoint
CREATE INDEX `file_datasets_user_updated_idx` ON `file_datasets` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `file_dataset_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`dataset_id` text NOT NULL,
	`table_name` text NOT NULL,
	`display_name` text NOT NULL,
	`sheet_name` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`columns_json` text NOT NULL,
	`sample_rows_json` text NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `file_datasets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_dataset_tables_dataset_name_unique` ON `file_dataset_tables` (`dataset_id`,`table_name`);
--> statement-breakpoint
CREATE INDEX `file_dataset_tables_dataset_idx` ON `file_dataset_tables` (`dataset_id`,`created_at`);

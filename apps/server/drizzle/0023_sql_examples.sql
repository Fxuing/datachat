CREATE TABLE `sql_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL,
	`question` text NOT NULL,
	`sql_text` text NOT NULL,
	`notes` text,
	`tables_json` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_run_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`datasource_id`) REFERENCES `datasources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sql_examples_datasource_idx` ON `sql_examples` (`datasource_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `sql_examples_source_run_idx` ON `sql_examples` (`source_run_id`);--> statement-breakpoint
ALTER TABLE `run_feedback` ADD `review_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `run_feedback` ADD `reviewed_at` integer;
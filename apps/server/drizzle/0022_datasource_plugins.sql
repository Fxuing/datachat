CREATE TABLE `datasource_plugins` (
	`driver_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`version` text NOT NULL,
	`file_name` text NOT NULL,
	`entry_path` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);

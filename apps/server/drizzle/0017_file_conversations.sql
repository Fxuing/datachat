-- Support temporary Excel / CSV file-analysis conversations with nullable datasource_id.

CREATE TABLE `conversations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text DEFAULT 'datasource' NOT NULL,
	`datasource_id` text,
	`title` text,
	`model_id` text,
	`thinking_level` text DEFAULT 'off' NOT NULL,
	`kind` text DEFAULT 'chat' NOT NULL,
	`pi_session_file` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer,
	CONSTRAINT `conversations_kind_check` CHECK (`kind` in ('chat', 'scheduled')),
	CONSTRAINT `conversations_source_check` CHECK ((`source_kind` = 'datasource' and `datasource_id` is not null) or (`source_kind` = 'file' and `datasource_id` is null))
);
--> statement-breakpoint
INSERT INTO `conversations_new` (
	`id`,`user_id`,`source_kind`,`datasource_id`,`title`,`model_id`,`thinking_level`,
	`kind`,`pi_session_file`,`status`,`created_at`,`updated_at`,`last_message_at`
)
SELECT
	`id`,`user_id`,'datasource',`datasource_id`,`title`,`model_id`,`thinking_level`,
	`kind`,`pi_session_file`,`status`,`created_at`,`updated_at`,`last_message_at`
FROM `conversations`;
--> statement-breakpoint
DROP TABLE `conversations`;
--> statement-breakpoint
ALTER TABLE `conversations_new` RENAME TO `conversations`;
--> statement-breakpoint
CREATE INDEX `conversations_user_last_message_idx` ON `conversations` (`user_id`,`last_message_at`);
--> statement-breakpoint
CREATE TABLE `conversation_files` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`header_row` integer DEFAULT 1 NOT NULL,
	`table_count` integer DEFAULT 0 NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `conversation_files_type_check` CHECK (`file_type` in ('xlsx', 'csv')),
	CONSTRAINT `conversation_files_header_row_check` CHECK (`header_row` >= 1)
);
--> statement-breakpoint
CREATE INDEX `conversation_files_conversation_idx` ON `conversation_files` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `conversation_files_user_idx` ON `conversation_files` (`user_id`);
--> statement-breakpoint
CREATE TABLE `conversation_file_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`file_id` text NOT NULL,
	`table_name` text NOT NULL,
	`display_name` text NOT NULL,
	`sheet_name` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`columns_json` text NOT NULL,
	`sample_rows_json` text NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_file_tables_conv_name_unique` ON `conversation_file_tables` (`conversation_id`,`table_name`);
--> statement-breakpoint
CREATE INDEX `conversation_file_tables_conversation_idx` ON `conversation_file_tables` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `conversation_file_tables_file_idx` ON `conversation_file_tables` (`file_id`);

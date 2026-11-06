CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
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
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`datasource_id` text NOT NULL,
	`title` text,
	`model_id` text,
	`thinking_level` text DEFAULT 'off' NOT NULL,
	`pi_session_file` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_message_at` integer
);
--> statement-breakpoint
CREATE TABLE `datasource_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`datasource_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `datasource_schema_cache` (
	`datasource_id` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`table_count` integer DEFAULT 0 NOT NULL,
	`refreshed_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `datasources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`database` text NOT NULL,
	`username` text NOT NULL,
	`password_cipher` text NOT NULL,
	`ssl_mode` text DEFAULT 'disable' NOT NULL,
	`read_only_verified` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_checked_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `datasources_name_unique` ON `datasources` (`name`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`args_json` text,
	`env_cipher` text,
	`url` text,
	`headers_cipher` text,
	`datasource_id` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `query_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`conversation_id` text,
	`user_id` text NOT NULL,
	`datasource_id` text NOT NULL,
	`action` text DEFAULT 'query' NOT NULL,
	`sql_text` text NOT NULL,
	`sql_hash` text NOT NULL,
	`status` text NOT NULL,
	`row_count` integer,
	`duration_ms` integer,
	`error_message` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`markdown` text NOT NULL,
	`artifact_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`model_id` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_write_tokens` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`conversation_id` text,
	`report_id` text,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_hash_unique` ON `shares` (`token_hash`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`datasource_id` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
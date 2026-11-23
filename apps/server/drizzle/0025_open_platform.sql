CREATE TABLE `open_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`service_user_id` text NOT NULL,
	`allowed_datasource_ids_json` text,
	`scopes_json` text DEFAULT '["ask","report","semantic","mcp","feedback"]' NOT NULL,
	`allow_end_user_override` integer DEFAULT 0 NOT NULL,
	`expose_sql` integer DEFAULT 1 NOT NULL,
	`default_model_id` text,
	`system_prompt_extra` text,
	`rate_limit_rpm` integer DEFAULT 60 NOT NULL,
	`max_rows_override` integer,
	`timeout_ms_override` integer,
	`webhook_url` text,
	`webhook_secret_cipher` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "open_apps_status_check" CHECK(`status` in ('active', 'disabled')),
	CONSTRAINT "open_apps_override_check" CHECK(`allow_end_user_override` in (0, 1)),
	CONSTRAINT "open_apps_expose_sql_check" CHECK(`expose_sql` in (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_apps_name_nocase_unique` ON `open_apps` (`name` COLLATE NOCASE);--> statement-breakpoint
CREATE INDEX `open_apps_service_user_idx` ON `open_apps` (`service_user_id`);--> statement-breakpoint
CREATE TABLE `open_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `open_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_api_keys_hash_unique` ON `open_api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `open_api_keys_app_idx` ON `open_api_keys` (`app_id`, `created_at`);--> statement-breakpoint
CREATE TABLE `open_app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`datasource_id` text NOT NULL,
	`external_session_id` text,
	`external_user_id` text,
	`effective_user_id` text NOT NULL,
	`scope_department_ids_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `open_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `open_app_sessions_conversation_unique` ON `open_app_sessions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `open_app_sessions_app_ext_idx` ON `open_app_sessions` (`app_id`, `external_session_id`);--> statement-breakpoint
CREATE INDEX `open_app_sessions_app_created_idx` ON `open_app_sessions` (`app_id`, `created_at`);--> statement-breakpoint
CREATE TABLE `open_api_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key_id` text,
	`endpoint` text NOT NULL,
	`datasource_id` text,
	`conversation_id` text,
	`run_id` text,
	`report_id` text,
	`external_user_id` text,
	`effective_user_id` text,
	`status` text NOT NULL,
	`http_status` integer NOT NULL,
	`error_code` text,
	`error_message` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `open_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "open_api_audit_status_check" CHECK(`status` in ('ok', 'error', 'rejected', 'rate_limited'))
);
--> statement-breakpoint
CREATE INDEX `open_api_audit_app_created_idx` ON `open_api_audit` (`app_id`, `created_at`);--> statement-breakpoint
CREATE INDEX `open_api_audit_created_idx` ON `open_api_audit` (`created_at`);--> statement-breakpoint
CREATE TABLE `open_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`event` text NOT NULL,
	`target_url` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`http_status` integer,
	`response_snippet` text,
	`error` text,
	`created_at` integer NOT NULL,
	`last_attempt_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `open_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "open_webhook_deliveries_status_check" CHECK(`status` in ('pending', 'ok', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `open_webhook_deliveries_app_created_idx` ON `open_webhook_deliveries` (`app_id`, `created_at`);

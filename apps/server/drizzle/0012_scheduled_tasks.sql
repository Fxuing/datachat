ALTER TABLE `conversations` ADD COLUMN `kind` text NOT NULL DEFAULT 'chat' CHECK (`kind` in ('chat', 'scheduled'));
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`datasource_id` text NOT NULL,
	`model_id` text,
	`cron_expression` text NOT NULL,
	`timezone` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `scheduled_tasks_last_status_check` CHECK (`last_status` is null or `last_status` in ('success', 'failed', 'skipped')),
	CONSTRAINT `scheduled_tasks_failures_check` CHECK (`consecutive_failures` >= 0)
);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_due_idx` ON `scheduled_tasks` (`enabled`, `next_run_at`);
--> statement-breakpoint
CREATE INDEX `scheduled_tasks_user_idx` ON `scheduled_tasks` (`user_id`);
--> statement-breakpoint
CREATE TABLE `scheduled_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`conversation_id` text,
	`report_id` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `scheduled_task_runs_trigger_check` CHECK (`trigger` in ('schedule', 'manual')),
	CONSTRAINT `scheduled_task_runs_status_check` CHECK (`status` in ('running', 'success', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `scheduled_task_runs_task_idx` ON `scheduled_task_runs` (`task_id`);
--> statement-breakpoint
CREATE INDEX `scheduled_task_runs_created_idx` ON `scheduled_task_runs` (`created_at`);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`href` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `notifications_type_check` CHECK (`type` in ('task_success', 'task_failed', 'task_disabled'))
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`);
--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`user_id`, `read_at`);

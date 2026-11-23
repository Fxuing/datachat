PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`conversation_id` text,
	`report_id` text,
	`dashboard_id` text,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "shares_target_check" CHECK((`conversation_id` is null) + (`report_id` is null) + (`dashboard_id` is null) = 2)
);
--> statement-breakpoint
INSERT INTO `__new_shares`("id", "token_hash", "conversation_id", "report_id", "dashboard_id", "created_by", "expires_at", "revoked_at", "created_at") SELECT "id", "token_hash", "conversation_id", "report_id", NULL, "created_by", "expires_at", "revoked_at", "created_at" FROM `shares`;--> statement-breakpoint
DROP TABLE `shares`;--> statement-breakpoint
ALTER TABLE `__new_shares` RENAME TO `shares`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_hash_unique` ON `shares` (`token_hash`);--> statement-breakpoint
ALTER TABLE `dashboards` ADD `refresh_cron` text;--> statement-breakpoint
ALTER TABLE `dashboards` ADD `refresh_timezone` text DEFAULT 'Asia/Shanghai' NOT NULL;--> statement-breakpoint
ALTER TABLE `dashboards` ADD `next_refresh_at` integer;--> statement-breakpoint
ALTER TABLE `dashboards` ADD `last_auto_refreshed_at` integer;--> statement-breakpoint
ALTER TABLE `dashboards` ADD `last_auto_refresh_error` text;--> statement-breakpoint
CREATE INDEX `dashboards_next_refresh_idx` ON `dashboards` (`next_refresh_at`);
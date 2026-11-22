CREATE TABLE `dashboard_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`source_conversation_id` text,
	`source_artifact_id` text,
	`datasource_id` text,
	`sql_text` text,
	`chart_config_json` text,
	`spec_json` text NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`width` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`last_refreshed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dashboard_cards_width_check" CHECK("dashboard_cards"."width" in (1, 2))
);
--> statement-breakpoint
CREATE INDEX `dashboard_cards_dashboard_pos_idx` ON `dashboard_cards` (`dashboard_id`,`position`,`created_at`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboards_user_updated_idx` ON `dashboards` (`user_id`,`updated_at`);
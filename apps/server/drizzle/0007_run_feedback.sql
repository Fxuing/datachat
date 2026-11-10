CREATE TABLE `run_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`rating` integer NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "run_feedback_rating_check" CHECK(`rating` in (-1, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_feedback_run_user_unique` ON `run_feedback` (`run_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `run_feedback_user_idx` ON `run_feedback` (`user_id`);

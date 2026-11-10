ALTER TABLE `runs` ADD `retry_of_run_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_retry_of_unique` ON `runs` (`retry_of_run_id`);

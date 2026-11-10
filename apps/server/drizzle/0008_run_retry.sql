ALTER TABLE `runs` ADD `retry_of_run_id` text;
--> statement-breakpoint
CREATE INDEX `runs_retry_of_idx` ON `runs` (`retry_of_run_id`);

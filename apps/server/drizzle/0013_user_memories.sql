CREATE TABLE `user_memories` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `datasource_id` text REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL CHECK (`kind` in ('profile','instruction','preference','fact')),
  `title` text NOT NULL,
  `content` text NOT NULL,
  `core` integer NOT NULL DEFAULT 0,
  `enabled` integer NOT NULL DEFAULT 1,
  `confidence` integer NOT NULL DEFAULT 60,
  `dedupe_key` text NOT NULL,
  `source_conversation_id` text,
  `source_run_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_used_at` integer,
  `use_count` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_memories_dedupe_unique` ON `user_memories` (`user_id`,`dedupe_key`);
--> statement-breakpoint
CREATE INDEX `user_memories_user_idx` ON `user_memories` (`user_id`,`enabled`,`datasource_id`);
--> statement-breakpoint
CREATE INDEX `user_memories_updated_idx` ON `user_memories` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `user_memory_settings` (
  `user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `enabled` integer NOT NULL DEFAULT 1,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `runs` ADD COLUMN `memory_extracted_at` integer;

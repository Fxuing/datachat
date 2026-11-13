CREATE TABLE `roles` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `builtin` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_name_unique` ON `roles` (`name`);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  `permission` text NOT NULL,
  PRIMARY KEY (`role_id`, `permission`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`user_id`, `role_id`)
);
--> statement-breakpoint
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);
--> statement-breakpoint
CREATE TABLE `role_datasource_grants` (
  `role_id` text NOT NULL REFERENCES `roles`(`id`) ON DELETE CASCADE,
  `datasource_id` text NOT NULL REFERENCES `datasources`(`id`) ON DELETE CASCADE,
  PRIMARY KEY (`role_id`, `datasource_id`)
);
--> statement-breakpoint
CREATE INDEX `role_datasource_grants_datasource_idx` ON `role_datasource_grants` (`datasource_id`);
--> statement-breakpoint
INSERT INTO `roles` (`id`,`name`,`description`,`builtin`,`created_at`,`updated_at`)
VALUES ('role_member','成员','默认角色，拥有全部功能权限',1,1794000000000,1794000000000);
--> statement-breakpoint
INSERT INTO `role_permissions` (`role_id`,`permission`) VALUES
  ('role_member','chat.use'),
  ('role_member','skill.use'),
  ('role_member','mcp.use'),
  ('role_member','report.create'),
  ('role_member','share.create'),
  ('role_member','export.data');
--> statement-breakpoint
INSERT OR IGNORE INTO `user_roles` (`user_id`,`role_id`)
SELECT `id`, 'role_member' FROM `users` WHERE `role` = 'user';

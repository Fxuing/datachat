-- Multiple OpenAI-compatible / Anthropic-compatible model providers. Keys are
-- AES-256-GCM encrypted with APP_SECRET, never returned by the API in clear text.
CREATE TABLE `llm_providers` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `protocol` text NOT NULL,
  `base_url` text NOT NULL,
  `api_key_cipher` text NOT NULL,
  `models_json` text NOT NULL,
  `enabled` integer DEFAULT 1 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_providers_name_unique` ON `llm_providers` (`name`);

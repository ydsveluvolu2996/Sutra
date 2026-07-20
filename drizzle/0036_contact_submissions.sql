CREATE TABLE `contact_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`company` text,
	`message` text NOT NULL,
	`source_ip` text NOT NULL,
	`recipient` text NOT NULL,
	`delivered` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contact_submissions_source_idx` ON `contact_submissions` (`source_ip`,`created_at`);
--> statement-breakpoint
CREATE INDEX `contact_submissions_created_idx` ON `contact_submissions` (`created_at`);

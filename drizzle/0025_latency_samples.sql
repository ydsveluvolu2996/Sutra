CREATE TABLE `latency_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`endpoint_ref` text NOT NULL,
	`kind` text NOT NULL,
	`milliseconds` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `latency_samples_scope_idx` ON `latency_samples` (`org_id`,`customer_id`,`connection_id`,`observed_at`);

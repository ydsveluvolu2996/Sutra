CREATE TABLE `case_routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`priority` integer NOT NULL,
	`match_severity` text,
	`match_customer_id` text,
	`route_assignee` text,
	`route_team` text,
	`route_destination` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `case_routing_rules_scope_idx` ON `case_routing_rules` (`org_id`,`customer_id`,`priority`);

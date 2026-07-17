CREATE TABLE `kubernetes_scan_scanner_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`cluster_id` text NOT NULL,
	`scan_run_id` text NOT NULL,
	`findings_json` text NOT NULL,
	`sboms_json` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`finding_count` integer NOT NULL,
	`sbom_count` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cluster_id`) REFERENCES `kubernetes_clusters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scan_run_id`) REFERENCES `kubernetes_scan_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kubernetes_scan_scanner_evidence_run_uq` ON `kubernetes_scan_scanner_evidence` (`scan_run_id`);--> statement-breakpoint
CREATE INDEX `kubernetes_scan_scanner_evidence_scope_idx` ON `kubernetes_scan_scanner_evidence` (`org_id`,`customer_id`,`cluster_id`,`scan_run_id`);
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_scanner_evidence_no_update` BEFORE UPDATE ON `kubernetes_scan_scanner_evidence`
BEGIN SELECT RAISE(ABORT, 'kubernetes scanner evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `kubernetes_scan_scanner_evidence_no_delete` BEFORE DELETE ON `kubernetes_scan_scanner_evidence`
BEGIN SELECT RAISE(ABORT, 'kubernetes scanner evidence is immutable'); END;

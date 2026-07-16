WITH `ranked_active_runs` AS (
	SELECT `id`, ROW_NUMBER() OVER (
		PARTITION BY `org_id`, `connection_id`
		ORDER BY `created_at` DESC, `id` DESC
	) AS `active_rank`
	FROM `sync_runs`
	WHERE `status` IN ('queued', 'running')
)
UPDATE `sync_runs`
	SET `status` = 'cancelled',
		`coverage_state` = 'unknown',
		`finished_at` = COALESCE(`finished_at`, unixepoch() * 1000)
	WHERE `id` IN (
		SELECT `id` FROM `ranked_active_runs` WHERE `active_rank` > 1
	);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_one_active_connection_uq` ON `sync_runs` (`org_id`,`connection_id`) WHERE "sync_runs"."status" IN ('queued', 'running');

-- Preserve immutable manifest-object coverage for the visible billing
-- generation. Ambiguous failed/staging legacy corrections intentionally remain
-- NULL because file_count describes their replacement manifest.
ALTER TABLE finops_export_partitions
  ADD COLUMN active_file_count integer
  CHECK (active_file_count IS NULL OR active_file_count BETWEEN 1 AND 10000);
--> statement-breakpoint
UPDATE finops_export_partitions
   SET active_file_count = file_count
 WHERE status = 'ready'
   AND active_generation_id IS NOT NULL
   AND active_manifest_sha256 IS NOT NULL
   AND active_committed_at IS NOT NULL
   AND active_manifest_sha256 = manifest_sha256
   AND staging_generation_id IS NULL
   AND staging_manifest_sha256 IS NULL
   AND file_count BETWEEN 1 AND 10000;

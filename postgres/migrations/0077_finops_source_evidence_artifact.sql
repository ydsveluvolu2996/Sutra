ALTER TABLE evidence_objects
  DROP CONSTRAINT IF EXISTS evidence_objects_artifact_kind_check;
--> statement-breakpoint
ALTER TABLE evidence_objects
  ADD CONSTRAINT evidence_objects_artifact_kind_check
  CHECK (artifact_kind IN (
    'aws_snapshot_raw', 'export_json', 'export_csv', 'finops_source_snapshot'
  ));

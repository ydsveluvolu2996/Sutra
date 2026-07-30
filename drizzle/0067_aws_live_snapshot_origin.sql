UPDATE `cmdb_snapshots`
   SET `origin_kind` = 'aws_live'
 WHERE `origin_kind` = 'aws_sandbox';

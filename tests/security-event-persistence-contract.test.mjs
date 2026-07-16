import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../db/security-event-repository.ts", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../app/api/v1/security-events/route.ts", import.meta.url), "utf8");

test("security-event publication hides unfinished multi-batch runs", () => {
  assert.match(source, /'aws_cloudtrail_lookup_events', 'PERSISTING'/u);
  assert.match(source, /SET status = \?, events_inserted = \?, duplicate_events = \?[\s\S]+AND status = 'PERSISTING'/u);
  assert.match(source, /FROM security_event_runs[\s\S]+AND status <> 'PERSISTING'[\s\S]+ORDER BY collected_at DESC/u);
  assert.match(source, /r\.status <> 'PERSISTING'/u);
});

test("retries reclaim evidence stranded by an interrupted persistence run", () => {
  assert.match(source, /SET source_run_id = \?, ingested_at = \?[\s\S]+r\.status = 'PERSISTING'/u);
  assert.match(source, /UPDATE security_event_detections[\s\S]+SET source_run_id = \?, updated_at = \?[\s\S]+r\.status = 'PERSISTING'/u);
});

test("only complete runs advance the durable checkpoint and incomplete attempts remain retryable", () => {
  assert.match(source, /last_window_start = CASE WHEN \? = 'COMPLETE' THEN \? ELSE last_window_start END/u);
  assert.match(source, /last_window_end = CASE WHEN \? = 'COMPLETE' THEN \? ELSE last_window_end END/u);
  assert.match(source, /SELECT status, window_start[\s\S]+status <> 'PERSISTING'[\s\S]+ORDER BY collected_at DESC/u);
  assert.match(source, /CHECKPOINT_GAP_TRUNCATED_TO_24_HOURS/u);
});

test("returns explicit scoped totals separately from limited displayed rows", () => {
  assert.match(source, /SELECT COUNT\(\*\) AS count FROM security_events/u);
  assert.match(source, /SELECT COUNT\(\*\) AS count FROM security_event_detections/u);
  assert.match(source, /totalEvents: countValue\(totalEventRow\)/u);
  assert.match(source, /matchingEvents: countValue\(matchingEventRow\)/u);
  assert.match(source, /openDetections: countValue\(openDetectionRow\)/u);
});

test("final publication and detection mutation commit with their audit records atomically", () => {
  assert.equal((source.match(/await commitAuditedStatements\(\{/gu) ?? []).length, 2);
  assert.doesNotMatch(apiSource, /appendAuditEvent/u);
  assert.match(source, /JOIN security_event_sources s[\s\S]+r\.status = \?[\s\S]+s\.last_run_id = \?/u);
  assert.match(source, /JOIN security_event_runs r[\s\S]+d\.status = \?[\s\S]+d\.updated_at = \?[\s\S]+r\.status <> 'PERSISTING'/u);
  assert.match(source, /updated_at = \? AND status = \?/u);
});

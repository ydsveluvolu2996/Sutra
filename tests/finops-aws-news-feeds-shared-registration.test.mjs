import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../app/api/internal/jobs/run/route.ts", import.meta.url);
const handlerPath = new URL("../db/background-job-handlers.ts", import.meta.url);

test("internal drain schedules AWS News Feeds before running registered handlers and returns its result", async () => {
  const [route, handlers] = await Promise.all([
    readFile(routePath, "utf8"),
    readFile(handlerPath, "utf8"),
  ]);

  assert.match(route, /scheduleAwsNewsFeedsTick,/u);
  const scheduleCall = route.indexOf("const awsNewsFeeds = await scheduleAwsNewsFeedsTick();");
  const drainCall = route.indexOf("const result = await runDueBackgroundJobs(");
  assert.notEqual(scheduleCall, -1);
  assert.notEqual(drainCall, -1);
  assert.ok(scheduleCall < drainCall, "the system tick must enqueue the job before the shared drain runs");
  assert.match(route, /platformUptime,\s*awsNewsFeeds/u);

  assert.match(
    handlers,
    /\[AWS_NEWS_FEEDS_JOB_KIND\]: \(job\) =>\s*awsNewsFeedsProductionComposition\(\)\.handler\(job\)/u,
  );
  assert.match(handlers, /export function scheduleAwsNewsFeedsTick/u);
});

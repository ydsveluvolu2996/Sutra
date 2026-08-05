import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = process.cwd();
const { buildJobHandlers } = await import("../db/background-job-handlers.ts");
const { AWS_BUDGETS_DURABLE_JOB_KIND } = await import(
  "../lib/finops-aws-budgets-durable-binding.ts"
);

test("shared runner exposes the ADV-08 durable handler", () => {
  const handlers = buildJobHandlers();
  assert.equal(typeof handlers[AWS_BUDGETS_DURABLE_JOB_KIND], "function");
});

test("internal tick schedules ADV-08 and reports its result", async () => {
  const source = await readFile(
    path.join(root, "app/api/internal/jobs/run/route.ts"),
    "utf8",
  );
  assert.match(source, /const awsBudgets = await scheduleAwsBudgetsTick\(\)/u);
  assert.match(source, /awsBudgets,/u);
});

test("registered API truth and collector route stay linked", async () => {
  const [api, collector] = await Promise.all([
    readFile(path.join(root, "app/api/v1/finops/aws-budgets-organization/route.ts"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/local-server.ts"), "utf8"),
  ]);
  assert.match(api, /sharedRuntimeRegistered: true/u);
  assert.match(api, /AWS_BUDGETS_SIGNED_BROKER_HANDLER_REGISTERED/u);
  assert.match(collector, /AWS_BUDGETS_PROVIDER_ROUTE/u);
  assert.match(collector, /assumeValidatedAwsBudgetsSession/u);
});

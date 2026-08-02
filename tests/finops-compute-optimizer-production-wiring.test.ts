import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production registers launch, discovery, reconcile, and materializer handlers", async () => {
  const source = await readFile(new URL("../db/background-job-handlers.ts", import.meta.url), "utf8");
  for (const kind of [
    "FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_LAUNCH_JOB_KIND",
    "FINOPS_COMPUTE_OPTIMIZER_DISCOVERY_JOB_KIND",
    "FINOPS_COMPUTE_OPTIMIZER_ACTIVATION_RECONCILE_JOB_KIND",
    "FINOPS_COMPUTE_OPTIMIZER_MATERIALIZE_JOB_KIND",
  ]) assert.match(source, new RegExp(`\\[${kind}\\]: async \\(job\\)`));
  assert.match(source, /resolveComputeOptimizerMaterializationConnection/u);
  assert.match(source, /getCurrentCapability/u);
  assert.doesNotMatch(source, /permissionPackVersion\s*:\s*"standard-2026-08\.5"[\s\S]{0,200}(?:update|markConnection)/u);
});

test("internal jobs tick preserves schedule then recovery then outbox before queue drain", async () => {
  const source = await readFile(new URL("../app/api/internal/jobs/run/route.ts", import.meta.url), "utf8");
  const schedule = source.indexOf("await scheduleComputeOptimizerDailyTick");
  const recovery = source.indexOf("await recoverComputeOptimizerActivationTick");
  const outbox = source.indexOf("await dispatchComputeOptimizerOutboxTick");
  const drain = source.indexOf("await runDueBackgroundJobs");
  assert.ok(schedule >= 0 && schedule < recovery && recovery < outbox && outbox < drain);
  assert.match(source, /const computeOptimizerBoundary = createComputeOptimizerActivationBoundary\(\)/u);
  assert.equal((source.match(/computeOptimizerBoundary/g) ?? []).length, 4);
});

test("authorized POST is the production recordCapability caller and never updates generic permission pack", async () => {
  const route = await readFile(new URL("../app/api/v1/finops/compute-optimizer/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const POST = createComputeOptimizerCapabilityPostHandler/u);
  assert.match(route, /assertSessionCapability\(auth, "connection:manage", customerId\)/u);
  assert.match(route, /runComputeOptimizerMaterializationActivationManifest/u);
  assert.match(route, /activationRepository\.recordCapability/u);
  assert.doesNotMatch(route, /markConnection|updateConnection|permissionPackVersion\s*=/u);
});

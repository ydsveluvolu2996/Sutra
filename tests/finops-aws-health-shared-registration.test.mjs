import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = process.cwd();
const { buildJobHandlers } = await import("../db/background-job-handlers.ts");
const { AWS_HEALTH_RUNTIME_JOB_KIND } = await import(
  "../lib/finops-aws-health-runtime-binding.ts"
);

test("shared runner exposes the ADV-06 durable handler", () => {
  const handlers = buildJobHandlers();
  assert.equal(typeof handlers[AWS_HEALTH_RUNTIME_JOB_KIND], "function");
});

test("internal tick schedules ADV-06 and reports its result", async () => {
  const source = await readFile(
    path.join(root, "app/api/internal/jobs/run/route.ts"), "utf8",
  );
  assert.match(source, /const awsHealth = await scheduleAwsHealthTick\(\)/u);
  assert.match(source, /awsHealth,/u);
});

test("registered API truth, SDK reader, exact session and collector route stay linked", async () => {
  const [api, collector, broker] = await Promise.all([
    readFile(path.join(root, "app/api/v1/finops/health-events/route.ts"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/local-server.ts"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/role-broker.ts"), "utf8"),
  ]);
  assert.match(api,
    /AWS_HEALTH_PRODUCTION_COMPOSITION_STATUS\.sharedWorkerRegistered\s*\?/u);
  assert.match(collector, /AWS_HEALTH_PROVIDER_ROUTE/u);
  assert.match(collector, /assumeValidatedAwsHealthSession/u);
  assert.match(collector, /createAwsHealthSdkReader/u);
  assert.match(broker, /awsHealthSessionPolicy/u);
  assert.match(broker, /AWS_HEALTH_PERMISSION_PACK_VERSION/u);
});

test("both runtime migrators and postgres CLI register the durable ledger", async () => {
  const [sqlite, postgres, cli] = await Promise.all([
    readFile(path.join(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);
  assert.match(sqlite, /0119_finops_aws_health_runtime\.sql/u);
  assert.match(postgres, /0115_finops_aws_health_runtime\.sql/u);
  assert.match(cli, /0115_finops_aws_health_runtime\.sql/u);
});

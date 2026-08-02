import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const root = process.cwd();
const { buildJobHandlers } = await import("../db/background-job-handlers.ts");
const { EXTENDED_SUPPORT_RUNTIME_JOB_KIND } = await import(
  "../lib/finops-extended-support-runtime-binding.ts"
);

test("shared runner exposes the ADV-04 durable handler", () => {
  const handlers = buildJobHandlers();
  assert.equal(typeof handlers[EXTENDED_SUPPORT_RUNTIME_JOB_KIND], "function");
});

test("internal tick schedules ADV-04 and reports its result", async () => {
  const source = await readFile(
    path.join(root, "app/api/internal/jobs/run/route.ts"), "utf8",
  );
  assert.match(source, /const extendedSupport = await scheduleExtendedSupportTick\(\)/u);
  assert.match(source, /extendedSupport,/u);
});

test("registered API truth, exact role path, and collector route stay linked", async () => {
  const [api, collector, broker] = await Promise.all([
    readFile(path.join(root,
      "app/api/v1/finops/extended-support-projection/route.ts"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/local-server.ts"), "utf8"),
    readFile(path.join(root, "services/aws-collector/src/role-broker.ts"), "utf8"),
  ]);
  assert.match(api,
    /sharedRuntimeRegistered:\s*EXTENDED_SUPPORT_PRODUCTION_COMPOSITION_STATUS\.sharedWorkerRegistered/u);
  assert.match(collector, /EXTENDED_SUPPORT_PROVIDER_ROUTE/u);
  assert.match(collector, /assumeValidatedExtendedSupportSession/u);
  assert.match(collector, /createExtendedSupportAwsSdkReader/u);
  assert.match(broker, /extendedSupportProviderSessionPolicy/u);
  assert.match(broker, /EXTENDED_SUPPORT_PERMISSION_PACK_VERSION/u);
});

test("both runtime migrators and the postgres CLI register the durable ledger", async () => {
  const [sqlite, postgres, cli] = await Promise.all([
    readFile(path.join(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);
  assert.match(sqlite, /0118_finops_extended_support_runtime\.sql/u);
  assert.match(postgres, /0114_finops_extended_support_runtime\.sql/u);
  assert.match(cli, /0114_finops_extended_support_runtime\.sql/u);
});

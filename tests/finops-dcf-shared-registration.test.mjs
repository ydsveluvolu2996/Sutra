import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("immutable .8.10 template preserves .8.9 and adds only exact DCF reads", async () => {
  const [predecessor, successor] = await Promise.all([
    read("infrastructure/customer-onboarding-role-standard-2026-08.9.yaml"),
    read("infrastructure/customer-onboarding-role-standard-2026-08.10.yaml"),
  ]);
  assert.equal(
    createHash("sha256").update(predecessor).digest("hex"),
    "40969aa57b7b56cf54df5891d4f74325af4e4c09ae1b5a0abac9215af64db291",
  );
  for (const token of [
    "standard-2026-08.10",
    "SutraFinopsDcfStepFunctionsReadV1",
    "DcfStateMachineArns",
    "DcfExecutionArnPatterns",
    "states:DescribeStateMachine",
    "states:ListExecutions",
    "states:DescribeExecution",
    "ReadExactDcfStateMachines",
    "ReadExactDcfExecutions",
  ]) assert.match(successor, new RegExp(token, "u"));
  for (const prohibited of ["states:StartExecution", "states:StopExecution", "states:DeleteStateMachine"])
    assert.equal(successor.includes(prohibited), false);
});

test("SFN dependency, pack registry, broker route, and hosted defaults are registered", async () => {
  const [packageJson, lock, types, registry, broker, server] = await Promise.all([
    read("services/aws-collector/package.json"),
    read("pnpm-lock.yaml"),
    read("services/aws-collector/src/types.ts"),
    read("services/aws-collector/src/local-registry.ts"),
    read("services/aws-collector/src/role-broker.ts"),
    read("services/aws-collector/src/local-server.ts"),
  ]);
  assert.equal(JSON.parse(packageJson).dependencies["@aws-sdk/client-sfn"], "3.1087.0");
  assert.match(lock, /'@aws-sdk\/client-sfn':\n\s+specifier: 3\.1087\.0\n\s+version: 3\.1087\.0/u);
  assert.match(types, /DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION =\s+"standard-2026-08\.10"/u);
  assert.match(registry, /DCF_STEP_FUNCTIONS_PERMISSION_PACK_VERSION/u);
  assert.match(broker, /assumeValidatedDcfStepFunctionsSession/u);
  assert.match(broker, /assertDcfStepFunctionsPolicy/u);
  assert.match(server, /DCF_STEP_FUNCTIONS_PROVIDER_ROUTE/u);
  assert.match(server, /createDcfStepFunctionsSdkReader/u);
  assert.match(server, /dcfStepFunctionsRoleBrokerFactory/u);
  assert.match(server, /DCF_STEP_FUNCTIONS_BODY_LIMIT = 1_048_576/u);
  assert.match(server, /DCF_STEP_FUNCTIONS_RESPONSE_LIMIT = 65 \* 1024 \* 1024/u);
});

test("D1/PostgreSQL migrations and shared hourly runtime are registered", async () => {
  const [d1, postgres, migrator, handlers, tick, binding] = await Promise.all([
    read("db/runtime-migrations.ts"),
    read("db/postgres-runtime-migrations.ts"),
    read("scripts/postgres-migrate.mjs"),
    read("db/background-job-handlers.ts"),
    read("app/api/internal/jobs/run/route.ts"),
    read("lib/finops-dcf-durable-runtime-binding.ts"),
  ]);
  assert.match(d1, /0121_finops_dcf_runtime/u);
  assert.match(postgres, /0117_finops_dcf_runtime/u);
  assert.match(migrator, /0117_finops_dcf_runtime\.sql/u);
  assert.match(handlers, /\[DCF_STEP_FUNCTIONS_RUNTIME_JOB_KIND\]/u);
  assert.match(handlers, /scheduleDcfStepFunctionsTick/u);
  assert.match(tick, /const dataCollectionMonitor = await scheduleDcfStepFunctionsTick\(\)/u);
  assert.match(tick, /dataCollectionMonitor,/u);
  assert.match(binding, /registeredInSharedRuntime: true/u);
  assert.match(binding, /DCF_STEP_FUNCTIONS_DURABLE_RUNTIME_REGISTERED/u);
});

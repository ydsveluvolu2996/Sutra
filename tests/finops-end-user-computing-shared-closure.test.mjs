import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const ACTIONS = [
  "appstream:DescribeFleets", "appstream:DescribeSessions", "appstream:DescribeStacks",
  "appstream:ListAssociatedFleets", "cloudwatch:GetMetricData",
  "workspaces:DescribeWorkspaceBundles", "workspaces:DescribeWorkspaces",
  "workspaces:DescribeWorkspacesConnectionStatus",
];

test(".8.11 is immutable, additive, exact, and preserves committed .8.10 bytes", async () => {
  const [prior, successor] = await Promise.all([
    read("infrastructure/customer-onboarding-role-standard-2026-08.10.yaml"),
    read("infrastructure/customer-onboarding-role-standard-2026-08.11.yaml"),
  ]);
  assert.equal(createHash("sha256").update(prior).digest("hex"),
    "2b0b8584b96aa9d1b9fd667f89cf335787c11c82f157fdfdda0371f77c67bf4e");
  assert.match(successor, /Version: standard-2026-08\.11/u);
  assert.match(successor, /It preserves every standard-2026-08\.10 capability/u);
  const policy = successor.slice(successor.indexOf("PolicyName: SutraFinopsEndUserComputingReadV1"),
    successor.indexOf("      Tags:", successor.indexOf("PolicyName: SutraFinopsEndUserComputingReadV1")));
  const granted = [...policy.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z0-9]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(granted, ACTIONS);
});

test(".8.11 shared runtime has pinned SDK, broker, hosted CUR2, worker and tick hooks", async () => {
  const [pkg, reader, broker, local, hosted, state, handlers, tick, binding, successors] = await Promise.all([
    read("services/aws-collector/package.json"), read("services/aws-collector/src/end-user-computing-sdk-reader.ts"),
    read("services/aws-collector/src/role-broker.ts"), read("services/aws-collector/src/local-server.ts"),
    read("services/aws-collector/src/hosted-server.ts"), read("services/aws-collector/src/hosted-postgres-state.ts"),
    read("db/background-job-handlers.ts"), read("app/api/internal/jobs/run/route.ts"),
    read("lib/finops-end-user-computing-runtime-binding.ts"), read("lib/finops-permission-pack-successors.ts"),
  ]);
  assert.match(pkg, /"@aws-sdk\/client-appstream": "3\.1087\.0"/u);
  assert.match(pkg, /"@aws-sdk\/client-workspaces": "3\.1087\.0"/u);
  for (const command of ["DescribeFleetsCommand", "DescribeSessionsCommand", "DescribeStacksCommand",
    "ListAssociatedFleetsCommand", "GetMetricDataCommand", "DescribeWorkspaceBundlesCommand",
    "DescribeWorkspacesCommand", "DescribeWorkspacesConnectionStatusCommand"]) assert.match(reader, new RegExp(command, "u"));
  assert.match(broker, /assumeValidatedEndUserComputingSession/u);
  assert.match(local, /END_USER_COMPUTING_PROVIDER_ROUTE/u);
  assert.match(hosted, /endUserComputingCostProjectionLoader/u);
  assert.match(state, /loadEndUserComputingCostProjection/u);
  assert.match(handlers, /END_USER_COMPUTING_DURABLE_JOB_KIND/u);
  assert.match(handlers, /scheduleEndUserComputingTick/u);
  assert.match(tick, /endUserComputing/u);
  assert.match(binding, /registeredInSharedRuntime: true/u);
  assert.match(successors, /"standard-2026-08\.11"/u);
});

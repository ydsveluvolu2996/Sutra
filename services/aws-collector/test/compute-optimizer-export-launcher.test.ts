import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY,
  ComputeOptimizerExportLauncherError,
  runComputeOptimizerExportLaunch,
  type ComputeOptimizerExportLaunchClient,
} from "../src/compute-optimizer-export-launcher.js";

const NOW = new Date("2026-08-02T12:00:01.000Z");
const REGION = "ap-south-1";
const ACCOUNT = "111122223333";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function attempt() {
  const scope = {
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: `conn_${"a".repeat(32)}`,
  };
  const families = Object.keys(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY)
    .sort() as Array<keyof typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY>;
  const targets = families.map((exportFamily) => {
    const operation = COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY[exportFamily];
    const request = {
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION[exportFamily]],
      s3DestinationConfig: {
        bucket: "sutra-compute-optimizer-ap-south-1",
        keyPrefix: "organization/history" as string | null,
      },
    };
    const requestSha256 = sha256(canonicalJson({ operation, region: REGION, ...request }));
    return {
      targetId: `coelt_${sha256(canonicalJson({
        exportFamily,
        operation,
        region: REGION,
        requestSha256,
      }))}`,
      exportFamily,
      operation,
      region: REGION,
      bucket: request.s3DestinationConfig.bucket,
      optionalPrefix: request.s3DestinationConfig.keyPrefix,
      effectivePrefix: `organization/history/compute-optimizer/${ACCOUNT}/`,
      request,
      requestSha256,
    };
  });
  const provisional = {
    schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1" as const,
    requestBatchId: "",
    launchAttemptId: "",
    contentSha256: "",
    scope,
    requesterAccountId: ACCOUNT,
    partition: "aws" as const,
    region: REGION,
    scheduledWindow: "2026-08-02T00:00:00.000Z",
    sealedAtIso: "2026-08-02T12:00:00.000Z",
    attemptNumber: 1,
    targets,
  };
  const batchBody = {
    schemaVersion: provisional.schemaVersion,
    scope,
    requesterAccountId: ACCOUNT,
    partition: provisional.partition,
    region: REGION,
    scheduledWindow: provisional.scheduledWindow,
    targets,
  };
  const requestBatchId = `coelb_${sha256(canonicalJson(batchBody))}`;
  const contentBody = {
    schemaVersion: provisional.schemaVersion,
    requestBatchId,
    scope,
    requesterAccountId: ACCOUNT,
    partition: provisional.partition,
    region: REGION,
    scheduledWindow: provisional.scheduledWindow,
    sealedAtIso: provisional.sealedAtIso,
    attemptNumber: 1,
    targets,
  };
  const contentSha256 = sha256(canonicalJson(contentBody));
  return {
    ...provisional,
    requestBatchId,
    launchAttemptId: `coela_${contentSha256}`,
    contentSha256,
  };
}

function successResponse(target: ReturnType<typeof attempt>["targets"][number], index: number) {
  const jobId = `job-${index + 1}`;
  const key = `${target.effectivePrefix}${target.region}-2026-08-02T120000Z-${jobId}.csv`;
  return {
    jobId,
    s3Destination: {
      bucket: target.bucket,
      key,
      metadataKey: `${key.slice(0, -4)}-metadata.json`,
    },
  };
}

test("dispatches all eight exact SDK commands sequentially without narrowing inputs", async () => {
  const sealed = attempt();
  const commands: unknown[] = [];
  let active = 0;
  let maximumActive = 0;
  const client: ComputeOptimizerExportLaunchClient = {
    async send(command) {
      const index = commands.length;
      commands.push(command);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return successResponse(sealed.targets[index]!, index);
    },
  };
  const result = await runComputeOptimizerExportLaunch({
    attempt: sealed,
    client,
    now: () => NOW,
  });
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.outcomes.length, 8);
  assert.equal(maximumActive, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.outcomes), true);
  assert.deepEqual(commands.map((command) => (command as object).constructor.name), [
    "ExportAutoScalingGroupRecommendationsCommand",
    "ExportEBSVolumeRecommendationsCommand",
    "ExportEC2InstanceRecommendationsCommand",
    "ExportECSServiceRecommendationsCommand",
    "ExportIdleRecommendationsCommand",
    "ExportLambdaFunctionRecommendationsCommand",
    "ExportLicenseRecommendationsCommand",
    "ExportRDSDatabaseRecommendationsCommand",
  ]);
  commands.forEach((command, index) => {
    const commandInput = (command as unknown as { input: Record<string, unknown> }).input;
    assert.deepEqual(commandInput.fieldsToExport, sealed.targets[index]!.request.fieldsToExport);
    assert.equal(commandInput.fileFormat, "Csv");
    assert.equal(commandInput.includeMemberAccounts, true);
    assert.deepEqual(commandInput.s3DestinationConfig, {
      bucket: sealed.targets[index]!.bucket,
      keyPrefix: "organization/history",
    });
    assert.equal("filters" in commandInput, false);
    assert.equal("accountIds" in commandInput, false);
    assert.equal("recommendationPreferences" in commandInput, false);
    assert.equal("resourceType" in commandInput, false);
  });
  assert.doesNotMatch(canonicalJson(result), /accessKey|secret|sessionToken|credentials/iu);
});

test("omits keyPrefix rather than sending a null provider property", async () => {
  const sealed = attempt();
  for (const target of sealed.targets) {
    target.optionalPrefix = null;
    target.effectivePrefix = `compute-optimizer/${ACCOUNT}/`;
    target.request.s3DestinationConfig.keyPrefix = null;
    target.requestSha256 = sha256(canonicalJson({
      operation: target.operation,
      region: target.region,
      ...target.request,
    }));
    target.targetId = `coelt_${sha256(canonicalJson({
      exportFamily: target.exportFamily,
      operation: target.operation,
      region: target.region,
      requestSha256: target.requestSha256,
    }))}`;
  }
  const rebuilt = rebuildIds(sealed);
  const inputs: Array<Record<string, unknown>> = [];
  await runComputeOptimizerExportLaunch({
    attempt: rebuilt,
    client: {
      async send(command) {
        const index = inputs.length;
        inputs.push((command as unknown as { input: Record<string, unknown> }).input);
        return successResponse(rebuilt.targets[index]!, index);
      },
    },
    now: () => NOW,
  });
  assert.equal(inputs.every((value) =>
    !Object.hasOwn(value.s3DestinationConfig as object, "keyPrefix")), true);
});

function rebuildIds(value: ReturnType<typeof attempt>): ReturnType<typeof attempt> {
  const requestBatchId = `coelb_${sha256(canonicalJson({
    schemaVersion: value.schemaVersion,
    scope: value.scope,
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    region: value.region,
    scheduledWindow: value.scheduledWindow,
    targets: value.targets,
  }))}`;
  const contentSha256 = sha256(canonicalJson({
    schemaVersion: value.schemaVersion,
    requestBatchId,
    scope: value.scope,
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    region: value.region,
    scheduledWindow: value.scheduledWindow,
    sealedAtIso: value.sealedAtIso,
    attemptNumber: value.attemptNumber,
    targets: value.targets,
  }));
  return { ...value, requestBatchId, launchAttemptId: `coela_${contentSha256}`, contentSha256 };
}

test("fails closed on malformed or substituted provider responses", async () => {
  for (const response of [
    {},
    { jobId: "bad/id", s3Destination: {} },
    { jobId: "job-1", s3Destination: { bucket: "attacker", key: "x", metadataKey: "y" } },
    { jobId: "job-1", s3Destination: {
      bucket: "sutra-compute-optimizer-ap-south-1",
      key: "outside/ap-south-1-date-job-1.csv",
      metadataKey: "outside/ap-south-1-date-job-1-metadata.json",
    } },
  ]) {
    let calls = 0;
    const result = await runComputeOptimizerExportLaunch({
      attempt: attempt(),
      client: { async send() { calls += 1; return response; } },
      now: () => NOW,
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.outcomes[0]?.status, "FAILED");
    assert.equal(result.outcomes[0]?.errorCode, "INVALID_PROVIDER_RESPONSE");
    assert.equal(result.outcomes.slice(1).every(({ status }) => status === "NOT_ATTEMPTED"), true);
  }
});

test("sanitizes provider failures and fail-stops the ambiguous attempt", async () => {
  for (const [name, expected] of [
    ["AccessDeniedException", "ACCESS_DENIED"],
    ["LimitExceededException", "CONCURRENT_EXPORT_LIMIT"],
    ["OptInRequiredException", "ENROLLMENT_REQUIRED"],
    ["ThrottlingException", "RATE_LIMITED"],
    ["ServiceUnavailableException", "SERVICE_UNAVAILABLE"],
    ["PrivateFailure", "PROVIDER_REQUEST_FAILED"],
  ] as const) {
    let calls = 0;
    const result = await runComputeOptimizerExportLaunch({
      attempt: attempt(),
      client: {
        async send() {
          calls += 1;
          throw Object.assign(new Error("private role, account and bucket"), { name });
        },
      },
      now: () => NOW,
    });
    assert.equal(calls, 1);
    assert.equal(result.outcomes[0]?.errorCode, expected);
    assert.equal(canonicalJson(result).includes("private role"), false);
  }
});

test("enforces a hard per-command deadline when a client ignores AbortSignal", async () => {
  let calls = 0;
  const started = Date.now();
  const result = await runComputeOptimizerExportLaunch({
    attempt: attempt(),
    client: {
      async send() {
        calls += 1;
        return await new Promise<never>(() => undefined);
      },
    },
    now: () => NOW,
    commandDeadlineMs: 10,
    overallDeadlineMs: 1_000,
  });
  assert.equal(calls, 1);
  assert.equal(result.outcomes[0]?.errorCode, "DEADLINE_EXCEEDED");
  assert.ok(Date.now() - started < 500);
});

test("enforces the hard overall deadline and external abort independently", async () => {
  const neverClient: ComputeOptimizerExportLaunchClient = {
    async send() { return await new Promise<never>(() => undefined); },
  };
  const overall = await runComputeOptimizerExportLaunch({
    attempt: attempt(),
    client: neverClient,
    now: () => NOW,
    commandDeadlineMs: 1_000,
    overallDeadlineMs: 10,
  });
  assert.equal(overall.outcomes[0]?.errorCode, "DEADLINE_EXCEEDED");

  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("private abort")), 10);
  const aborted = await runComputeOptimizerExportLaunch({
    attempt: attempt(),
    client: neverClient,
    now: () => NOW,
    commandDeadlineMs: 1_000,
    overallDeadlineMs: 1_000,
    abortSignal: controller.signal,
  });
  assert.equal(aborted.outcomes[0]?.errorCode, "ABORTED");
  assert.equal(canonicalJson(aborted).includes("private abort"), false);
});

test("rejects non-daily windows, partition mismatches, tampering, and target bounds before calls", async () => {
  for (const mutate of [
    (value: ReturnType<typeof attempt>) => { value.scheduledWindow = "2026-08-02T01:00:00.000Z"; },
    (value: ReturnType<typeof attempt>) => { value.partition = "aws-cn" as "aws"; },
    (value: ReturnType<typeof attempt>) => { value.targets.pop(); },
    (value: ReturnType<typeof attempt>) => {
      (value.targets[0]!.request.fieldsToExport as unknown as string[]).push("UnknownField");
    },
    (value: ReturnType<typeof attempt>) => { value.targets[0]!.bucket = "attacker-bucket"; },
  ]) {
    const changed = attempt();
    mutate(changed);
    let calls = 0;
    await assert.rejects(
      runComputeOptimizerExportLaunch({
        attempt: changed,
        client: { async send() { calls += 1; return {}; } },
        now: () => NOW,
      }),
      (error: unknown) => error instanceof ComputeOptimizerExportLauncherError,
    );
    assert.equal(calls, 0);
  }
});

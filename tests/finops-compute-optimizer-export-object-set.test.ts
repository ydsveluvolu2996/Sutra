import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS,
  ComputeOptimizerExportObjectSetError,
  loadComputeOptimizerExportObjectSet,
  type ComputeOptimizerExportObjectRead,
  type ComputeOptimizerExportObjectReader,
} from "../lib/finops-compute-optimizer-export-object-set.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerProviderExportJobResourceType,
  VerifiedComputeOptimizerExportJobBinding,
} from "../lib/finops-compute-optimizer-export-plan.ts";

const encoder = new TextEncoder();
const PLAN_ID = `cope_${"a".repeat(64)}`;
const CONTENT_SHA = "b".repeat(64);

const FAMILY_PROVIDER: Readonly<Record<
  ComputeOptimizerExportFamily,
  ComputeOptimizerProviderExportJobResourceType
>> = {
  EC2_INSTANCE: "Ec2Instance",
  AUTO_SCALING_GROUP: "AutoScalingGroup",
  EBS_VOLUME: "EbsVolume",
  LAMBDA_FUNCTION: "LambdaFunction",
  ECS_SERVICE: "EcsService",
  LICENSE: "License",
  RDS_DATABASE: "RdsDBInstance",
  IDLE_RESOURCE: "Idle",
};

const TARGETS = [
  ["us-east-1", "RDS_DATABASE"],
  ["ap-south-1", "IDLE_RESOURCE"],
  ["us-east-1", "EC2_INSTANCE"],
] as const satisfies readonly (readonly [string, ComputeOptimizerExportFamily])[];

function target(region: string, exportFamily: ComputeOptimizerExportFamily, index: number) {
  const jobId = `job-${index}-${exportFamily.toLowerCase().replaceAll("_", "-")}`;
  const prefix = `compute-optimizer/111122223333/`;
  const objectKey = `${prefix}${region}-2026-08-02T000000Z-${jobId}.csv`;
  return {
    region,
    exportFamily,
    providerResourceType: FAMILY_PROVIDER[exportFamily],
    requestSha256: String(index + 1).repeat(64).slice(0, 64),
    jobId,
    bucket: `sutra-${region}`,
    objectKey,
    metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
  };
}

function binding(
  definitions: readonly (readonly [string, ComputeOptimizerExportFamily])[] = TARGETS,
): VerifiedComputeOptimizerExportJobBinding {
  return {
    planId: PLAN_ID,
    contentSha256: CONTENT_SHA,
    targets: definitions.map(([region, family], index) => target(region, family, index)),
  };
}

function metadata(csvBasename: string): Uint8Array {
  return encoder.encode(JSON.stringify({
    "@context": ["http://www.w3.org/ns/csvw"],
    url: csvBasename,
    "dc:title": "Compute Optimizer Recommendations",
    dialect: {
      encoding: "utf-8",
      lineTerminators: ["\n"],
      doubleQuote: true,
      skipRows: 0,
      header: true,
      headerRowCount: 1,
      delimiter: ",",
      skipColumns: 0,
      skipBlankRows: false,
      trim: false,
    },
    tableSchema: {
      columns: [
        { name: "recommendations_count", titles: "Count", datatype: "integer", required: true },
        { name: "errorCode", titles: "Error Code", datatype: "string", required: true },
        { name: "errorMessage", titles: "Error Message", datatype: "string", required: true },
      ],
    },
  }));
}

const csvBytes = encoder.encode("recommendations_count,errorCode,errorMessage\n1,,");

function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function fixtures(value = binding()): Map<string, Uint8Array> {
  const result = new Map<string, Uint8Array>();
  for (const planned of value.targets) {
    result.set(planned.objectKey, csvBytes);
    result.set(planned.metadataKey, metadata(basename(planned.objectKey)));
  }
  return result;
}

function readerFor(
  objects: ReadonlyMap<string, Uint8Array>,
  calls: Array<{ region: string; bucket: string; key: string; maximumBytes: number }> = [],
): ComputeOptimizerExportObjectReader {
  return async (region, bucket, key, maximumBytes) => {
    calls.push({ region, bucket, key, maximumBytes });
    const value = objects.get(key);
    if (value === undefined) throw new Error("provider detail must not escape");
    return {
      bytes: value.slice(),
      eTag: `etag-${createHash("sha256").update(key).digest("hex")}`,
      versionId: `version-${createHash("sha256").update(`${bucket}/${key}`).digest("hex")}`,
    };
  };
}

async function rejects(
  promise: Promise<unknown>,
  code: ComputeOptimizerExportObjectSetError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ComputeOptimizerExportObjectSetError
      && error.code === code
      && error.message === "Compute Optimizer export object set rejected",
  );
}

test("reads only the bound CSV and metadata addresses and returns canonical frozen bundles", async () => {
  const value = binding();
  const calls: Array<{ region: string; bucket: string; key: string; maximumBytes: number }> = [];
  const loaded = await loadComputeOptimizerExportObjectSet(
    value,
    readerFor(fixtures(value), calls),
  );

  assert.equal(calls.length, value.targets.length * 2);
  assert.deepEqual(
    new Set(calls.map((call) => `${call.region}/${call.bucket}/${call.key}`)),
    new Set(value.targets.flatMap((planned) => [
      `${planned.region}/${planned.bucket}/${planned.objectKey}`,
      `${planned.region}/${planned.bucket}/${planned.metadataKey}`,
    ])),
  );
  for (const call of calls) {
    assert.equal(
      call.maximumBytes,
      call.key.endsWith("-metadata.json")
        ? COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumMetadataBytes
        : COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumCsvBytes,
    );
  }
  assert.deepEqual(
    loaded.targets.map((entry) => [entry.region, entry.exportFamily]),
    [
      ["ap-south-1", "IDLE_RESOURCE"],
      ["us-east-1", "EC2_INSTANCE"],
      ["us-east-1", "RDS_DATABASE"],
    ],
  );
  assert.equal(loaded.targets.every((entry) => entry.parsed.rowCount === 1), true);
  assert.equal(loaded.aggregateBytes, calls.reduce((sum, call) =>
    sum + fixtures(value).get(call.key)!.byteLength, 0));
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.targets), true);
  assert.equal(Object.isFrozen(loaded.targets[0]?.parsed.rows), true);
});

test("accepts the AWS-documented no-Z createdTimestamp export object set", async () => {
  const base = binding([["us-west-2", "EC2_INSTANCE"]]);
  const jobId = "3e496c549301c8a4dfcsdX";
  const objectKey = `ec2-instance-recommendations/compute-optimizer/111122223333/us-west-2-2020-03-03T133027-${jobId}.csv`;
  const documented: VerifiedComputeOptimizerExportJobBinding = {
    ...base,
    targets: [{
      ...base.targets[0]!,
      jobId,
      bucket: "compute-optimizer-exports",
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    }],
  };

  const loaded = await loadComputeOptimizerExportObjectSet(
    documented,
    readerFor(fixtures(documented)),
  );
  assert.equal(loaded.targets[0]?.csvObject.key, objectKey);
});

test("supports current GetObject reads and version-pinned GetObjectVersion reads", async () => {
  const value = binding([["us-east-1", "EC2_INSTANCE"]]);
  const objects = fixtures(value);
  const reader: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: objects.get(key)!.slice(),
    eTag: `etag-${key}`,
    versionId: key.endsWith(".csv") ? null : `version-${key}`,
  });

  const loaded = await loadComputeOptimizerExportObjectSet(value, reader);
  assert.equal(loaded.targets[0]?.csvObject.versionId, null);
  assert.equal(loaded.targets[0]?.metadataObject.versionId, `version-${value.targets[0]!.metadataKey}`);
});

test("bounds active object reads at four or the stricter configured concurrency", async () => {
  const definitions = [
    ["ap-south-1", "EC2_INSTANCE"],
    ["ap-south-1", "IDLE_RESOURCE"],
    ["eu-west-1", "EC2_INSTANCE"],
    ["eu-west-1", "IDLE_RESOURCE"],
    ["us-east-1", "EC2_INSTANCE"],
    ["us-east-1", "IDLE_RESOURCE"],
  ] as const satisfies readonly (readonly [string, ComputeOptimizerExportFamily])[];
  const value = binding(definitions);
  const objects = fixtures(value);
  let active = 0;
  let maximumActive = 0;
  const reader: ComputeOptimizerExportObjectReader = async (_region, bucket, key) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    const value = objects.get(key)!;
    return { bytes: value.slice(), eTag: `etag-${key}`, versionId: `version-${bucket}-${key}` };
  };
  await loadComputeOptimizerExportObjectSet(value, reader, {
    limits: { maximumConcurrency: 3 },
  });
  assert.equal(maximumActive, 3);
  assert.ok(maximumActive <= COMPUTE_OPTIMIZER_EXPORT_OBJECT_SET_BOUNDS.maximumConcurrency);
});

test("fails closed on empty, duplicate, malformed, missing, extra and substituted addresses", async () => {
  await rejects(
    loadComputeOptimizerExportObjectSet(
      { ...binding(), targets: [] },
      readerFor(new Map()),
    ),
    "ADDRESS_SET_MISMATCH",
  );

  const duplicate = binding();
  await rejects(
    loadComputeOptimizerExportObjectSet(
      { ...duplicate, targets: [duplicate.targets[0]!, duplicate.targets[0]!] },
      readerFor(fixtures(duplicate)),
    ),
    "ADDRESS_SET_MISMATCH",
  );

  const malformed = structuredClone(binding()) as unknown as {
    planId: string;
    contentSha256: string;
    targets: Array<Record<string, unknown>>;
  };
  malformed.targets[0]!.extraAddress = "attacker";
  await rejects(
    loadComputeOptimizerExportObjectSet(
      malformed as unknown as VerifiedComputeOptimizerExportJobBinding,
      readerFor(fixtures()),
    ),
    "ADDRESS_SET_MISMATCH",
  );

  const missingObjects = fixtures();
  missingObjects.delete(binding().targets[0]!.objectKey);
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(missingObjects)),
    "READ_FAILED",
  );

  const extraResult: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: fixtures().get(key)!.slice(),
    eTag: "etag",
    versionId: "version",
    extra: "address",
  } as ComputeOptimizerExportObjectRead);
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), extraResult),
    "OBJECT_IDENTITY_MISMATCH",
  );

  const substituted = fixtures();
  const first = binding().targets[0]!;
  const second = binding().targets[1]!;
  substituted.set(first.metadataKey, metadata(basename(second.objectKey)));
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(substituted)),
    "ADDRESS_SET_MISMATCH",
  );
});

test("enforces per-object and aggregate byte caps", async () => {
  const value = binding();
  const objects = fixtures(value);
  const oversized: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: key.endsWith(".csv") ? new Uint8Array(101) : objects.get(key)!.slice(),
    eTag: `etag-${key}`,
    versionId: `version-${key}`,
  });
  await rejects(
    loadComputeOptimizerExportObjectSet(value, oversized, {
      limits: { maximumCsvBytes: 100 },
    }),
    "LIMIT_EXCEEDED",
  );

  const total = [...objects.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  await rejects(
    loadComputeOptimizerExportObjectSet(value, readerFor(objects), {
      limits: { maximumAggregateBytes: total - 1 },
    }),
    "LIMIT_EXCEEDED",
  );
});

test("rejects invalid object identities, shared buffers and mutation during validation", async () => {
  const objects = fixtures();
  const emptyIdentity: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: objects.get(key)!.slice(),
    eTag: "",
    versionId: "version",
  });
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), emptyIdentity),
    "OBJECT_IDENTITY_MISMATCH",
  );

  const missingVersionId: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: objects.get(key)!.slice(),
    eTag: `etag-${key}`,
  } as unknown as ComputeOptimizerExportObjectRead);
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), missingVersionId),
    "OBJECT_IDENTITY_MISMATCH",
  );

  const invalidVersionId: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => ({
    bytes: objects.get(key)!.slice(),
    eTag: `etag-${key}`,
    versionId: "",
  });
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), invalidVersionId),
    "OBJECT_IDENTITY_MISMATCH",
  );

  const shared = new Uint8Array(2_048);
  const sharedReader: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => {
    const value = objects.get(key)!;
    const view = new Uint8Array(shared.buffer, 0, value.byteLength);
    view.set(value);
    return { bytes: view, eTag: `etag-${key}`, versionId: `version-${key}` };
  };
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), sharedReader),
    "OBJECT_IDENTITY_MISMATCH",
  );

  let identityReads = 0;
  const mutatingReader: ComputeOptimizerExportObjectReader = async (_region, _bucket, key) => {
    const result = {
      bytes: objects.get(key)!.slice(),
      versionId: `version-${key}`,
    } as { bytes: Uint8Array; readonly eTag: string; versionId: string };
    Object.defineProperty(result, "eTag", {
      enumerable: true,
      get: () => {
        identityReads += 1;
        return identityReads <= 3 ? "etag-original" : "etag-mutated";
      },
    });
    return result;
  };
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), mutatingReader),
    "OBJECT_MUTATED",
  );

  const substitutedVersionReader: ComputeOptimizerExportObjectReader = async (
    _region,
    _bucket,
    key,
  ) => {
    let versionReads = 0;
    const result = {
      bytes: objects.get(key)!.slice(),
      eTag: `etag-${key}`,
    } as { bytes: Uint8Array; eTag: string; readonly versionId: string | null };
    Object.defineProperty(result, "versionId", {
      enumerable: true,
      get: () => {
        versionReads += 1;
        return versionReads <= 2 ? null : `version-substituted-${key}`;
      },
    });
    return result;
  };
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), substitutedVersionReader),
    "OBJECT_MUTATED",
  );
});

test("honors pre-abort, in-flight abort and absolute deadlines", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let calls = 0;
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), async () => {
      calls += 1;
      throw new Error("must not run");
    }, { signal: alreadyAborted.signal }),
    "ABORTED",
  );
  assert.equal(calls, 0);

  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(fixtures()), {
      deadlineAtMs: 999,
      now: () => 1_000,
    }),
    "DEADLINE_EXCEEDED",
  );

  const controller = new AbortController();
  const waiting: ComputeOptimizerExportObjectReader = async (_region, _bucket, _key, _max, signal) =>
    new Promise((_resolve, rejectPromise) => {
      signal.addEventListener("abort", () => rejectPromise(new Error("provider secret")), {
        once: true,
      });
    });
  const pending = loadComputeOptimizerExportObjectSet(binding(), waiting, {
    signal: controller.signal,
  });
  controller.abort();
  await rejects(pending, "ABORTED");

  const started = Date.now();
  const neverSettles: ComputeOptimizerExportObjectReader = async () =>
    new Promise<ComputeOptimizerExportObjectRead>(() => undefined);
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), neverSettles, {
      deadlineAtMs: started + 20,
    }),
    "DEADLINE_EXCEEDED",
  );
  assert.ok(Date.now() - started < 1_000, "deadline must not depend on reader cooperation");

  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(fixtures()), {
      now: () => Number.MAX_SAFE_INTEGER,
    }),
    "INVALID_INPUT",
  );

  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(fixtures()), {
      unexpected: true,
    } as unknown as Parameters<typeof loadComputeOptimizerExportObjectSet>[2]),
    "INVALID_INPUT",
  );
});

test("maps malformed CSVW and provider failures to safe local codes", async () => {
  const malformed = fixtures();
  malformed.set(binding().targets[0]!.metadataKey, encoder.encode("not-json"));
  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), readerFor(malformed)),
    "PARSE_REJECTED",
  );

  await rejects(
    loadComputeOptimizerExportObjectSet(binding(), async () => {
      throw new Error("AccessDenied: arn:aws:iam::111122223333:role/private");
    }),
    "READ_FAILED",
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  KUBECOST_CCA_DATASET_COLUMNS,
  KUBECOST_OFFICIAL_SOURCE,
  KUBECOST_PROVIDER_ACTIONS,
  KUBECOST_PROVIDER_BOUNDS,
  KUBECOST_RUNTIME_REQUEST_BOUNDS,
  KubecostProviderAdapterError,
  type KubecostProviderBinding,
  type KubecostProviderRequest,
} from "../src/kubecost-versioned-export-provider-adapter.js";
import {
  parseKubecostProviderRouteRequest,
  runKubecostProviderRoute,
} from "../src/kubecost-versioned-export-provider-route.js";
import { createKubecostS3SdkReader } from "../src/kubecost-s3-sdk-reader.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const ACCOUNT = "111122223333"; const CLUSTER = "eks-prod";
const CONNECTION = `conn_${"a".repeat(32)}`; const PREFIX = "tenants/org_alpha/kubecost/";
const KEY = `${PREFIX}account_id=${ACCOUNT}/region=us-east-1/year=2026/month=08/2026-08-01_eks-prod.snappy.parquet`;
const destination = { bucket: "sutra-kubecost-evidence", prefix: PREFIX, expectedBucketOwner: ACCOUNT, requireObjectVersionIds: true as const, kmsKeyArn: null };
const activeCur2 = { source: "AWS_CUR2_ACTIVE_GENERATION" as const, generationState: "ACTIVE" as const, generationId: `fbg_${"d".repeat(64)}`, manifestSha256: "e".repeat(64), billingPeriod: "2026-08", dataThroughAtIso: "2026-08-02T00:00:00.000Z", payerAccountIds: [ACCOUNT], usageAccountIds: [ACCOUNT], clusterIds: [CLUSTER], scopeBasis: "KUBERNETES_CLUSTER_TAGGED_COST" as const, rowsExhausted: true, totals: [{ currency: "USD", amountMicros: "10750000" }] };
const request: KubecostProviderRequest = {
  schemaVersion: "sutra.kubecost-versioned-runtime-request.v1", requestId: `kur_${"b".repeat(64)}`,
  jobId: `job_${"c".repeat(32)}`, scheduledWindow: "2026-08-02T12:00:00.000Z",
  scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION, partition: "aws", billingPeriod: "2026-08", activeCur2GenerationId: `fbg_${"d".repeat(64)}`, awsAccountIds: [ACCOUNT], clusterIds: [CLUSTER] },
  destination,
  activeCur2,
  activeCur2Sha256: createHash("sha256").update(JSON.stringify(activeCur2)).digest("hex"),
  exportContract: { schemaName: "sutra.kubecost-opencost-allocation", schemaVersion: "2.0.0", officialAwsCca: { sourceCommit: KUBECOST_OFFICIAL_SOURCE.commit, inputColumnCount: 62, format: "SNAPPY_PARQUET" }, query: { step: "1d" } },
  runtimeReadActions: KUBECOST_PROVIDER_ACTIONS.slice(0, 3), versionedReadActions: ["s3:GetObjectVersion"], conditionalKmsActions: ["kms:Decrypt"], exporterWriteActions: [], bounds: KUBECOST_RUNTIME_REQUEST_BOUNDS, maximumDurationMs: KUBECOST_PROVIDER_BOUNDS.maximumDurationMs,
};
const binding: KubecostProviderBinding = {
  schemaVersion: "sutra.kubecost-provider-binding.v1", orgId: request.scope.orgId,
  customerId: request.scope.customerId, connectionId: CONNECTION, permissionPackVersion: "standard-2026-08.9",
  provider: "KUBECOST", exporterName: "aws-cca-kubecost-s3-exporter", exporterVersion: KUBECOST_OFFICIAL_SOURCE.commit,
  costModelSha256: "1".repeat(64), currency: "USD", bucketRegion: "us-east-1", destination,
};
const credentials = { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(NOW + 3_600_000) };

function officialRow(): Record<string, unknown> {
  const row = Object.fromEntries(KUBECOST_CCA_DATASET_COLUMNS.map((column) => [column, ""]));
  Object.assign(row, {
    name: "payments-api", "window.start": "2026-08-01T00:00:00.000Z", "window.end": "2026-08-02T00:00:00.000Z", minutes: "1440",
    cpucores: "2", cpucorerequestaverage: "2", cpucoreusageaverage: "1", cpucorehours: "48", cpucost: "4", cpucostadjustment: "0", cpuefficiency: "0.5",
    gpucount: "1", gpuhours: "24", gpucost: "1", gpucostadjustment: "0", networktransferbytes: "1000", networkreceivebytes: "500", networkcost: "0.5", networkcrosszonecost: "0", networkcrossregioncost: "0", networkinternetcost: "0.5", networkcostadjustment: "0",
    loadbalancercost: "0.25", loadbalancercostadjustment: "0", pvbytes: "100", pvbytehours: "2400", pvcost: "1", pvcostadjustment: "0",
    rambytes: "100", rambyterequestaverage: "100", rambyteusageaverage: "50", rambytehours: "2400", ramcost: "2", ramcostadjustment: "0", ramefficiency: "0.5",
    sharedcost: "1", externalcost: "1", totalcost: "10.75", totalefficiency: "0.5", "properties.provider": "AWS", "properties.region": "us-east-1",
    "properties.cluster": CLUSTER, "properties.clusterid": CLUSTER, "properties.eksclustername": CLUSTER, "properties.container": "api", "properties.namespace": "payments", "properties.pod": "payments-api-1",
    "properties.node": "ip-10-0-1-10", "properties.node_instance_type": "m7g.large", "properties.node_availability_zone": "us-east-1a", "properties.node_capacity_type": "ON_DEMAND", "properties.node_architecture": "arm64", "properties.node_os": "linux", "properties.node_nodegroup": "payments-arm", "properties.node_nodegroup_image": "ami-123", "properties.controller": "payments-api", "properties.controllerkind": "Deployment", "properties.providerid": "i-123", account_id: ACCOUNT, region: "us-east-1", year: "2026", month: "08",
  });
  return row;
}
function dependencies(overrides: Partial<Parameters<typeof runKubecostProviderRoute>[1]> = {}): Parameters<typeof runKubecostProviderRoute>[1] {
  return {
    now: () => NOW,
    loadBinding: async () => binding,
    assumeReadOnlySession: async (value) => {
      assert.deepEqual(value.sessionActions, KUBECOST_PROVIDER_ACTIONS);
      assert.equal(value.bucket, destination.bucket); assert.equal(value.prefix, destination.prefix);
      return { accountId: ACCOUNT, partition: "aws", permissionPackVersion: "standard-2026-08.9", credentials };
    },
    readerFactory: () => ({
      getBucketLocation: async () => "us-east-1",
      listObjects: async () => ({ objects: [{ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z" }], nextContinuationToken: null }),
      readVersionedParquet: async () => ({ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z", versionId: "version-1", contentSha256: "2".repeat(64), columns: KUBECOST_CCA_DATASET_COLUMNS, rows: [officialRow()] }),
    }),
    ...overrides,
  };
}

test("pinned source contract contains exactly the official 62 physical columns", () => {
  assert.equal(KUBECOST_CCA_DATASET_COLUMNS.length, 62);
  assert.equal(new Set(KUBECOST_CCA_DATASET_COLUMNS).size, 62);
  assert.equal(KUBECOST_OFFICIAL_SOURCE.athenaViewQuerySha256, "2a5db62703b857a19d56a50661e5a20be4d02776aad3d1065422c7bab8b2e07c");
  for (const column of ["properties.node_instance_type", "properties.node_capacity_type", "properties.node_nodegroup"]) assert.equal(KUBECOST_CCA_DATASET_COLUMNS.includes(column as never), true);
});

test("concrete S3 reader heads current key then fetches the exact returned version", async () => {
  const calls: Array<{ readonly name: string; readonly input: Record<string, unknown> }> = [];
  const bytes = new TextEncoder().encode("PAR1");
  const client = { send: async (command: { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "GetBucketLocationCommand") return { LocationConstraint: undefined };
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [{ Key: KEY, ETag: "etag", Size: bytes.byteLength, LastModified: new Date(NOW) }], IsTruncated: false };
    if (command.constructor.name === "HeadObjectCommand") return { VersionId: "version-1", ContentLength: bytes.byteLength, LastModified: new Date(NOW) };
    return { VersionId: "version-1", ContentLength: bytes.byteLength, ETag: "etag", LastModified: new Date(NOW), Body: { transformToByteArray: async () => bytes } };
  } } as never;
  const reader = createKubecostS3SdkReader({ credentials, partition: "aws", region: "us-east-1", client,
    decoder: { decode: async () => ({ columns: KUBECOST_CCA_DATASET_COLUMNS, rows: [officialRow()] }) } });
  const signal = new AbortController().signal;
  assert.equal(await reader.getBucketLocation({ bucket: destination.bucket, expectedBucketOwner: ACCOUNT }, signal), "us-east-1");
  assert.equal((await reader.listObjects({ bucket: destination.bucket, prefix: PREFIX, expectedBucketOwner: ACCOUNT, continuationToken: null }, signal)).objects.length, 1);
  const object = await reader.readVersionedParquet({ bucket: destination.bucket, key: KEY, expectedBucketOwner: ACCOUNT, maximumBytes: bytes.byteLength }, signal);
  assert.equal(object.versionId, "version-1"); assert.equal(object.contentSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(calls.map((call) => call.name), ["GetBucketLocationCommand", "ListObjectsV2Command", "HeadObjectCommand", "GetObjectCommand"]);
  assert.equal(calls.at(-1)?.input.VersionId, "version-1"); assert.equal(calls.at(-1)?.input.ExpectedBucketOwner, ACCOUNT);
});

test("same-tenant route pins session scope and returns versioned node allocation evidence", async () => {
  const body = JSON.stringify(request);
  const result = await runKubecostProviderRoute({ body, headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId, connectionId: CONNECTION, jobId: request.jobId }, signal: new AbortController().signal }, dependencies());
  assert.equal(result.requestBodySha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(result.capture.objects[0]?.versionId, "version-1");
  assert.equal(result.capture.rows[0]?.nodeCapacityType, "ON_DEMAND");
  assert.equal(result.capture.rows[0]?.nodeInstanceType, "m7g.large");
  assert.equal(result.capture.rows[0]?.metrics.cpuCoreRequestHours, "48");
  assert.equal(result.capture.export.query.step, "1d");
  assert.equal(result.capture.coverage.rowsExhausted, true);
});

test("cross-tenant and mutable/unpinned object substitutions fail closed", async () => {
  let assumed = false;
  await assert.rejects(runKubecostProviderRoute({ body: JSON.stringify(request), headers: { tenantId: "org_attacker", customerId: request.scope.customerId, connectionId: CONNECTION, jobId: request.jobId }, signal: new AbortController().signal }, dependencies({ assumeReadOnlySession: async () => { assumed = true; throw new Error("must not assume"); } })), (error) => error instanceof KubecostProviderAdapterError && error.code === "INVALID_REQUEST");
  assert.equal(assumed, false);
  const hostile = { ...request, destination: { ...destination, prefix: "tenants/org_attacker/" } };
  assert.throws(() => parseKubecostProviderRouteRequest(JSON.stringify({ ...hostile, extra: true })), (error) => error instanceof KubecostProviderAdapterError);
  await assert.rejects(runKubecostProviderRoute({ body: JSON.stringify(request), headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId, connectionId: CONNECTION, jobId: request.jobId }, signal: new AbortController().signal }, dependencies({ readerFactory: () => ({
    getBucketLocation: async () => "us-east-1", listObjects: async () => ({ objects: [{ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z" }], nextContinuationToken: null }),
    readVersionedParquet: async () => ({ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z", versionId: "", contentSha256: "2".repeat(64), columns: KUBECOST_CCA_DATASET_COLUMNS, rows: [officialRow()] }),
  }) })), (error) => error instanceof KubecostProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID");
});

test("schema drift and forged component totals never reach accepted capture", async () => {
  const drift = officialRow(); delete drift["properties.node_capacity_type"];
  const badTotal = officialRow(); badTotal.totalcost = "999";
  for (const raw of [drift, badTotal]) {
    await assert.rejects(runKubecostProviderRoute({ body: JSON.stringify(request), headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId, connectionId: CONNECTION, jobId: request.jobId }, signal: new AbortController().signal }, dependencies({ readerFactory: () => ({
      getBucketLocation: async () => "us-east-1", listObjects: async () => ({ objects: [{ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z" }], nextContinuationToken: null }),
      readVersionedParquet: async () => ({ key: KEY, eTag: "etag", sizeBytes: 1024, lastModifiedIso: "2026-08-02T01:00:00.000Z", versionId: "version-1", contentSha256: "2".repeat(64), columns: KUBECOST_CCA_DATASET_COLUMNS, rows: [raw] }),
    }) })), (error) => error instanceof KubecostProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID");
  }
});

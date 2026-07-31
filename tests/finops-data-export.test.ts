import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideFinopsDataExportIngestion,
  validateFinopsDataExportManifest,
  type FinopsManifestObservation,
} from "../lib/finops-data-export.ts";

const SCOPE = { organizationId: "org_a", customerId: "customer_a", connectionId: "connection_a" } as const;

function observation(overrides: Partial<FinopsManifestObservation> = {}): FinopsManifestObservation {
  return {
    scope: SCOPE,
    bucket: "sutra-customer-billing",
    manifestKey: "exports/aws-cur/metadata/BILLING_PERIOD=2026-07/aws-cur-Manifest.json",
    eTag: '"etag-1"',
    versionId: "version-1",
    observedAtIso: "2026-07-31T12:00:00Z",
    body: {
      metadata: {
        exportName: "aws-cur",
        exportTableName: "COST_AND_USAGE_REPORT",
        exportLastUpdatedTime: "2026-07-31T11:45:00Z",
      },
      data: {
        billingPeriod: { start: "2026-07-01T00:00:00Z", end: "2026-08-01T00:00:00Z" },
        columns: [{ name: "line_item_id" }, { name: "line_item_unblended_cost" }],
        dataFiles: [
          { filePath: "exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-00001.csv.gz" },
          { filePath: "exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-00002.snappy.parquet" },
        ],
      },
    },
    ...overrides,
  };
}

describe("AWS Data Exports manifest validation", () => {
  it("builds a tenant-bound atomic CUR 2.0 partition plan", async () => {
    const result = await validateFinopsDataExportManifest(observation());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.manifest.table, "cur-2.0");
    assert.equal(result.manifest.billingPeriod, "2026-07");
    assert.equal(result.manifest.dataFiles.length, 2);
    assert.equal(result.manifest.columns.length, 2);
    assert.match(result.manifest.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(result.manifest.schemaSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(
      decideFinopsDataExportIngestion(result.manifest, null),
      { action: "ingest", reason: "first_delivery", writeMode: "replace_partition_atomically", manifest: result.manifest },
    );
  });

  it("accepts same-bucket S3 URIs and infers AWS FOCUS 1.2", async () => {
    const result = await validateFinopsDataExportManifest(observation({
      body: {
        exportName: "aws-focus-1.2",
        tableName: "FOCUS_1_2",
        columns: ["BillingAccountId", "BilledCost"],
        dataFiles: ["s3://sutra-customer-billing/focus/data/BILLING_PERIOD=2026-07/focus-00001.csv.gz"],
      },
    }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.manifest.table, "focus-1.2-aws");
  });

  it("rejects cross-bucket, duplicate, unsafe, and unsupported data objects", async () => {
    const cases = [
      {
        body: { exportName: "cur", columns: ["a"], dataFiles: ["s3://attacker-bucket/x/BILLING_PERIOD=2026-07/a.csv.gz"] },
        code: "CROSS_BUCKET_FILE",
      },
      {
        body: { exportName: "cur", columns: ["a"], dataFiles: ["x/BILLING_PERIOD=2026-07/a.csv.gz", "x/BILLING_PERIOD=2026-07/a.csv.gz"] },
        code: "DUPLICATE_FILE",
      },
      {
        body: { exportName: "cur", columns: ["a"], dataFiles: ["../BILLING_PERIOD=2026-07/a.csv.gz"] },
        code: "INVALID_MANIFEST",
      },
      {
        body: { exportName: "cur", columns: ["a"], dataFiles: ["x/BILLING_PERIOD=2026-07/script.js"] },
        code: "UNSUPPORTED_FILE",
      },
    ] as const;
    for (const entry of cases) {
      const result = await validateFinopsDataExportManifest(observation({ body: entry.body }));
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.rejection.code, entry.code);
    }
  });

  it("is content-idempotent and accepts a corrected partition only as atomic replacement", async () => {
    const first = await validateFinopsDataExportManifest(observation());
    if (!first.ok) throw new Error(first.rejection.message);
    const persisted = {
      scope: SCOPE,
      exportName: first.manifest.exportName,
      billingPeriod: first.manifest.billingPeriod,
      manifestSha256: first.manifest.manifestSha256,
      eTag: first.manifest.eTag,
      versionId: first.manifest.versionId,
      committedAtIso: "2026-07-31T12:01:00Z",
    };
    assert.equal(decideFinopsDataExportIngestion(first.manifest, persisted).reason, "duplicate_manifest");

    const corrected = await validateFinopsDataExportManifest(observation({
      eTag: '"etag-2"',
      versionId: "version-2",
      body: {
        metadata: { exportName: "aws-cur", exportTableName: "COST_AND_USAGE_REPORT" },
        columns: ["line_item_id", "line_item_unblended_cost"],
        dataFiles: ["exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-00001.csv.gz"],
      },
    }));
    if (!corrected.ok) throw new Error(corrected.rejection.message);
    const decision = decideFinopsDataExportIngestion(corrected.manifest, persisted);
    assert.equal(decision.action, "ingest");
    if (decision.action === "ingest") {
      assert.equal(decision.reason, "corrected_or_refreshed_delivery");
      assert.equal(decision.writeMode, "replace_partition_atomically");
    }
  });

  it("rejects a digest change under the same immutable S3 object version", async () => {
    const first = await validateFinopsDataExportManifest(observation());
    const changed = await validateFinopsDataExportManifest(observation({
      body: {
        exportName: "aws-cur",
        tableName: "CUR",
        columns: ["line_item_id"],
        dataFiles: ["exports/aws-cur/data/BILLING_PERIOD=2026-07/aws-cur-00001.csv.gz"],
      },
    }));
    if (!first.ok || !changed.ok) throw new Error("fixtures must validate");
    const decision = decideFinopsDataExportIngestion(changed.manifest, {
      scope: SCOPE,
      exportName: first.manifest.exportName,
      billingPeriod: first.manifest.billingPeriod,
      manifestSha256: first.manifest.manifestSha256,
      eTag: first.manifest.eTag,
      versionId: first.manifest.versionId,
      committedAtIso: "2026-07-31T12:01:00Z",
    });
    assert.equal(decision.reason, "immutable_object_changed");
  });
});

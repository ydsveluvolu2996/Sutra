import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";

import type {
  BeginFinopsBillingGenerationResult,
  CommitFinopsBillingGenerationResult,
  FinopsBillingGeneration,
  FinopsBillingReconciliation,
  FinopsBillingScope,
} from "../db/finops-billing-engine-repository.ts";
import type { CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  enqueueFinopsDataExportIngestJob,
  FINOPS_DATA_EXPORT_INGEST_JOB_KIND,
  FinopsDataExportIngestJobError,
  FOUNDATIONAL_FINOPS_PERMISSION_PACK,
  runFinopsDataExportIngestJob,
  type FinopsDataExportIngestJobDependencies,
  type FinopsDataExportIngestJobPayload,
} from "../lib/finops-data-export-ingest-job.ts";
import type {
  FinopsS3IngestionRepository,
} from "../lib/finops-s3-ingestion.ts";
import type { FinopsBrokerObject } from "../lib/finops-broker-object-reader.ts";
import type { PilotConnection } from "../lib/pilot-types.ts";

const ORG = "org_ingest";
const CUSTOMER = "customer_ingest";
const CONNECTION = `conn_${"a".repeat(32)}`;
const BUCKET = "customer-billing-export";
const EXPORT_NAME = "sutra_foundational_cur2_v1";
const PREFIX = `sutra/cur2/${EXPORT_NAME}/`;
const MANIFEST_KEY =
  `${PREFIX}metadata/BILLING_PERIOD=2026-07/manifest.json`;
const DATA_KEY =
  `${PREFIX}data/BILLING_PERIOD=2026-07/part-00001.csv.gz`;
const HEADER = [
  "line_item_id",
  "line_item_usage_account_id",
  "product_servicecode",
  "line_item_line_item_type",
  "line_item_usage_start_date",
  "line_item_unblended_cost",
  "line_item_currency_code",
] as const;

const PAYLOAD: FinopsDataExportIngestJobPayload = {
  schema: "sutra.finops-data-export-ingest.v1",
  connectionId: CONNECTION,
  contractId: "foundational-cur2-export-v1",
  exportName: EXPORT_NAME,
  region: "us-east-1",
  bucket: BUCKET,
  prefix: PREFIX,
  manifestKey: MANIFEST_KEY,
  evidence: {
    sourceEvidenceId: "aws-data-export-execution:execution-1",
    rowCount: 1,
    currencies: [{
      currency: "USD",
      rowCount: 1,
      totalMicros: "1000000",
    }],
  },
};

const CONNECTION_ROW = {
  id: CONNECTION,
  customerId: CUSTOMER,
  customerName: "Customer",
  sourceKind: "aws_trust_role",
  fixtureId: null,
  fixtureVersion: null,
  partition: "aws",
  awsAccountId: "111122223333",
  roleArn: "arn:aws:iam::111122223333:role/sutra/SutraCollectorRole",
  status: "active",
  enabledRegions: ["us-east-1"],
  permissionPackVersion: FOUNDATIONAL_FINOPS_PERMISSION_PACK,
  roleProvisioningMode: "sutra_template",
  expectedRolePath: "/sutra/",
  expectedRoleName: "SutraCollectorRole",
  permissionCapabilities: { grantedActions: [], missingActions: [] },
  lastValidatedAt: "2026-07-31T00:00:00.000Z",
  lastSuccessfulSyncAt: null,
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
} as const;

function manifestBody(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    metadata: {
      exportName: EXPORT_NAME,
      exportTableName: "COST_AND_USAGE_REPORT",
      exportLastUpdatedTime: "2026-07-31T11:45:00.000Z",
    },
    columns: HEADER,
    dataFiles: [DATA_KEY],
    ...overrides,
  });
}

function csv(): string {
  return [
    HEADER.join(","),
    "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD",
  ].join("\n");
}

function object(bytes: Uint8Array): FinopsBrokerObject {
  return {
    bytes,
    eTag: '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
    versionId: "version-1",
    totalBytes: bytes.byteLength,
  };
}

function job(overrides = {}) {
  return {
    id: `job_${"1".repeat(32)}`,
    orgId: ORG,
    customerId: CUSTOMER,
    connectionId: CONNECTION,
    kind: FINOPS_DATA_EXPORT_INGEST_JOB_KIND,
    payload: PAYLOAD,
    attempt: 1,
    maxAttempts: 6,
    ...overrides,
  };
}

class Repository implements FinopsS3IngestionRepository {
  public activeManifest: string | null = null;
  public stagingManifest: string | null = null;
  public staged = new Map<string, CanonicalCurLine>();
  public commits = 0;
  public failures: string[] = [];

  public async beginValidatedManifest(
    manifest: Parameters<FinopsS3IngestionRepository["beginValidatedManifest"]>[0],
  ): Promise<BeginFinopsBillingGenerationResult> {
    const generation = {
      exportName: manifest.exportName,
      billingPeriod: manifest.billingPeriod,
      generationId: `fbg_${manifest.manifestSha256}`,
    };
    if (this.activeManifest === manifest.manifestSha256) {
      return { action: "skip", reason: "duplicate_manifest", generation };
    }
    this.stagingManifest = manifest.manifestSha256;
    this.staged.clear();
    return {
      action: "stage",
      reason: this.activeManifest === null
        ? "first_delivery"
        : "corrected_delivery",
      generation,
    };
  }

  public async stageCanonicalLines(
    _scope: FinopsBillingScope,
    _generation: FinopsBillingGeneration,
    lines: readonly CanonicalCurLine[],
  ): Promise<void> {
    for (const line of lines) this.staged.set(line.lineItemId, line);
  }

  public async commitGeneration(
    _scope: FinopsBillingScope,
    generation: FinopsBillingGeneration,
    reconciliation: FinopsBillingReconciliation,
  ): Promise<CommitFinopsBillingGenerationResult> {
    this.commits += 1;
    this.activeManifest = this.stagingManifest;
    this.stagingManifest = null;
    return {
      generation,
      acceptedRows: reconciliation.acceptedRows,
      rejectedRows: reconciliation.rejectedRows,
      currencyTotals: reconciliation.currencyTotals,
      alreadyCommitted: false,
      committedAtIso: "2026-07-31T12:00:00.000Z",
    };
  }

  public async failGeneration(
    _scope: FinopsBillingScope,
    _generation: FinopsBillingGeneration,
    errorCode: string,
  ): Promise<void> {
    this.failures.push(errorCode);
    this.stagingManifest = null;
    this.staged.clear();
  }
}

function dependencies(
  repository = new Repository(),
  overrides: {
    connection?: PilotConnection | null;
    manifest?: string;
  } = {},
): {
  readonly repository: Repository;
  readonly reads: string[];
  readonly deps: FinopsDataExportIngestJobDependencies;
} {
  const reads: string[] = [];
  const manifest = new TextEncoder().encode(
    overrides.manifest ?? manifestBody(),
  );
  const data = new Uint8Array(gzipSync(csv()));
  return {
    repository,
    reads,
    deps: {
      getConnection: async () =>
        overrides.connection === undefined
          ? CONNECTION_ROW
          : overrides.connection,
      repository,
      readObject: async (_boundary, request) => {
        reads.push(request.key);
        if (request.key === MANIFEST_KEY) return object(manifest);
        if (request.key === DATA_KEY) return object(data);
        throw new Error("unexpected object");
      },
      now: () => Date.parse("2026-07-31T12:00:00.000Z"),
    },
  };
}

function jobFailure(code: FinopsDataExportIngestJobError["code"]) {
  return (error: unknown): boolean =>
    error instanceof FinopsDataExportIngestJobError
    && error.code === code;
}

describe("durable canonical Data Export ingestion job", () => {
  it("fetches a validated manifest, activates exact evidence, and makes retry idempotent", async () => {
    const fixture = dependencies();
    await runFinopsDataExportIngestJob(job(), fixture.deps);
    assert.deepEqual(fixture.reads, [MANIFEST_KEY, DATA_KEY]);
    assert.equal(fixture.repository.commits, 1);
    assert.deepEqual([...fixture.repository.staged.keys()], ["line-1"]);

    await runFinopsDataExportIngestJob(job({ attempt: 2 }), fixture.deps);
    assert.deepEqual(
      fixture.reads,
      [MANIFEST_KEY, DATA_KEY, MANIFEST_KEY],
      "a committed duplicate validates the live manifest but never refetches data files",
    );
    assert.equal(fixture.repository.commits, 1);
  });

  it("rejects cross-customer scope and the current read-only pack before object access", async () => {
    const crossCustomer = dependencies();
    await assert.rejects(
      runFinopsDataExportIngestJob(
        job({ customerId: "customer_attacker" }),
        crossCustomer.deps,
      ),
      jobFailure("CONNECTION_NOT_RUNNABLE"),
    );
    assert.equal(crossCustomer.reads.length, 0);

    const currentPack = dependencies(new Repository(), {
      connection: {
        ...CONNECTION_ROW,
        permissionPackVersion: "standard-2026-07.4",
      },
    });
    await assert.rejects(
      runFinopsDataExportIngestJob(job(), currentPack.deps),
      jobFailure("CONNECTION_NOT_RUNNABLE"),
    );
    assert.equal(currentPack.reads.length, 0);
  });

  it("rejects non-CUR2 or out-of-prefix manifests before data access", async () => {
    const focus = dependencies(new Repository(), {
      manifest: manifestBody({
        metadata: {
          exportName: EXPORT_NAME,
          exportTableName: "FOCUS_1_2",
        },
      }),
    });
    await assert.rejects(
      runFinopsDataExportIngestJob(job(), focus.deps),
      jobFailure("MANIFEST_REJECTED"),
    );
    assert.deepEqual(focus.reads, [MANIFEST_KEY]);

    const escaped = dependencies(new Repository(), {
      manifest: manifestBody({
        dataFiles: [
          "sutra/cur2/other/data/BILLING_PERIOD=2026-07/part.csv.gz",
        ],
      }),
    });
    await assert.rejects(
      runFinopsDataExportIngestJob(job(), escaped.deps),
      jobFailure("MANIFEST_REJECTED"),
    );
    assert.deepEqual(escaped.reads, [MANIFEST_KEY]);
  });

  it("enqueues only a connection-scoped six-attempt job", async () => {
    const calls: unknown[] = [];
    const result = await enqueueFinopsDataExportIngestJob({
      async enqueue(input) {
        calls.push(input);
        return { id: `job_${"2".repeat(32)}` };
      },
    }, {
      orgId: ORG,
      customerId: CUSTOMER,
      payload: PAYLOAD,
    });
    assert.equal(result.jobId, `job_${"2".repeat(32)}`);
    assert.deepEqual(calls, [{
      orgId: ORG,
      customerId: CUSTOMER,
      connectionId: CONNECTION,
      kind: FINOPS_DATA_EXPORT_INGEST_JOB_KIND,
      payload: PAYLOAD,
      maxAttempts: 6,
    }]);
  });
});

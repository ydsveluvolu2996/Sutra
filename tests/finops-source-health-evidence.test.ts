import assert from "node:assert/strict";
import test from "node:test";
import type {
  FinopsActiveBillingPartition,
} from "../db/finops-active-billing-query-repository.ts";
import {
  PersistedFinopsEvidenceError,
  buildPersistedFinopsSourceEvidence,
} from "../lib/finops-source-health-evidence.ts";
import type { PilotConnection, PilotState } from "../lib/pilot-types.ts";

const scope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function connection(overrides: Partial<PilotConnection> = {}): PilotConnection {
  return {
    id: scope.connectionId,
    customerId: scope.customerId,
    customerName: "Alpha",
    sourceKind: "aws_trust_role",
    fixtureId: null,
    fixtureVersion: null,
    partition: "aws",
    awsAccountId: "111122223333",
    roleArn: "arn:aws:iam::111122223333:role/SutraCollectorRole",
    status: "active",
    enabledRegions: ["us-east-1"],
    permissionPackVersion: "standard-2026-07.4",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    permissionCapabilities: null,
    lastValidatedAt: "2026-07-31T08:00:00.000Z",
    lastSuccessfulSyncAt: "2026-07-31T10:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-31T10:00:00.000Z",
    ...overrides,
  };
}

function pilotState(conn: PilotConnection, overrides: Partial<PilotState> = {}): PilotState {
  return {
    mode: "live",
    connection: conn,
    resources: [],
    relationships: [],
    findings: [],
    coverage: [],
    latestRunCoverage: {
      syncRunId: "run_1",
      entries: [{
        collectorKey: "ec2",
        region: "us-east-1",
        status: "succeeded",
        itemsObserved: 3,
        pagesObserved: 1,
      }],
    },
    syncRuns: [{
      id: "run_1",
      connectionId: scope.connectionId,
      status: "succeeded",
      coverageState: "complete",
      totals: {},
      startedAt: "2026-07-31T09:55:00.000Z",
      finishedAt: "2026-07-31T10:00:00.000Z",
      createdAt: "2026-07-31T09:55:00.000Z",
    }],
    activeSnapshot: {
      id: "snap_1",
      collectedAt: "2026-07-31T10:00:00.000Z",
      coverageState: "complete",
      snapshotSha256: "a".repeat(64),
      origin: { kind: "aws_live", fixtureId: null, fixtureVersion: null },
    },
    ...overrides,
  };
}

function activePartition(overrides: {
  readonly period?: string;
  readonly exportName?: string;
  readonly sourceTable?: string;
  readonly sourceFormat?: "aws-cur" | "focus";
  readonly sourceVersion?: "2.0" | "1.0" | "1.2";
  readonly acceptedRows?: number;
  readonly rejectedRows?: number;
  readonly sourceUpdatedAtIso?: string | null;
  readonly observedAtIso?: string;
  readonly committedAtIso?: string;
  readonly generationCharacter?: string;
  readonly scopeOverride?: Partial<
    FinopsActiveBillingPartition["scope"]
  >;
} = {}): FinopsActiveBillingPartition {
  const generationCharacter = overrides.generationCharacter ?? "a";
  return {
    partitionId:
      `fbp_${generationCharacter.repeat(32)}`,
    scope: {
      organizationId: scope.orgId,
      customerId: scope.customerId,
      connectionId: scope.connectionId,
      exportName: overrides.exportName ?? "cur-primary",
      billingPeriod: overrides.period ?? "2026-07",
      generationId: `fbg_${generationCharacter.repeat(64)}`,
      ...overrides.scopeOverride,
    },
    evidence: {
      activeManifestSha256: generationCharacter.repeat(64),
      activeSourceTable:
        overrides.sourceTable ?? "COST_AND_USAGE_REPORT",
      activeSourceFormat: overrides.sourceFormat ?? "aws-cur",
      activeSourceVersion: overrides.sourceVersion ?? "2.0",
      activeSourceUpdatedAtIso:
        overrides.sourceUpdatedAtIso
        === undefined
          ? "2026-07-31T09:00:00.000Z"
          : overrides.sourceUpdatedAtIso,
      activeObservedAtIso:
        overrides.observedAtIso ?? "2026-07-31T09:05:00.000Z",
      activeCommittedAtIso:
        overrides.committedAtIso ?? "2026-07-31T09:06:00.000Z",
      acceptedRows: overrides.acceptedRows ?? 100,
      rejectedRows: overrides.rejectedRows ?? 0,
      activeFileCount: 1,
    },
  };
}

function evidenceInput(
  conn: PilotConnection,
  activeBillingPartitions:
    readonly FinopsActiveBillingPartition[],
  state: PilotState = pilotState(conn),
) {
  return {
    scope,
    connection: conn,
    pilotState: state,
    activeBillingPartitions,
  };
}

test("CUR2 evidence selects one newest export definition and preserves active freshness", () => {
  const conn = connection();
  const evidence = buildPersistedFinopsSourceEvidence(evidenceInput(
    conn,
    [
      activePartition({
        period: "2026-07",
        exportName: "cur-primary",
        acceptedRows: 100,
        rejectedRows: 2,
        sourceUpdatedAtIso: "2026-07-31T09:00:00.000Z",
        observedAtIso: "2026-07-31T09:05:00.000Z",
        committedAtIso: "2026-07-31T09:06:00.000Z",
        generationCharacter: "a",
      }),
      activePartition({
        period: "2026-06",
        exportName: "cur-primary",
        acceptedRows: 50,
        sourceUpdatedAtIso: "2026-06-30T09:00:00.000Z",
        observedAtIso: "2026-06-30T09:05:00.000Z",
        committedAtIso: "2026-06-30T09:06:00.000Z",
        generationCharacter: "b",
      }),
      activePartition({
        period: "2026-06",
        exportName: "cur-retired-definition",
        sourceTable: "OLD_CUR_TABLE",
        acceptedRows: 900,
        generationCharacter: "c",
      }),
      activePartition({
        sourceFormat: "focus",
        sourceVersion: "1.0",
        exportName: "unsupported-focus",
        acceptedRows: 800,
        generationCharacter: "d",
      }),
    ],
  ));

  assert.deepEqual(evidence.map((entry) => entry.sourceId), [
    "data_collection_telemetry",
    "aws_cur2_data_export",
    "sutra_billing_workspace",
  ]);
  const inventory = evidence[0];
  assert.equal(inventory?.configured, true);
  assert.equal(inventory?.coverage.assessment, "complete");
  assert.equal(inventory?.coverage.acceptedRecords, 3);
  assert.equal(inventory?.dataThroughAt, "2026-07-31T10:00:00.000Z");

  const cur = evidence[1];
  assert.equal(cur?.configured, true);
  assert.equal(cur?.deliveryObserved, true);
  assert.equal(cur?.lastAttemptAt, "2026-07-31T09:05:00.000Z");
  assert.equal(cur?.lastSuccessAt, "2026-07-31T09:06:00.000Z");
  assert.equal(cur?.dataThroughAt, "2026-07-31T09:00:00.000Z");
  assert.equal(cur?.lastAttemptOutcome, "partial");
  assert.deepEqual(cur?.coverage, {
    assessment: "partial",
    acceptedRecords: 150,
    rejectedRecords: 2,
    expectedRecords: 152,
  });
  assert.match(
    cur?.evidenceBasis ?? "",
    /source=aws-cur\/2\.0; exportName=cur-primary; sourceTable=COST_AND_USAGE_REPORT; newestGenerationId=fbg_/u,
  );
  const workspace = evidence[2];
  assert.deepEqual(workspace?.coverage, cur?.coverage);
  assert.doesNotMatch(JSON.stringify(evidence), /OLD_CUR_TABLE|unsupported-focus/u);
});

test("CUR2 and FOCUS 1.2 are independent while workspace selects only the newest supported history", () => {
  const conn = connection();
  const evidence = buildPersistedFinopsSourceEvidence(evidenceInput(
    conn,
    [
      activePartition({
        exportName: "cur-main",
        acceptedRows: 10,
        committedAtIso: "2026-07-31T09:06:00.000Z",
        generationCharacter: "1",
      }),
      activePartition({
        exportName: "focus-main",
        sourceTable: "FOCUS_1_2",
        sourceFormat: "focus",
        sourceVersion: "1.2",
        acceptedRows: 20,
        committedAtIso: "2026-07-31T10:06:00.000Z",
        generationCharacter: "2",
      }),
      activePartition({
        period: "2026-06",
        exportName: "focus-main",
        sourceTable: "FOCUS_1_2",
        sourceFormat: "focus",
        sourceVersion: "1.2",
        acceptedRows: 5,
        committedAtIso: "2026-06-30T10:06:00.000Z",
        generationCharacter: "3",
      }),
      activePartition({
        period: "2026-06",
        exportName: "focus-retired",
        sourceTable: "FOCUS_OLD",
        sourceFormat: "focus",
        sourceVersion: "1.2",
        acceptedRows: 500,
        generationCharacter: "4",
      }),
    ],
  ));
  assert.deepEqual(evidence.map((entry) => entry.sourceId), [
    "data_collection_telemetry",
    "aws_cur2_data_export",
    "aws_focus_1_2_data_export",
    "sutra_billing_workspace",
  ]);
  assert.equal(evidence[1]?.coverage.acceptedRecords, 10);
  assert.equal(evidence[2]?.coverage.acceptedRecords, 25);
  assert.equal(
    evidence[3]?.coverage.acceptedRecords,
    25,
    "workspace must select FOCUS without adding CUR or retired definitions",
  );
  assert.match(evidence[2]?.evidenceBasis ?? "", /source=focus\/1\.2/u);
  assert.doesNotMatch(JSON.stringify(evidence), /FOCUS_OLD/u);
});

test("no active partition stays unconfigured and fixture evidence is excluded", () => {
  const live = connection();
  const absent = buildPersistedFinopsSourceEvidence(
    evidenceInput(live, []),
  );
  assert.deepEqual(absent.map((entry) => entry.sourceId), [
    "data_collection_telemetry",
    "sutra_billing_workspace",
  ]);
  assert.equal(absent[1]?.configured, false);
  assert.equal(absent[1]?.deliveryObserved, false);
  assert.equal(absent[1]?.coverage.acceptedRecords, null);

  const conn = connection({
    sourceKind: "simulated_fixture",
    fixtureId: "fixture-1",
    fixtureVersion: "1",
    roleArn: null,
  });
  const evidence = buildPersistedFinopsSourceEvidence(evidenceInput(
    conn,
    [activePartition()],
    pilotState(conn, {
      activeSnapshot: {
        id: "snap_fixture",
        collectedAt: "2026-07-31T10:00:00.000Z",
        coverageState: "complete",
        snapshotSha256: "b".repeat(64),
        origin: { kind: "simulated_fixture", fixtureId: "fixture-1", fixtureVersion: "1" },
      },
    }),
  ));

  assert.deepEqual(evidence.map((entry) => entry.sourceId), [
    "data_collection_telemetry",
    "sutra_billing_workspace",
  ]);
  assert.ok(evidence.every((entry) => entry.configured === false));
  assert.ok(evidence.every((entry) => entry.deliveryObserved === false));
  assert.ok(evidence.every((entry) => entry.limitations?.some((value) => /Fixture data/u.test(value)) === true));
});

test("cross-tenant, partition-limit, and record-limit evidence is rejected", () => {
  const conn = connection();
  assert.throws(
    () => buildPersistedFinopsSourceEvidence(evidenceInput(conn, [
      activePartition({
        scopeOverride: { customerId: "customer_attacker" },
      }),
    ])),
    (error) =>
      error instanceof PersistedFinopsEvidenceError
      && error.code === "SCOPE_MISMATCH",
  );
  assert.throws(
    () => buildPersistedFinopsSourceEvidence(evidenceInput(
      conn,
      Array.from({ length: 37 }, (_, index) =>
        activePartition({
          period: `2026-${String((index % 12) + 1).padStart(2, "0")}`,
          generationCharacter: (index % 10).toString(),
        })),
    )),
    (error) =>
      error instanceof PersistedFinopsEvidenceError
      && error.code === "LIMIT_EXCEEDED",
  );
  assert.throws(
    () => buildPersistedFinopsSourceEvidence(evidenceInput(conn, [
      activePartition({ acceptedRows: 250_000, rejectedRows: 1 }),
    ])),
    (error) =>
      error instanceof PersistedFinopsEvidenceError
      && error.code === "INVALID_INPUT",
  );
});

test("correction-in-progress fields cannot alter prior active source health", () => {
  const conn = connection();
  const active = activePartition({
    acceptedRows: 90,
    rejectedRows: 10,
    sourceUpdatedAtIso: "2026-07-31T09:00:00.000Z",
    observedAtIso: "2026-07-31T09:05:00.000Z",
    committedAtIso: "2026-07-31T09:06:00.000Z",
  });
  const before = buildPersistedFinopsSourceEvidence(
    evidenceInput(conn, [active]),
  );
  const duringCorrection = {
    ...active,
    currentPartitionDelivery: {
      sourceUpdatedAtIso: "2026-07-31T11:00:00.000Z",
      observedAtIso: "2026-07-31T11:05:00.000Z",
      acceptedRows: 0,
      rejectedRows: 0,
      status: "staging",
    },
  };
  const during = buildPersistedFinopsSourceEvidence(
    evidenceInput(conn, [duringCorrection]),
  );
  assert.deepEqual(during, before);
  assert.doesNotMatch(
    JSON.stringify(during),
    /2026-07-31T11:00:00\.000Z|2026-07-31T11:05:00\.000Z/u,
  );
});

test("latest failed collection emits a bounded generic failure rather than raw provider detail", () => {
  const conn = connection();
  const state = pilotState(conn, {
    latestRunCoverage: {
      syncRunId: "run_failed",
      entries: [{
        collectorKey: "ec2",
        region: "us-east-1",
        status: "failed",
        itemsObserved: 0,
        pagesObserved: 0,
        errorCode: "RAW_PROVIDER_CODE",
        message: "sensitive provider detail",
      }],
    },
    syncRuns: [{
      id: "run_failed",
      connectionId: scope.connectionId,
      status: "failed",
      coverageState: "unknown",
      totals: {},
      startedAt: "2026-07-31T11:00:00.000Z",
      finishedAt: "2026-07-31T11:01:00.000Z",
      createdAt: "2026-07-31T11:00:00.000Z",
    }],
  });
  const evidence = buildPersistedFinopsSourceEvidence(
    evidenceInput(conn, [], state),
  );
  const inventory = evidence.find((entry) => entry.sourceId === "data_collection_telemetry");
  assert.equal(inventory?.lastAttemptOutcome, "failed");
  assert.deepEqual(inventory?.lastError, {
    code: "COLLECTION_FAILED",
    message: "The latest AWS inventory collection failed.",
    at: "2026-07-31T11:01:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(inventory), /sensitive provider detail|RAW_PROVIDER_CODE/u);
});

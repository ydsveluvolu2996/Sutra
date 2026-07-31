import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_SUPPORT_CASES_COLLECTION_BOUNDS,
  AWS_SUPPORT_CASES_READ_OPERATIONS,
  AwsSupportCasesError,
  AwsSupportCasesQueryError,
  awsSupportCasesSourceEvidence,
  buildAwsSupportCasesRadar,
  createAwsSupportCasesQueryService,
  normalizeAwsSupportCasesCapture,
  type AwsSupportAccountCapture,
  type AwsSupportCasesBoundary,
  type AwsSupportCasesCapture,
  type AwsSupportCasePage,
  type AwsSupportCollectionWindow,
  type AwsSupportIntendedAccount,
} from "../lib/finops-aws-support-cases-radar.ts";

type DeepMutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T[Key] extends object
      ? DeepMutable<T[Key]>
      : T[Key];
};

const NOW = new Date("2026-07-31T12:05:00.000Z");
const ACCOUNT_A: AwsSupportIntendedAccount = {
  accountId: "123456789012",
  connectionId: `conn_${"a".repeat(32)}`,
};
const ACCOUNT_B: AwsSupportIntendedAccount = {
  accountId: "210987654321",
  connectionId: `conn_${"b".repeat(32)}`,
};
const BOUNDARY: AwsSupportCasesBoundary = {
  scope: {
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: `conn_${"c".repeat(32)}`,
    partition: "aws",
    endpointRegion: "us-east-1",
  },
  binding: "SERVER_RESOLVED_CONNECTIONS",
  intendedAccounts: [ACCOUNT_A, ACCOUNT_B],
};

function hash(character: string): string {
  return `hmac-sha256:${character.repeat(64)}`;
}

function initialWindow(): AwsSupportCollectionWindow {
  return {
    mode: "INITIAL",
    afterTime: "2026-07-01T00:00:00.000Z",
    beforeTime: "2026-07-31T12:00:00.000Z",
    priorWatermark: null,
    nextWatermark: "2026-07-31T12:00:00.000Z",
  };
}

function successAccount(
  intended: AwsSupportIntendedAccount,
  suffix: string,
): AwsSupportAccountCapture {
  const caseId = `case-${intended.accountId}-exen-2026-${suffix.repeat(12)}`;
  return {
    accountId: intended.accountId,
    connectionId: intended.connectionId,
    supportPlan: "enterprise",
    entitlementState: "QUALIFYING",
    readPermissionsValidated: true,
    startedAt: "2026-07-31T11:50:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    observedPeakConcurrency: 2,
    observedPeakRequestsPerSecond: 4,
    status: "SUCCEEDED",
    failureCode: null,
    casePages: [{
      request: {
        pageIndex: 0,
        cursorEvidenceHash: null,
        afterTime: "2026-07-01T00:00:00.000Z",
        beforeTime: "2026-07-31T12:00:00.000Z",
        caseIdList: null,
        displayId: null,
        includeCommunications: false,
        includeResolvedCases: true,
        language: null,
        maxResults: 100,
      },
      response: {
        cases: [{
          caseId,
          displayId: suffix === "d" ? "1001" : "1002",
          categoryCode: suffix === "d" ? "performance" : "security",
          language: "en",
          serviceCode: suffix === "d" ? "amazon-ec2" : "amazon-s3",
          severityCode: suffix === "d" ? "high" : "normal",
          status: suffix === "d"
            ? "pending-customer-action"
            : "work-in-progress",
          createdAt: "2026-07-10T08:00:00.000Z",
          submittedByKind: "CUSTOMER",
          ccRecipientCount: 2,
          subjectBytes: 72,
          subjectEvidenceHash: hash(suffix),
          contactEvidenceHash: hash(suffix === "d" ? "e" : "f"),
          metadataEvidenceHash: hash(suffix === "d" ? "1" : "2"),
          recentCommunicationsOmitted: true,
        }],
        nextCursorEvidenceHash: null,
      },
    }],
    casesExhausted: true,
    communications: [{
      caseId,
      status: "SUCCEEDED",
      pages: [{
        request: {
          pageIndex: 0,
          cursorEvidenceHash: null,
          caseId,
          afterTime: "2026-07-01T00:00:00.000Z",
          beforeTime: "2026-07-31T12:00:00.000Z",
          maxResults: 100,
        },
        response: {
          communications: [{
            caseId,
            createdAt: "2026-07-11T08:00:00.000Z",
            submittedByKind: "AWS",
            bodyBytes: 480,
            bodyEvidenceHash: hash(suffix === "d" ? "3" : "4"),
            submitterEvidenceHash: hash(suffix === "d" ? "5" : "6"),
            attachmentCount: suffix === "d" ? 1 : 0,
            attachmentEvidenceHash: hash(suffix === "d" ? "7" : "8"),
            metadataEvidenceHash: hash(suffix === "d" ? "9" : "0"),
          }],
          nextCursorEvidenceHash: null,
        },
      }],
      exhausted: true,
      failureCode: null,
    }],
  };
}

function capture(): DeepMutable<AwsSupportCasesCapture> {
  return structuredClone({
    schemaVersion: "sutra.aws-support-cases.capture.v1",
    scope: BOUNDARY.scope,
    captureId: `support_${"a".repeat(64)}`,
    startedAt: "2026-07-31T11:45:00.000Z",
    completedAt: "2026-07-31T12:00:00.000Z",
    window: initialWindow(),
    intendedAccounts: BOUNDARY.intendedAccounts,
    accounts: [successAccount(ACCOUNT_A, "d"), successAccount(ACCOUNT_B, "e")],
  }) as DeepMutable<AwsSupportCasesCapture>;
}

test("declares the exact two account-local read permissions and provider bounds", () => {
  assert.deepEqual(AWS_SUPPORT_CASES_READ_OPERATIONS, [
    "support:DescribeCases",
    "support:DescribeCommunications",
  ]);
  assert.equal(AWS_SUPPORT_CASES_COLLECTION_BOUNDS.casePageSize, 100);
  assert.equal(AWS_SUPPORT_CASES_COLLECTION_BOUNDS.communicationPageSize, 100);
  assert.equal(AWS_SUPPORT_CASES_COLLECTION_BOUNDS.providerQuotaRequestsPerSecond, 5);
  assert.ok(
    AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumRequestsPerSecondPerAccount
      < AWS_SUPPORT_CASES_COLLECTION_BOUNDS.providerQuotaRequestsPerSecond,
  );
});

test("normalizes exhaustive multi-account metadata and hash-only communication evidence", () => {
  const snapshot = normalizeAwsSupportCasesCapture(
    capture(),
    BOUNDARY,
    NOW.getTime(),
  );
  assert.equal(snapshot.configurationState, "ready");
  assert.equal(snapshot.collectionState, "complete");
  assert.equal(snapshot.accountCoverage.length, 2);
  assert.ok(snapshot.accountCoverage.every((account) => account.status === "complete"));
  assert.equal(snapshot.cases.length, 2);
  assert.equal(snapshot.cases[0]?.communicationCount, 1);
  assert.equal(snapshot.cases[0]?.attachmentCount, 1);
  assert.equal(snapshot.cases[0]?.updatedAt, "2026-07-11T08:00:00.000Z");
  assert.equal(snapshot.cases[0]?.resolvedObservedAt, null);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "subject\"",
    "body\"",
    "submittedBy\"",
    "ccEmailAddresses",
    "attachmentId",
    "fileName",
    "nextToken",
    "providerMessage",
  ]) assert.equal(serialized.includes(forbidden), false);

  const evidence = awsSupportCasesSourceEvidence(snapshot);
  assert.equal(evidence.coverage.assessment, "complete");
  assert.equal(evidence.coverage.acceptedRecords, 2);
  assert.equal(evidence.coverage.expectedRecords, 2);
  assert.equal(evidence.dataThroughAt, snapshot.window.nextWatermark);
  assert.match(evidence.evidenceBasis, /account-local/u);
});

test("fails closed on tenant, partition, intended-account, or connection substitution", () => {
  const candidates: AwsSupportCasesBoundary[] = [
    { ...BOUNDARY, scope: { ...BOUNDARY.scope, orgId: "org_attacker" } },
    {
      ...BOUNDARY,
      scope: {
        ...BOUNDARY.scope,
        partition: "aws-us-gov",
        endpointRegion: "us-gov-west-1",
      },
    },
    { ...BOUNDARY, intendedAccounts: [ACCOUNT_A] },
    {
      ...BOUNDARY,
      intendedAccounts: [
        { ...ACCOUNT_A, connectionId: `conn_${"f".repeat(32)}` },
        ACCOUNT_B,
      ],
    },
  ];
  for (const boundary of candidates) {
    assert.throws(
      () => normalizeAwsSupportCasesCapture(capture(), boundary, NOW.getTime()),
      (error) => error instanceof AwsSupportCasesError,
    );
  }
});

test("rejects raw subjects, bodies, contact fields, attachment metadata, and provider messages", () => {
  const mutations = [
    (value: DeepMutable<AwsSupportCasesCapture>) => {
      Object.assign(
        value.accounts[0]!.casePages[0]!.response.cases[0]!,
        { subject: "contains a secret" },
      );
    },
    (value: DeepMutable<AwsSupportCasesCapture>) => {
      Object.assign(
        value.accounts[0]!.communications[0]!.pages[0]!.response.communications[0]!,
        { body: "private correspondence" },
      );
    },
    (value: DeepMutable<AwsSupportCasesCapture>) => {
      Object.assign(value.accounts[0]!, {
        providerMessage: "Access denied for arn:aws:iam::secret",
      });
    },
    (value: DeepMutable<AwsSupportCasesCapture>) => {
      Object.assign(
        value.accounts[0]!.communications[0]!.pages[0]!.response.communications[0]!,
        { attachmentSet: [{ attachmentId: "secret", fileName: "secret.pem" }] },
      );
    },
  ];
  for (const mutate of mutations) {
    const candidate = capture();
    mutate(candidate);
    assert.throws(
      () => normalizeAwsSupportCasesCapture(candidate, BOUNDARY, NOW.getTime()),
      (error) => error instanceof AwsSupportCasesError,
    );
  }

  const persisted = structuredClone(normalizeAwsSupportCasesCapture(
    capture(),
    BOUNDARY,
    NOW.getTime(),
  ));
  Object.assign(persisted.cases[0]!, { subject: "persisted secret" });
  assert.throws(
    () => buildAwsSupportCasesRadar({
      snapshots: [persisted],
      boundary: BOUNDARY,
      nowMs: NOW.getTime(),
    }),
    (error) =>
      error instanceof AwsSupportCasesError
      && error.code === "UNSAFE_CONTENT",
  );
  assert.throws(
    () => awsSupportCasesSourceEvidence(persisted),
    (error) =>
      error instanceof AwsSupportCasesError
      && error.code === "UNSAFE_CONTENT",
  );
});

test("rejects pagination replay, conflicting duplicates, and incomplete drilldowns", () => {
  const replay = capture();
  const page = replay.accounts[0]!.casePages[0]!;
  page.response.nextCursorEvidenceHash = hash("a");
  (replay.accounts[0]!.casePages as DeepMutable<AwsSupportCasePage>[]).push({
    request: { ...page.request, pageIndex: 1, cursorEvidenceHash: hash("a") },
    response: { cases: [], nextCursorEvidenceHash: hash("a") },
  });
  replay.accounts[0]!.casesExhausted = false;
  assert.throws(
    () => normalizeAwsSupportCasesCapture(replay, BOUNDARY, NOW.getTime()),
    (error) =>
      error instanceof AwsSupportCasesError
      && error.code === "INVALID_PAGINATION",
  );

  const conflict = capture();
  const duplicate = structuredClone(
    conflict.accounts[0]!.casePages[0]!.response.cases[0]!,
  );
  duplicate.status = "resolved";
  conflict.accounts[0]!.casePages[0]!.response.cases.push(duplicate);
  assert.throws(
    () => normalizeAwsSupportCasesCapture(conflict, BOUNDARY, NOW.getTime()),
    (error) =>
      error instanceof AwsSupportCasesError
      && error.code === "CONFLICTING_DUPLICATE",
  );

  const missing = capture();
  missing.accounts[0]!.communications = [];
  assert.throws(
    () => normalizeAwsSupportCasesCapture(missing, BOUNDARY, NOW.getTime()),
    (error) =>
      error instanceof AwsSupportCasesError
      && error.code === "INCOMPLETE_DRILLDOWN",
  );
});

test("reports explicit unavailable and partial account coverage without an organization claim", () => {
  const candidate = capture();
  candidate.accounts[1] = {
    accountId: ACCOUNT_B.accountId,
    connectionId: ACCOUNT_B.connectionId,
    supportPlan: "basic",
    entitlementState: "NOT_QUALIFYING",
    readPermissionsValidated: false,
    startedAt: "2026-07-31T11:50:00.000Z",
    completedAt: "2026-07-31T11:51:00.000Z",
    observedPeakConcurrency: 0,
    observedPeakRequestsPerSecond: 0,
    status: "FAILED",
    failureCode: "SUBSCRIPTION_REQUIRED",
    casePages: [],
    casesExhausted: false,
    communications: [],
  };
  const snapshot = normalizeAwsSupportCasesCapture(
    candidate,
    BOUNDARY,
    NOW.getTime(),
  );
  assert.equal(snapshot.configurationState, "partial");
  assert.equal(snapshot.collectionState, "partial");
  assert.equal(snapshot.accountCoverage[1]?.status, "unavailable");
  const evidence = awsSupportCasesSourceEvidence(snapshot);
  assert.equal(evidence.coverage.assessment, "partial");
  assert.equal(evidence.coverage.rejectedRecords, 1);
  assert.equal(evidence.lastError?.message, "AWS Support account coverage is incomplete.");

  const dashboard = buildAwsSupportCasesRadar({
    snapshots: [snapshot],
    boundary: BOUNDARY,
    nowMs: NOW.getTime(),
  });
  assert.equal(dashboard.source.organizationCoverageClaimed, false);
  assert.equal(dashboard.summary.intendedAccountCount, 2);
  assert.equal(dashboard.summary.completeAccountCount, 1);
  assert.match(dashboard.disclosure, /account-by-account/u);
});

test("replays bounded initial and incremental history with observed resolution semantics", () => {
  const initial = normalizeAwsSupportCasesCapture(
    capture(),
    BOUNDARY,
    NOW.getTime(),
  );
  const incremental = capture();
  incremental.captureId = `support_${"b".repeat(64)}`;
  incremental.startedAt = "2026-08-01T11:50:00.000Z";
  incremental.completedAt = "2026-08-01T12:00:00.000Z";
  incremental.window = {
    mode: "INCREMENTAL",
    afterTime: "2026-07-30T12:00:00.000Z",
    beforeTime: "2026-08-01T12:00:00.000Z",
    priorWatermark: "2026-07-31T12:00:00.000Z",
    nextWatermark: "2026-08-01T12:00:00.000Z",
  };
  for (const account of incremental.accounts) {
    account.startedAt = "2026-08-01T11:50:00.000Z";
    account.completedAt = "2026-08-01T12:00:00.000Z";
    for (const page of account.casePages) {
      page.request.afterTime = incremental.window.afterTime;
      page.request.beforeTime = incremental.window.beforeTime;
    }
    for (const sequence of account.communications) {
      for (const page of sequence.pages) {
        page.request.afterTime = incremental.window.afterTime;
        page.request.beforeTime = incremental.window.beforeTime;
        page.response.communications = [];
      }
    }
  }
  incremental.accounts[0]!.casePages[0]!.response.cases[0]!.status = "resolved";
  incremental.accounts[0]!.casePages[0]!.response.cases[0]!.metadataEvidenceHash = hash("f");
  const corrected = normalizeAwsSupportCasesCapture(
    incremental,
    BOUNDARY,
    new Date("2026-08-01T12:05:00.000Z").getTime(),
  );
  const dashboard = buildAwsSupportCasesRadar({
    snapshots: [corrected, initial],
    boundary: BOUNDARY,
    options: {
      status: "resolved",
      includeSafeSummaries: true,
      caseLimit: 10,
    },
    nowMs: new Date("2026-08-01T12:10:00.000Z").getTime(),
  });
  assert.equal(dashboard.source.historyCoverage, "observed_snapshots_only");
  assert.equal(dashboard.source.watermarkCoverage, "continuous");
  assert.equal(dashboard.summary.caseCount, 1);
  assert.equal(dashboard.cases[0]?.firstObservedAt, initial.observedAt);
  assert.equal(dashboard.cases[0]?.resolvedObservedAt, corrected.observedAt);
  assert.equal(dashboard.cases[0]?.communicationCount, 1);
  assert.match(dashboard.cases[0]?.safeSummary?.synopsis ?? "", /amazon-ec2/u);
  assert.match(
    dashboard.cases[0]?.safeSummary?.disclosure ?? "",
    /no subject or communication text/u,
  );
});

test("marks stale dashboards and validates account and metadata filters", () => {
  const snapshot = normalizeAwsSupportCasesCapture(
    capture(),
    BOUNDARY,
    NOW.getTime(),
  );
  const dashboard = buildAwsSupportCasesRadar({
    snapshots: [snapshot],
    boundary: BOUNDARY,
    options: {
      accountId: ACCOUNT_B.accountId,
      serviceCode: "amazon-s3",
      severity: "normal",
      caseLimit: 1,
    },
    nowMs: new Date("2026-08-03T13:00:00.000Z").getTime(),
  });
  assert.equal(dashboard.source.freshness, "stale");
  assert.equal(dashboard.cases.length, 1);
  assert.equal(dashboard.cases[0]?.accountId, ACCOUNT_B.accountId);
  assert.equal(dashboard.summary.serviceCounts[0]?.code, "amazon-s3");
  assert.throws(
    () => buildAwsSupportCasesRadar({
      snapshots: [snapshot],
      boundary: BOUNDARY,
      options: { accountId: "999999999999" },
      nowMs: NOW.getTime(),
    }),
    (error) => error instanceof AwsSupportCasesError,
  );
});

test("query service pins scope, accounts, sanitization, rates, and generic failures", async () => {
  let request: unknown;
  const service = createAwsSupportCasesQueryService(
    BOUNDARY,
    {
      async collect(value) {
        request = value;
        return capture();
      },
    },
    {
      now: () => NOW,
      createJobId: () => `supportjob_${"a".repeat(32)}`,
    },
  );
  await service.query(initialWindow());
  assert.deepEqual(
    (request as { intendedAccounts: unknown }).intendedAccounts,
    BOUNDARY.intendedAccounts,
  );
  assert.equal((request as { includeRawCommunications: unknown }).includeRawCommunications, false);
  assert.equal((request as { includeContactIdentifiers: unknown }).includeContactIdentifiers, false);
  assert.equal((request as { includeRawPaginationTokens: unknown }).includeRawPaginationTokens, false);
  assert.equal(
    (request as { limits: { maximumRequestsPerSecondPerAccount: unknown } })
      .limits.maximumRequestsPerSecondPerAccount,
    4,
  );

  const failing = createAwsSupportCasesQueryService(
    BOUNDARY,
    { collect: async () => { throw new Error("provider secret"); } },
    {
      now: () => NOW,
      createJobId: () => `supportjob_${"b".repeat(32)}`,
    },
  );
  await assert.rejects(
    () => failing.query(initialWindow()),
    (error) =>
      error instanceof AwsSupportCasesQueryError
      && error.code === "COLLECTION_FAILED"
      && !error.message.includes("provider secret"),
  );

  const invalid = createAwsSupportCasesQueryService(
    BOUNDARY,
    { collect: async () => ({ raw: "body" }) },
    {
      now: () => NOW,
      createJobId: () => `supportjob_${"c".repeat(32)}`,
    },
  );
  await assert.rejects(
    () => invalid.query(initialWindow()),
    (error) =>
      error instanceof AwsSupportCasesQueryError
      && error.code === "INVALID_EVIDENCE",
  );
});

test("rejects unsafe windows, future evidence, rate overflow, and raw tokens", () => {
  const candidates = [capture(), capture(), capture(), capture()];
  candidates[0]!.window = {
    mode: "INCREMENTAL",
    afterTime: "2026-06-01T00:00:00.000Z",
    beforeTime: "2026-07-31T12:00:00.000Z",
    priorWatermark: "2026-07-30T12:00:00.000Z",
    nextWatermark: "2026-07-31T12:00:00.000Z",
  };
  candidates[1]!.accounts[0]!.observedPeakRequestsPerSecond = 5;
  candidates[2]!.accounts[0]!.communications[0]!.pages[0]!
    .response.communications[0]!.createdAt = "2026-08-02T00:00:00.000Z";
  Object.assign(candidates[3]!.accounts[0]!.casePages[0]!.request, {
    nextToken: "raw-provider-token",
  });
  for (const candidate of candidates) {
    assert.throws(
      () => normalizeAwsSupportCasesCapture(candidate, BOUNDARY, NOW.getTime()),
      (error) => error instanceof AwsSupportCasesError,
    );
  }
});

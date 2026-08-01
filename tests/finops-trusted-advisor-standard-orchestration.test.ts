import assert from "node:assert/strict";
import test from "node:test";

import {
  FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND,
  TRUSTED_ADVISOR_ORGANIZATIONS_ADAPTER_ACTIVATION_REASON,
  TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS,
  TRUSTED_ADVISOR_STANDARD_CONTRACT_ID,
  TRUSTED_ADVISOR_STANDARD_REGION,
  TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
  TrustedAdvisorStandardOrchestrationError,
  runTrustedAdvisorAccountCollectionJob,
  runTrustedAdvisorManifestFinalizeJob,
  runTrustedAdvisorOrganizationActivationJob,
  trustedAdvisorTaxonomyContentSha256,
  type TrustedAdvisorManifestPort,
  type TrustedAdvisorOrganizationsTaxonomyCapture,
} from "../lib/finops-trusted-advisor-standard-orchestration.ts";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import type {
  StoredTrustedAdvisorManifest,
} from "../db/finops-trusted-advisor-organization-repository.ts";

const ORG = "org_ta_orchestrator";
const CUSTOMER = "customer_ta_orchestrator";
const ANCHOR = `conn_${"a".repeat(32)}`;
const TARGET = `conn_${"b".repeat(32)}`;
const ACCOUNT = "111122223333";
const MISSING = "222233334444";
const SUSPENDED = "333344445555";
const MANIFEST_ID = `tam_${"c".repeat(64)}`;
const SCOPE = { organizationId: ORG, customerId: CUSTOMER, connectionId: ANCHOR };
const SIGNER = "arn:aws:kms:us-east-1:111122223333:key/taxonomy-signer";
const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function connection(connectionId: string, awsAccountId: string) {
  return {
    organizationId: ORG,
    customerId: CUSTOMER,
    connectionId,
    awsAccountId,
    partition: "aws" as const,
    sourceKind: "aws_trust_role",
    status: "active",
  };
}

function job(input: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: "job_ta_orchestration_1",
    orgId: ORG,
    customerId: CUSTOMER,
    connectionId: ANCHOR,
    kind: FINOPS_TA_ORGANIZATION_ACTIVATE_JOB_KIND,
    payload: { connectionId: ANCHOR },
    attempt: 1,
    maxAttempts: 6,
    ...input,
  };
}

function manifest(
  accounts: StoredTrustedAdvisorManifest["accounts"],
  status: StoredTrustedAdvisorManifest["status"] = "collecting",
): StoredTrustedAdvisorManifest {
  return {
    scope: SCOPE,
    manifestId: MANIFEST_ID,
    jobId: "job_ta_orchestration_1",
    taxonomySnapshotId: `orgtax_${"d".repeat(64)}`,
    taxonomySha256: "d".repeat(64),
    accountSetSha256: "e".repeat(64),
    expectedAccountCount: accounts.length,
    status,
    createdAtIso: "2026-08-01T11:55:00.000Z",
    startedAtIso: status === "pending" ? null : "2026-08-01T11:56:00.000Z",
    finalizedAtIso: new Set(["complete", "partial", "failed"]).has(status)
      ? "2026-08-01T12:01:00.000Z"
      : null,
    accounts,
  };
}

async function signedTaxonomy(): Promise<TrustedAdvisorOrganizationsTaxonomyCapture> {
  const unsigned = {
    schemaVersion: "sutra.aws-organizations-taxonomy.signed.v1" as const,
    scope: SCOPE,
    partition: "aws" as const,
    managementAccountId: ACCOUNT,
    awsOrganizationId: "o-123456789abc",
    collectedAtIso: "2026-08-01T11:50:00.000Z",
    pagesExhausted: true as const,
    operations: TRUSTED_ADVISOR_ORGANIZATIONS_TAXONOMY_OPERATIONS,
    accounts: [
      { accountId: SUSPENDED, state: "SUSPENDED" as const },
      { accountId: ACCOUNT, state: "ACTIVE" as const },
      { accountId: MISSING, state: "ACTIVE" as const },
    ],
  };
  return {
    ...unsigned,
    contentSha256: await trustedAdvisorTaxonomyContentSha256({
      ...unsigned,
      accounts: [...unsigned.accounts].sort((left, right) =>
        left.accountId.localeCompare(right.accountId)),
    }),
    signature: {
      algorithm: "AWS_KMS_RSASSA_PSS_SHA_256",
      signerKeyId: SIGNER,
      value: "S".repeat(64),
    },
  };
}

function memoryRepository(initial: StoredTrustedAdvisorManifest | null = null) {
  let stored = initial;
  const recorded: unknown[] = [];
  const finalized: string[] = [];
  const port: TrustedAdvisorManifestPort = {
    async createManifest(scope, input) {
      assert.deepEqual(scope, SCOPE);
      stored = manifest(input.accounts.map((account, accountPosition) => ({
        ...account,
        accountPosition,
        status: "pending" as const,
        accountSnapshotId: null,
        errorCode: null,
      })), "pending");
      return stored;
    },
    async startManifest() {
      assert.ok(stored);
      stored = { ...stored, status: "collecting", startedAtIso: "2026-08-01T12:00:00.000Z" };
      return stored;
    },
    async getManifest() {
      return stored;
    },
    async startAccount(_scope, _manifestId, accountId) {
      assert.ok(stored);
      stored = {
        ...stored,
        accounts: stored.accounts.map((account) => account.accountId === accountId
          ? { ...account, status: "running" as const }
          : account),
      };
    },
    async markAccountUnavailable(_scope, _manifestId, accountId, status, errorCode) {
      assert.ok(stored);
      stored = {
        ...stored,
        accounts: stored.accounts.map((account) => account.accountId === accountId
          ? { ...account, status, errorCode }
          : account),
      };
    },
    async recordAccountSnapshot(_scope, _manifestId, input) {
      recorded.push(input);
      assert.ok(stored);
      stored = {
        ...stored,
        accounts: stored.accounts.map((account) => account.accountId === input.accountId
          ? {
              ...account,
              status: input.status === "complete" ? "accepted" as const : "partial" as const,
              accountSnapshotId: `tas_${"f".repeat(64)}`,
            }
          : account),
      };
      return `tas_${"f".repeat(64)}`;
    },
    async finalizeManifest(_scope, manifestId) {
      finalized.push(manifestId);
      return { manifestId };
    },
  };
  return { port, get: () => stored, recorded, finalized };
}

function expectCode(code: TrustedAdvisorStandardOrchestrationError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof TrustedAdvisorStandardOrchestrationError);
    assert.equal(error.code, code);
    return true;
  };
}

test("freezes only signed Organizations evidence and queues manifest-bound active accounts", async () => {
  const database = memoryRepository();
  const queueCalls: Array<Readonly<Record<string, unknown>>> = [];
  const capture = await signedTaxonomy();
  const result = await runTrustedAdvisorOrganizationActivationJob(job(), {
    repository: database.port,
    queue: {
      async enqueue(input) {
        queueCalls.push(input);
        return { id: `job_${String(queueCalls.length).padStart(32, "0")}` };
      },
    },
    getAnchorConnection: async () => connection(ANCHOR, ACCOUNT),
    listCustomerConnections: async () => [connection(ANCHOR, ACCOUNT)],
    collectSignedTaxonomy: async (request) => {
      assert.deepEqual(request.operations, [
        "organizations:DescribeOrganization",
        "organizations:ListAccounts",
      ]);
      return capture;
    },
    verifyTaxonomySignature: async (request) => {
      assert.equal(request.signerKeyId, SIGNER);
      assert.equal(request.algorithm, "AWS_KMS_RSASSA_PSS_SHA_256");
      return true;
    },
    expectedSignerKeyId: SIGNER,
    now: () => NOW,
  });
  assert.equal(result.accountJobIds.length, 1);
  assert.ok(result.finalizerJobId);
  assert.equal(queueCalls[0]?.kind, "finops-ta-account-collect");
  assert.deepEqual(queueCalls[0]?.payload, {
    manifestId: MANIFEST_ID,
    accountId: ACCOUNT,
    connectionId: ANCHOR,
  });
  assert.equal(queueCalls[1]?.kind, "finops-ta-manifest-finalize");
  assert.equal(JSON.stringify(queueCalls).includes("trusted_advisor_organization"), false);
  assert.deepEqual(database.get()?.accounts.map((entry) => [entry.accountId, entry.status, entry.errorCode]), [
    [ACCOUNT, "pending", null],
    [MISSING, "unconfigured", "ACCOUNT_CONNECTION_MISSING"],
    [SUSPENDED, "unconfigured", "AWS_ACCOUNT_NOT_ACTIVE"],
  ]);
  assert.equal(
    TRUSTED_ADVISOR_ORGANIZATIONS_ADAPTER_ACTIVATION_REASON,
    "AWS_ORGANIZATIONS_SIGNED_TAXONOMY_ADAPTER_NOT_REGISTERED",
  );
});

test("rejects unsigned, stale, cross-tenant, or hash-conflicting taxonomy before persistence", async () => {
  const base = await signedTaxonomy();
  for (const mutation of [
    { ...base, contentSha256: "0".repeat(64) },
    { ...base, scope: { ...base.scope, organizationId: "org_other" } },
    { ...base, collectedAtIso: "2026-07-20T00:00:00.000Z" },
    { ...base, signature: { ...base.signature, signerKeyId: "untrusted-signer" } },
    { ...base, browserAccounts: ["999900001111"] },
  ]) {
    let created = false;
    await assert.rejects(runTrustedAdvisorOrganizationActivationJob(job(), {
      repository: {
        ...memoryRepository().port,
        async createManifest(...args) {
          created = true;
          return memoryRepository().port.createManifest(...args);
        },
      },
      queue: { enqueue: async () => ({ id: `job_${"0".repeat(32)}` }) },
      getAnchorConnection: async () => connection(ANCHOR, ACCOUNT),
      listCustomerConnections: async () => [connection(ANCHOR, ACCOUNT)],
      collectSignedTaxonomy: async () => mutation,
      verifyTaxonomySignature: async () => true,
      expectedSignerKeyId: SIGNER,
      now: () => NOW,
    }), expectCode("TAXONOMY_REJECTED"));
    assert.equal(created, false);
  }
});

async function standardEvidence(input: {
  accountId?: string;
  sourceId?: string;
  collectionStatus?: "COMPLETE" | "PARTIAL";
} = {}) {
  const collectedAt = "2026-08-01T12:00:00.000Z";
  const dataThroughAt = "2026-08-01T11:45:00.000Z";
  const body = new TextEncoder().encode(JSON.stringify({
    schemaVersion: "sutra.finops-source-evidence.v2",
    sourceId: input.sourceId ?? TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
    contractId: TRUSTED_ADVISOR_STANDARD_CONTRACT_ID,
    collectionStatus: input.collectionStatus ?? "COMPLETE",
    accountId: input.accountId ?? ACCOUNT,
    partition: "aws",
    region: TRUSTED_ADVISOR_STANDARD_REGION,
    collectedAt,
    dataThroughAt,
    coverage: {
      recordsObserved: 2,
      recordsAccepted: 2,
      recordsRejected: 0,
      recordsOmitted: 0,
    },
    evidence: {
      schemaVersion: "sutra.aws-trusted-advisor-standard-checks.v1",
      source: "AWS_SUPPORT_TRUSTED_ADVISOR_STANDARD_CHECKS",
      checks: [{
        checkId: "check-1",
        name: "Idle load balancers",
        category: "cost_optimizing",
        status: "warning",
        dataThroughAt,
        resourcesSummary: { processed: 1, flagged: 1, ignored: 0, suppressed: 0 },
        flaggedResources: [{
          resourceId: "elb-prod",
          region: "us-east-1",
          status: "warning",
          suppressed: false,
          metadata: [{ name: "service", value: "elb" }],
        }],
      }],
    },
    limitations: [],
  }));
  const digest = await crypto.subtle.digest("SHA-256", body);
  const contentSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    snapshot: {
      scope: { ...SCOPE, connectionId: TARGET },
      sourceId: TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
      generationId: `fss_${"9".repeat(64)}`,
      jobId: "job_ta_account_1",
      attempt: 1,
      status: (input.collectionStatus ?? "COMPLETE") === "COMPLETE"
        ? "complete" as const
        : "partial" as const,
      contentSha256,
      schemaVersion: "sutra.finops-source-evidence.v2" as const,
      collectedAtIso: collectedAt,
      dataThroughAtIso: dataThroughAt,
      evidenceReference: {
        ciphertext: `fsev1.${"A".repeat(40)}`,
        keyVersion: "ta-standard-v1",
      },
    },
    verifiedBody: body,
  };
}

function accountManifest(status: "pending" | "running" | "accepted" = "pending") {
  return manifest([{
    accountId: ACCOUNT,
    accountPosition: 0,
    targetConnectionId: TARGET,
    status,
    accountSnapshotId: status === "accepted" ? `tas_${"f".repeat(64)}` : null,
    errorCode: null,
  }]);
}

function accountJob(): RunnableJob {
  return job({
    id: "job_ta_account_1",
    connectionId: TARGET,
    kind: "finops-ta-account-collect",
    payload: { manifestId: MANIFEST_ID, accountId: ACCOUNT, connectionId: TARGET },
  });
}

test("consumes only the exact completed standard-check artifact and seals account lineage", async () => {
  const database = memoryRepository(accountManifest());
  let request: unknown;
  const result = await runTrustedAdvisorAccountCollectionJob(accountJob(), {
    repository: database.port,
    findManifest: async () => database.get(),
    collectCompletedStandardChecks: async (value) => {
      request = value;
      return standardEvidence();
    },
    now: () => NOW,
  });
  assert.deepEqual(request, {
    organizationId: ORG,
    customerId: CUSTOMER,
    connectionId: TARGET,
    accountId: ACCOUNT,
    sourceId: TRUSTED_ADVISOR_STANDARD_SOURCE_ID,
    contractId: TRUSTED_ADVISOR_STANDARD_CONTRACT_ID,
    region: TRUSTED_ADVISOR_STANDARD_REGION,
    orchestrationJobId: "job_ta_account_1",
    attempt: 1,
  });
  assert.equal(result.status, "accepted");
  assert.equal(database.recorded.length, 1);
  const recorded = database.recorded[0] as Record<string, unknown>;
  assert.equal(recorded.accountId, ACCOUNT);
  assert.equal(recorded.status, "complete");
  assert.deepEqual(recorded.evidenceReference, {
    ciphertext: `fsev1.${"A".repeat(40)}`,
    keyVersion: "ta-standard-v1",
  });
  assert.equal((recorded.checks as unknown[]).length, 1);
  assert.equal((recorded.resources as unknown[]).length, 1);

  const replayDatabase = memoryRepository(accountManifest("accepted"));
  let collected = false;
  assert.deepEqual(await runTrustedAdvisorAccountCollectionJob(accountJob(), {
    repository: replayDatabase.port,
    findManifest: async () => replayDatabase.get(),
    collectCompletedStandardChecks: async () => {
      collected = true;
      return standardEvidence();
    },
  }), { status: "replayed" });
  assert.equal(collected, false);
});

test("marks provider failure and mismatched evidence honestly without accepting a snapshot", async () => {
  const providerFailure = memoryRepository(accountManifest());
  assert.deepEqual(await runTrustedAdvisorAccountCollectionJob(accountJob(), {
    repository: providerFailure.port,
    findManifest: async () => providerFailure.get(),
    collectCompletedStandardChecks: async () => {
      throw new Error("raw provider detail must not persist");
    },
    now: () => NOW,
  }), { status: "failed" });
  assert.deepEqual(providerFailure.get()?.accounts.map((entry) => [entry.status, entry.errorCode]), [
    ["failed", "STANDARD_CHECK_COLLECTION_FAILED"],
  ]);

  const mismatch = memoryRepository(accountManifest());
  assert.deepEqual(await runTrustedAdvisorAccountCollectionJob(accountJob(), {
    repository: mismatch.port,
    findManifest: async () => mismatch.get(),
    collectCompletedStandardChecks: async () => standardEvidence({ accountId: "999900001111" }),
    now: () => NOW,
  }), { status: "failed" });
  assert.equal(mismatch.recorded.length, 0);
  assert.deepEqual(mismatch.get()?.accounts.map((entry) => [entry.status, entry.errorCode]), [
    ["failed", "STANDARD_CHECK_EVIDENCE_REJECTED"],
  ]);
});

test("finalization rejects non-terminal manifests and is replay-safe for terminal members", async () => {
  const pending = memoryRepository(accountManifest("pending"));
  const finalizeJob = job({
    kind: "finops-ta-manifest-finalize",
    payload: { manifestId: MANIFEST_ID, connectionId: ANCHOR },
  });
  await assert.rejects(runTrustedAdvisorManifestFinalizeJob(finalizeJob, {
    repository: pending.port,
    findManifest: async () => pending.get(),
    now: () => NOW,
  }), expectCode("NOT_TERMINAL"));
  assert.equal(pending.finalized.length, 0);

  const terminal = memoryRepository(accountManifest("accepted"));
  assert.deepEqual(await runTrustedAdvisorManifestFinalizeJob(finalizeJob, {
    repository: terminal.port,
    findManifest: async () => terminal.get(),
    now: () => NOW,
  }), { manifestId: MANIFEST_ID });
  assert.deepEqual(terminal.finalized, [MANIFEST_ID]);
});

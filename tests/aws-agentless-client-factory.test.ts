import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentlessClientFactoryError,
  createAgentlessClientFactories,
  type AgentlessScanAccountAssumeInput,
  type AgentlessSessionBroker,
} from "../lib/aws-agentless-client-factory.ts";
import type { AwsTemporaryCredentials } from "../services/aws-collector/src/types.ts";

const SCAN_ACCOUNT = "738663485493";
const ORCHESTRATOR = `arn:aws:iam::${SCAN_ACCOUNT}:role/sutra/SutraAgentlessOrchestrator`;
const SCOPE = { orgId: "org_1", customerId: "cust_1" };
const RUN_ID = "scan_01HXYZABCDEF";

const credentials = (label: string): AwsTemporaryCredentials => ({
  accessKeyId: `AKIA_${label}`,
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: new Date("2026-07-29T13:00:00Z"),
});

interface Recorder {
  readonly brokerCalls: { connectionId: string; jobId: string }[];
  readonly scanAssumes: { roleArn: string; roleSessionName: string }[];
  readonly clients: { label: string; region: string }[];
}

function factories(overrides: Record<string, unknown> = {}) {
  const rec: Recorder = { brokerCalls: [], scanAssumes: [], clients: [] };
  const broker: AgentlessSessionBroker = {
    assumeAgentlessSession: async (_scope, connectionId, jobId) => {
      rec.brokerCalls.push({ connectionId, jobId });
      return { credentials: credentials("CUSTOMER") };
    },
  };
  const built = createAgentlessClientFactories<string>({
    broker,
    scope: SCOPE,
    connectionId: "conn_1",
    orchestratorRoleArn: ORCHESTRATOR,
    scanAccountId: SCAN_ACCOUNT,
    runId: RUN_ID,
    assumeScanAccountRole: async (input: AgentlessScanAccountAssumeInput) => {
      rec.scanAssumes.push({ roleArn: input.roleArn, roleSessionName: input.runId });
      return credentials("SCAN");
    },
    ec2ClientFor: (creds: AwsTemporaryCredentials, region: string) => {
      const label = creds.accessKeyId.replace("AKIA_", "");
      rec.clients.push({ label, region });
      return `${label}:${region}`;
    },
    ...overrides,
  } as never);
  return { rec, built };
}

test("the customer client comes from the broker, which owns the encrypted external id", async () => {
  const { rec, built } = factories();
  const client = await built.customerClientFor("ap-south-1");
  assert.equal(client, "CUSTOMER:ap-south-1");
  // The broker is called with the run id as the job id, so CloudTrail on the
  // customer side correlates to this scan.
  assert.deepEqual(rec.brokerCalls, [{ connectionId: "conn_1", jobId: RUN_ID }]);
  // Nothing assumed the scan-account role for a customer call.
  assert.equal(rec.scanAssumes.length, 0);
});

test("the scan client assumes the orchestrator role and never touches the broker", async () => {
  const { rec, built } = factories();
  const client = await built.scanClientFor("ap-south-1");
  assert.equal(client, "SCAN:ap-south-1");
  assert.equal(rec.brokerCalls.length, 0, "the scan account is Sutra's own; the broker is for customers");
  assert.equal(rec.scanAssumes[0]?.roleArn, ORCHESTRATOR);
  assert.equal(rec.scanAssumes[0]?.roleSessionName, RUN_ID, "the raw run id reaches the seam that sanitizes it");
});

test("the two sides produce different credentials", async () => {
  const { built } = factories();
  assert.notEqual(
    await built.customerClientFor("ap-south-1"),
    await built.scanClientFor("ap-south-1"),
    "a scan reading the customer session, or vice versa, would be the whole bug",
  );
});

/**
 * The orchestrator role MUST live in the configured scan account. A mismatch would
 * mean copying a customer's snapshot into an account nobody intended — the exact
 * outcome the no-defaults config rule exists to prevent.
 */
test("an orchestrator role outside the scan account is refused at construction", () => {
  assert.throws(
    () => factories({ orchestratorRoleArn: "arn:aws:iam::999988887777:role/sutra/Other" }),
    (error: unknown) =>
      error instanceof AgentlessClientFactoryError && error.code === "SCAN_ACCOUNT_MISMATCH",
  );
});

test("a malformed orchestrator ARN is refused before any snapshot exists", () => {
  assert.throws(() => factories({ orchestratorRoleArn: "SutraAgentlessOrchestrator" }));
});

test("an out-of-range session duration is refused", () => {
  for (const seconds of [60, 7200, 1800.5]) {
    assert.throws(
      () => factories({ sessionDurationSeconds: seconds }),
      (error: unknown) =>
        error instanceof AgentlessClientFactoryError && error.code === "SESSION_DURATION_INVALID",
      `${seconds}s must be refused`,
    );
  }
});

test("a malformed region is refused before either side is contacted", async () => {
  const { rec, built } = factories();
  await assert.rejects(
    () => built.customerClientFor("ap_south_1"),
    (error: unknown) => error instanceof AgentlessClientFactoryError && error.code === "REGION_INVALID",
  );
  await assert.rejects(() => built.scanClientFor("nowhere"));
  assert.equal(rec.brokerCalls.length + rec.scanAssumes.length, 0);
});

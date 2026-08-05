import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshingScanAccountCredentialProvider } from "../src/agentless-execution.js";

function temporary(sequence: number, expiration: number) {
  return {
    accessKeyId: `AKIA${String(sequence).padStart(16, "0")}`,
    secretAccessKey: `secret-${sequence}`,
    sessionToken: `token-${sequence}`,
    expiration: new Date(expiration),
  };
}

test("scan-account provider refreshes before expiry and coalesces replica-local callers", async () => {
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  let assumes = 0;
  const provider = createRefreshingScanAccountCredentialProvider({
    orchestratorRoleArn: "arn:aws:iam::111111111111:role/sutra/AgentlessOrchestrator",
    runId: "ags_11111111111111111111111111111111",
    region: "us-east-1",
    now: () => now,
    assume: async () => {
      assumes += 1;
      await Promise.resolve();
      return temporary(assumes, now + 60 * 60_000);
    },
  });

  const first = await Promise.all([provider(), provider(), provider()]);
  assert.equal(assumes, 1, "concurrent first use must make one STS call");
  assert.ok(first.every((entry) => entry.accessKeyId === first[0]?.accessKeyId));

  now += 54 * 60_000;
  assert.equal((await provider()).accessKeyId, first[0]?.accessKeyId);
  assert.equal(assumes, 1, "credentials outside the five-minute refresh window are reused");

  now += 2 * 60_000;
  const refreshed = await Promise.all([provider(), provider()]);
  assert.equal(assumes, 2, "crossing the refresh window assumes exactly once");
  assert.notEqual(refreshed[0]?.accessKeyId, first[0]?.accessKeyId);
});

test("scan-account provider rejects a session already too close to expiry", async () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const provider = createRefreshingScanAccountCredentialProvider({
    orchestratorRoleArn: "arn:aws:iam::111111111111:role/sutra/AgentlessOrchestrator",
    runId: "ags_22222222222222222222222222222222",
    region: "us-east-1",
    now: () => now,
    assume: async () => temporary(1, now + 4 * 60_000),
  });
  await assert.rejects(provider(), /SCAN_ROLE_SESSION_TOO_SHORT/u);
});

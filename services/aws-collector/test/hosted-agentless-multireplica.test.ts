import assert from "node:assert/strict";
import test from "node:test";

import { HostedPostgresState } from "../src/hosted-postgres-state.js";

interface RunRow {
  tenant_id: string;
  run_id: string;
  connection_id: string;
  phase: "running" | "recovering" | "completed" | "failed";
  request_json: string;
  request_sha256: string;
  execution_json: string | null;
  error_code: string | null;
  error_message: string | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
}

function sharedPool() {
  const runs = new Map<string, RunRow>();
  const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const query = async (text: string, params: readonly unknown[] = []) => {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return result();
    if (text.includes("FROM hosted_broker_agentless_runs") && text.includes("FOR UPDATE SKIP LOCKED")) {
      const now = Number(params[0]);
      const row = [...runs.values()].find((candidate) =>
        (candidate.phase === "running" || candidate.phase === "recovering") &&
        candidate.lease_expires_at !== null &&
        candidate.lease_expires_at <= now);
      return result(row === undefined ? [] : [{ ...row }]);
    }
    if (text.includes("FROM hosted_broker_agentless_runs") && text.includes("FOR UPDATE")) {
      const row = runs.get(`${String(params[0])}\u0000${String(params[1])}`);
      return result(row === undefined ? [] : [{ ...row }]);
    }
    if (text.includes("INSERT INTO hosted_broker_agentless_runs")) {
      const [tenant, runId, connection, requestJson, requestSha, token, owner, expires, now] = params;
      runs.set(`${String(tenant)}\u0000${String(runId)}`, {
        tenant_id: String(tenant),
        run_id: String(runId),
        connection_id: String(connection),
        phase: "running",
        request_json: String(requestJson),
        request_sha256: String(requestSha),
        execution_json: null,
        error_code: null,
        error_message: null,
        lease_token: String(token),
        lease_owner: String(owner),
        lease_expires_at: Number(expires),
        started_at: Number(now),
        finished_at: null,
        updated_at: Number(now),
      });
      return result([], 1);
    }
    if (text.includes("SET phase = 'recovering'")) {
      const [token, owner, expires, now, tenant, runId] = params;
      const row = runs.get(`${String(tenant)}\u0000${String(runId)}`);
      if (row === undefined) return result([], 0);
      Object.assign(row, {
        phase: "recovering",
        lease_token: String(token),
        lease_owner: String(owner),
        lease_expires_at: Number(expires),
        updated_at: Number(now),
      });
      return result([], 1);
    }
    if (text.includes("SET phase = 'completed'")) {
      const [executionJson, finished, tenant, runId, token, owner] = params;
      const row = runs.get(`${String(tenant)}\u0000${String(runId)}`);
      if (
        row === undefined || row.phase !== "running" ||
        row.lease_token !== token || row.lease_owner !== owner
      ) return result([], 0);
      Object.assign(row, {
        phase: "completed",
        execution_json: String(executionJson),
        lease_token: null,
        lease_owner: null,
        lease_expires_at: null,
        finished_at: Number(finished),
      });
      return result([], 1);
    }
    if (text.includes("SET phase = 'failed', execution_json")) {
      const [executionJson, finished, tenant, runId, token, owner] = params;
      const row = runs.get(`${String(tenant)}\u0000${String(runId)}`);
      if (
        row === undefined || row.phase !== "recovering" ||
        row.lease_token !== token || row.lease_owner !== owner
      ) return result([], 0);
      Object.assign(row, {
        phase: "failed",
        execution_json: String(executionJson),
        error_code: "BROKER_RESTART_RECOVERY",
        error_message: "restart recovered",
        lease_token: null,
        lease_owner: null,
        lease_expires_at: null,
        finished_at: Number(finished),
      });
      return result([], 1);
    }
    if (text.includes("FROM hosted_broker_agentless_resources")) return result();
    throw new Error(`unexpected fake SQL: ${text.replaceAll(/\s+/gu, " ").slice(0, 120)}`);
  };
  return {
    runs,
    pool: {
      query,
      connect: async () => ({ query, release() {} }),
      end: async () => undefined,
    },
  };
}

test("one replica claims, another recovers expiry, and stale owner cannot publish", async () => {
  let now = Date.parse("2026-07-30T00:00:00.000Z");
  const shared = sharedPool();
  const options = {
    connectionString: "postgresql://test.invalid/sutra",
    encryptionKey: Buffer.alloc(32, 7).toString("base64url"),
    now: () => now,
    pool: shared.pool as never,
  };
  const first = new HostedPostgresState({ ...options, owner: "broker-a" });
  const second = new HostedPostgresState({ ...options, owner: "broker-b" });
  const storeA = first.agentlessRunStore();
  const storeB = second.agentlessRunStore();
  const claim = {
    runId: `ags_${"1".repeat(32)}`,
    tenantId: "org_a",
    connectionId: `conn_${"a".repeat(32)}`,
    executionRequest: { tenantId: "org_a", plan: { volumes: [] } },
  };

  const started = await storeA.claim(claim);
  assert.equal(started.phase, "running");
  await assert.rejects(async () => storeB.claim(claim), /already executing/u);

  now += 46 * 60_000;
  const recovery = await second.claimExpiredAgentlessRun();
  assert.equal(recovery?.runId, claim.runId);
  assert.equal(recovery?.tenantId, claim.tenantId);

  await assert.rejects(
    async () => storeA.complete(claim.runId, { schema: "stale-owner-result" }),
    /state|integrity/iu,
    "the pre-restart replica must lose its publication lease",
  );
  assert.ok(recovery);
  await second.finishAgentlessRecovery(recovery, { schema: "recovered-failure" });

  const terminal = await storeB.claim(claim);
  assert.equal(terminal.phase, "failed", "a retried POST returns durable terminal truth");
  assert.equal(
    shared.runs.get(`${claim.tenantId}\u0000${claim.runId}`)?.error_code,
    "BROKER_RESTART_RECOVERY",
  );
});

test("same run id with changed scope or request digest is rejected across replicas", async () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const shared = sharedPool();
  const options = {
    connectionString: "postgresql://test.invalid/sutra",
    encryptionKey: Buffer.alloc(32, 8).toString("base64url"),
    now: () => now,
    pool: shared.pool as never,
  };
  const first = new HostedPostgresState({ ...options, owner: "broker-a" });
  const second = new HostedPostgresState({ ...options, owner: "broker-b" });
  const base = {
    runId: `ags_${"2".repeat(32)}`,
    tenantId: "org_a",
    connectionId: `conn_${"b".repeat(32)}`,
    executionRequest: { tenantId: "org_a", nonce: "one" },
  };
  await first.agentlessRunStore().claim(base);
  await assert.rejects(
    async () => second.agentlessRunStore().claim({
      ...base,
      executionRequest: { tenantId: "org_a", nonce: "two" },
    }),
    /integrity/iu,
  );
  await assert.rejects(
    async () => second.agentlessRunStore().claim({
      ...base,
      connectionId: `conn_${"c".repeat(32)}`,
    }),
    /integrity/iu,
  );
});
